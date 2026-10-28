// PDF译 后台引擎：挂在菜单栏小鱼下面的小面板。看不见的时候照样在翻（窗口设了 backgroundThrottling: disabled）。
// 流程：接任务（Zotero 链接 / “添加 PDF”）→ 逐页提取、合并、翻译 → 生成双栏 PDF → 存到原文件旁边或挂回 Zotero。
// 用到的核心模块：core/textutil.js、core/store.js、core/extract.js、core/translate.js、core/bilingual.js。
// 缓存和全量版是同一份：后台翻过的书，用全量版打开直接有译文。
(function(){
'use strict';
var T=window.__TAURI__||null;
pdfjsLib.GlobalWorkerOptions.workerSrc=VENDOR+'pdf.worker.min.js';
var CMAP=VENDOR+'cmaps/';
var $=function(id){return document.getElementById(id)};

// ══ 日志 ══
var LOG=[],logFilter='all',logSeenBad=0,logSeq=0,logOpen={};// logOpen：展开着的那几条（重画时保持展开）
function hhmmss(){var d=new Date(),z=function(n){return (n<10?'0':'')+n};return z(d.getHours())+':'+z(d.getMinutes())+':'+z(d.getSeconds())}
// 翻译和合并成功时，日志里只写一句摘要；模型返回的原文留着，点开那一条再看
function summarize(type,out,ok){var s=String(out||'');if(!ok)return s;
  if(type==='翻译'){var n=(s.match(/\[\d+\]/g)||[]).length,z=(s.match(/[\u4e00-\u9fff]/g)||[]).length;if(n||z)return '翻好 '+(n||1)+' 段，共 '+z+' 字'}
  if(type==='合并'){try{var a=s.indexOf('['),b=s.lastIndexOf(']'),g=JSON.parse(s.slice(a,b+1));if(Array.isArray(g))return '分成 '+g.length+' 段'}catch(e){}}
  return s}
window.addTransLog=function(page,input,output,model,type,ok){type=type||'翻译';ok=ok!==false;
  var full=String(output||''),msg=summarize(type,full,ok);
  LOG.unshift({id:++logSeq,t:hhmmss(),page:page,type:type,ok:ok,msg:msg.slice(0,300),full:msg!==full||full.length>300?full.slice(0,4000):''});
  if(LOG.length>200)LOG.length=200;renderLog()};
window.toast=function(msg,kind){if(kind==='err')addTransLog('-','',msg,'magpie','提示',false)};
window.setStatus=function(){};window.setProgress=function(){};
function log(msg,ok){addTransLog('-','',msg,'magpie','引擎',ok!==false)}
window.addEventListener('error',function(e){log('出错：'+(e.message||e),false)});
window.addEventListener('unhandledrejection',function(e){log('出错：'+((e.reason&&e.reason.message)||e.reason),false)});

// ══ 设置（和全量版共用的那几项） ══
function getConc(){var v=6;try{v=parseInt(localStorage.getItem('pdfyi_conc'))||6}catch(e){}return Math.max(6,Math.min(30,v))}
function lsGet(k,d){try{var v=localStorage.getItem(k);return v==null?d:v}catch(e){return d}}
function lsSet(k,v){try{localStorage.setItem(k,v)}catch(e){}}
var notifyOn=lsGet('pdfyi_notify','1')!=='0';
// 菜单栏上两行字各显示什么（v59）
var BAR_KINDS=[['pct','百分比（40%）'],['pages','页数（12/30）'],['eta','还要多久（约 6 分）'],['fails','失败的页（⚠1 页）'],['queue','排队的书（排队 2）'],['none','不显示']];
var bar={top:lsGet('pdfyi_bar_top','pct'),bottom:lsGet('pdfyi_bar_bottom','eta'),face:lsGet('pdfyi_bar_face','1')!=='0',sym:lsGet('pdfyi_bar_sym','1')!=='0',fail:lsGet('pdfyi_bar_fail','1')!=='0'};

// ══ 任务队列 ══
var queue=[],job=null,paused=false,lastOut=null;
var prog={pages:0,done:0,failPages:0,failParas:0,doneTimes:[],phase:'idle',doneUntil:0,title:'',from:''};
var pageState=[];// 每页：w 排队、t 正在翻、d 翻好、f 有失败、u 读不出字、e 没有正文
var recent=[];try{recent=JSON.parse(lsGet('pdfyi_recent','[]'))||[]}catch(e){recent=[]}
function enqueue(j){if(!j||!j.path){log('收到的任务没有文件路径',false);return}
  if(queue.some(function(x){return x.path===j.path})||(job&&job.path===j.path)){log('已经在队列里：'+baseOf(j.path));return}
  log('加入队列：'+baseOf(j.path)+(j.key?'（来自 Zotero）':''));queue.push(j);refresh();next()}
function next(){if(job||!queue.length)return;job=queue.shift();
  run(job).catch(function(e){addTransLog('-','',baseOf(job.path)+' 没翻成：'+(e&&e.message||e),'magpie','任务',false);notify('这一本没翻成',baseOf(job.path)+'：'+(e&&e.message||e))})
    .finally(function(){job=null;if(prog.phase!=='done')prog.phase='idle';refresh();Promise.resolve().then(next)})}// 不用计时器：看不见的窗口里计时器可能被冻结
function baseOf(p){return p.slice(p.lastIndexOf('/')+1).replace(/\.pdf$/i,'')}
function dirOf(p){var i=p.lastIndexOf('/');return i>=0?p.slice(0,i):'.'}

// ══ 一本书 ══
function resetBook(){pdfDoc=null;rawPdfBytes=null;totalPages=0;pageTextCache={};pageBboxCache={};memCache={};savedEnCache={};cachedAtLoad={};carryMark={};cleanRules=null;
  _rawCache={};_carryP={};_runningP=null;_runningEx={};_pageNotes={};highlights=[]}
async function run(j){
  resetBook();log('开始：'+baseOf(j.path));
  var name=j.path.slice(j.path.lastIndexOf('/')+1);
  var bytes=await T.fs.readFile(j.path);
  cacheKey='pdftrans:'+name+':'+bytes.length;
  rawPdfBytes=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  pdfDoc=await pdfjsLib.getDocument({data:new Uint8Array(rawPdfBytes.slice(0)),cMapUrl:CMAP,cMapPacked:true}).promise;
  totalPages=pdfDoc.numPages;
  prog={pages:totalPages,done:0,failPages:0,failParas:0,doneTimes:[],phase:'translating',doneUntil:0,title:baseOf(j.path),from:j.key?'来自 Zotero':'本地文件'};
  pageState=[];for(var i=0;i<=totalPages;i++)pageState.push('w');refresh();
  // 已有的缓存（全量版翻过的也算）
  for(var p=1;p<=totalPages;p++){var v=await idbGet('pages',cacheKey+':p'+p);
    if(v&&Array.isArray(v)&&v.length&&!v.some(function(t){return String(t).indexOf('__TRANSFAIL__')===0})){
      memCache[p]=v;cachedAtLoad[p]=1;
      var se=await idbGet('pages',cacheKey+':en'+p);if(se&&Array.isArray(se.texts)&&se.texts.length===v.length)savedEnCache[p]=se}}
  // 清理规则：用这本书确认过的；没有就自动识别（隐藏页眉页脚），并存下来，全量版打开时也按它来
  var saved=await idbGet('annotations',cacheKey+':clean');
  if(saved&&saved.running)cleanRules=saved;
  else{var au=await autoCleanRules(),v2=await validateCleanRules(null,au.running);
    cleanRules={running:v2.running,refs:null,skip:[],hide:true,from:'后台自动识别'};await idbSet('annotations',cacheKey+':clean',cleanRules)}
  // 术语表（全书译名统一）；最多等 90 秒，没提取成也照常翻
  try{await Promise.race([buildGlossary(),new Promise(function(r){setTimeout(r,90000)})]);if(_glossary.length)log('术语表 '+_glossary.length+' 条')}catch(e){}
  // 逐页：并发按设置，暂停时不再取新页
  var order=[];for(var q=1;q<=totalPages;q++)order.push(q);var pos=0,active=0;
  await new Promise(function(resolve){
    function pump(){
      if(pos>=order.length&&active===0){resolve();return}
      while(!paused&&active<getConc()&&pos<order.length){(function(pn){active++;pageState[pn]='t';
        onePage(pn).catch(function(e){addTransLog(pn,'',String(e&&e.message||e),'magpie','翻译',false);prog.failPages++;pageState[pn]='f'})
          .finally(function(){active--;prog.done++;prog.doneTimes.push(Date.now());if(prog.doneTimes.length>30)prog.doneTimes.shift();if(pageState[pn]==='t')pageState[pn]='d';refresh();pump()})})(order[pos++])}
      refresh();
      if(paused&&active===0)waitResume(pump)}
    pump()});
  // 生成并保存
  prog.phase='building';refresh();
  var pdf=await buildBilingualPdf();
  var out=await saveOut(j,pdf);lastOut=out.path;
  var p1T=(pageTextCache[1]||[]).join('\n');
  var mDoi=p1T.match(/\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
  var itemDoi=mDoi?mDoi[0].replace(/[.,;)]+$/,''):'';
  addRecent({title:baseOf(j.path),path:out.path,source:j.path,doi:itemDoi,p1Text:p1T,zotero:out.zotero,pages:totalPages,fails:prog.failParas,at:Date.now()});
  log('完成：'+baseOf(j.path)+(out.zotero?'，已挂回 Zotero':'，已存到原文件旁边'));
  prog.phase='done';prog.doneUntil=Date.now()+10000;refresh();setTimeout(refresh,10200);
  notify(out.zotero?'双栏 PDF 已经挂回 Zotero':'双栏 PDF 已存到原文件旁边',baseOf(j.path)+'_双栏，'+totalPages+' 页，'+prog.failParas+' 段失败')}
var resumeWaiters=[];function waitResume(fn){if(resumeWaiters.indexOf(fn)<0)resumeWaiters.push(fn)}
function resume(){var w=resumeWaiters;resumeWaiters=[];w.forEach(function(f){f()})}
async function onePage(p){
  var ck=cacheKey;
  if(memCache[p]){// 已有译文：沿用当时的原文分段
    var se=savedEnCache[p];
    if(se){pageTextCache[p]=se.texts.slice();var r0=await rawOf(p);pageBboxCache[p]=Object.assign({},r0,{texts:se.texts.slice(),bboxes:(se.bboxes&&se.bboxes.length===se.texts.length)?se.bboxes:r0.bboxes.slice()});carryMark[p]=se.carry||''}
    else{var r1=await rawOf(p);pageTextCache[p]=r1.texts.slice();pageBboxCache[p]=Object.assign({},r1,{texts:r1.texts.slice(),bboxes:r1.bboxes.slice()})}
    countFails(p,memCache[p]);return}
  var res=await rawOf(p);
  var q=pageTextQuality(res.rawLines);
  if(q){_pageNotes[p]=q.msg;pageState[p]='u';pageTextCache[p]=[];pageBboxCache[p]=Object.assign({},res,{texts:[],bboxes:[]});addTransLog(p,'',q.msg,'magpie','提取',false);return}
  var prep=await prepOf(p),g=groupRaw(prep.rawLines,prep.rawYs);
  pageTextCache[p]=g.texts.slice();
  pageBboxCache[p]=Object.assign({},res,{texts:g.texts.slice(),bboxes:g.bboxes.slice(),rawLines:prep.rawLines,rawYs:prep.rawYs});
  if(!g.texts.length){_pageNotes[p]='这一页只有页眉页脚或页码，没有正文。';pageState[p]='e';return}
  try{var m2=await aiMergeLines(prep.rawLines,getKey());if(cacheKey!==ck)return;
    if(m2&&m2.length){pageTextCache[p]=m2;pageBboxCache[p].texts=m2;pageBboxCache[p].bboxes=groupsToBboxes(m2._idx,prep.rawYs)}}
  catch(e){addTransLog(p,'','合并失败：'+(e.message||e),'magpie','合并',false)}
  var paras=pageTextCache[p];
  var tr=await translatePage(p,paras);if(!tr||cacheKey!==ck)return;
  memCache[p]=tr;countFails(p,tr);
  var bb=pageBboxCache[p].bboxes;
  var enRec={texts:paras.slice(),bboxes:(bb&&bb.length===paras.length)?bb:[],carry:carryMark[p]||'',cv:cleanRules&&cleanRules.hide?1:0};
  savedEnCache[p]=enRec;
  await idbSet('pages',ck+':p'+p,tr);await idbSet('pages',ck+':en'+p,enRec)}
function countFails(p,arr){var f=arr.filter(function(t){return String(t).indexOf('__TRANSFAIL__')===0}).length;if(f){prog.failPages++;prog.failParas+=f;pageState[p]='f'}}

// ══ 保存：Zotero 交来的照原附件方式挂回；其余存到原文件旁边 ══
async function saveOut(j,bytes){
  var out;
  if(j.key&&j.mode==='stored'){var base=(await T.path.appDataDir()).replace(/\/$/,'')+'/out';try{await T.fs.mkdir(base,{recursive:true})}catch(e){}out=base+'/'+baseOf(j.path)+'_双栏.pdf'}
  else out=dirOf(j.path)+'/'+baseOf(j.path)+'_双栏.pdf';
  await T.fs.writeFile(out,bytes);
  if(!j.key)return {path:out,zotero:false};
  var res=await T.core.invoke('zotero_attach',{body:{key:j.key,lib:j.lib,mode:j.mode,path:out,title:baseOf(j.path)+'_双栏'}});
  var r={};try{r=JSON.parse(res)}catch(e){}
  if(!r.ok)throw new Error('双栏 PDF 存好了（'+out+'），但没挂上 Zotero：'+(r.error||res));
  return {path:j.mode==='stored'?null:out,zotero:true}}
function notify(title,body){try{if(notifyOn&&T&&T.notification)T.notification.sendNotification({title:title,body:body})}catch(e){}}
function addRecent(r){recent=[r].concat(recent.filter(function(x){return x.path!==r.path||!r.path})).slice(0,8);lsSet('pdfyi_recent',JSON.stringify(recent))}

// ══ 菜单栏：小鱼的脸 + 状态符号 + 两行小字（按设置画） ══
var _imgP={};
function img(name){if(!_imgP[name])_imgP[name]=new Promise(function(res){var im=new Image();im.onload=function(){res(im)};im.onerror=function(){res(null)};im.src=VENDOR+'tray/'+name+'.png'});return _imgP[name]}
var TRAY_FONT='-apple-system,"SF Pro Text","Helvetica Neue","PingFang SC",sans-serif';
var SYM={sleeping:'zz',thinking:'bubble',normal:'pause',inspired:'bulb'};
// 画成一张模板图（黑色加透明，macOS 按菜单栏深浅自动着色）
async function trayCanvas(mood,lines,opt){
  var H=44,gap=5,fim=opt.face?await img('face-'+mood):null,sim=opt.sym&&SYM[mood]?await img('sym-'+SYM[mood]):null;
  var fw=fim?Math.round(fim.width*H/fim.height):0,SH=34,sw=sim?Math.round(sim.width*SH/sim.height):0;
  var c=document.createElement('canvas'),x=c.getContext('2d');
  var two=lines.length>=2,fs=two?19:26,font='600 '+fs+'px '+TRAY_FONT;x.font=font;
  var tw=lines.length?Math.ceil(Math.max.apply(null,lines.map(function(l){return x.measureText(l).width}))):0;
  if(!fim&&!sim&&!tw){fim=await img('face-'+mood);fw=fim?Math.round(fim.width*H/fim.height):0}// 什么都不显示时，至少留一张脸
  c.width=Math.max(1,fw+(sw?(fw?gap:0)+sw:0)+(tw?((fw||sw)?gap+2:0)+tw:0));c.height=H;x=c.getContext('2d');
  var cur=0;
  if(fim){x.drawImage(fim,0,0,fw,H);cur=fw}
  if(sim){var sx=cur+(cur?gap:0);x.drawImage(sim,sx,Math.round((H-SH)/2),sw,SH);cur=sx+sw}
  x.fillStyle='#000';x.font=font;x.textBaseline='alphabetic';var tx=cur+(cur?gap+2:0);
  if(two){x.fillText(lines[0],tx,19);x.fillText(lines[1],tx,41)}else if(lines.length===1)x.fillText(lines[0],tx,32);
  return c}
async function canvasBytes(c){var blob=await new Promise(function(r){c.toBlob(r,'image/png')});return blob?Array.from(new Uint8Array(await blob.arrayBuffer())):null}
function etaText(p){p=p||prog;var left=p.pages-p.done,ts=p.doneTimes;if(left<=0||ts.length<3)return '';var mins=(ts[ts.length-1]-ts[0])/60000,rate=(ts.length-1)/Math.max(mins,0.05),m=Math.round(left/rate);return m<1?'不到 1 分':'约 '+m+' 分'}
// 按设置算一行字
function lineOf(kind,p,qn,eta){
  switch(kind){
    case 'pct':return p.pages?Math.floor(p.done/p.pages*100)+'%':'';
    case 'pages':return p.done+'/'+p.pages;
    case 'eta':return eta||(p.done+'/'+p.pages);
    case 'fails':return p.failPages?'⚠'+p.failPages+' 页':'无失败';
    case 'queue':return qn?'排队 '+qn:'无排队';
    default:return null}}
function barLines(p,qn,isPaused,eta){
  var a=lineOf(bar.top,p,qn,eta),b=lineOf(bar.bottom,p,qn,eta);
  if(bar.fail&&p.failPages&&bar.top!=='fails'&&bar.bottom!=='fails')b='⚠'+p.failPages+' 页';
  if(isPaused){b=a;a='暂停'}
  return [a,b].filter(function(x){return x})}
function trayState(){
  var busy=prog.phase==='translating',mood='sleeping',lines=[],title='',line='',eta=etaText();
  if(prog.phase==='building'){mood='inspired';lines=['生成','PDF'];title='生成中';line='正在生成双栏 PDF'}
  else if(busy){mood=paused?'normal':'thinking';lines=barLines(prog,queue.length,paused,eta);
    title=(paused?'暂停 ':'')+prog.done+'/'+prog.pages;line=(paused?'已暂停，':'正在翻，')+prog.done+'/'+prog.pages+' 页'+(eta&&!paused?'，'+eta:'')}
  else if(Date.now()<prog.doneUntil){mood='inspired';lines=['完成','✓'];title='完成';line='翻好了，'+prog.pages+' 页'}
  else if(queue.length)lines=['排队 '+queue.length];
  return {mood:mood,title:title,lines:lines,book:busy||prog.phase==='building'?(prog.title||''):'',line:line,
    fail_line:prog.failPages?'⚠ '+prog.failPages+' 页有失败段落，打开阅读器查看':'',
    queue:queue.map(function(x){return baseOf(x.path)+(x.key?'（Zotero）':'')}),paused:paused,busy:busy,has_last:!!lastOut,notify:notifyOn}}
var trayBusy=false,trayAgain=false,lastTrayJson='';
// 有变化就推，不用计时器节流（一页翻完才变一次）；正在推的时候又变了，推完再补一次
async function pushTray(){
  if(!T)return;if(trayBusy){trayAgain=true;return}trayBusy=true;
  try{do{trayAgain=false;var st=trayState(),j=JSON.stringify(st)+JSON.stringify(bar);if(j===lastTrayJson)continue;lastTrayJson=j;
      try{st.image=await canvasBytes(await trayCanvas(st.mood,st.lines,bar))}catch(e){st.image=null}
      await T.core.invoke('tray_update',{state:st}).catch(function(){})}while(trayAgain)}
  finally{trayBusy=false}}
function refresh(){renderNow();pushTray()}

// ══ 面板：现在 ══
function esc(t){return String(t==null?'':t).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function moodNow(){return prog.phase==='building'||Date.now()<prog.doneUntil?'inspired':(prog.phase==='translating'?(paused?'normal':'thinking'):'sleeping')}
function ago(t){var s=Math.round((Date.now()-t)/1000);if(s<60)return '刚刚';var m=Math.round(s/60);if(m<60)return m+' 分钟前';var h=Math.round(m/60);if(h<24)return h+' 小时前';return Math.round(h/24)+' 天前'}
function renderNow(){
  if(!$('job'))return;
  var mood=moodNow(),busy=prog.phase==='translating',eta=etaText();
  $('face').style.setProperty('--img','url('+VENDOR+'tray/face-'+mood+'.png)');
  $('say').textContent=prog.phase==='building'?'在把译文排进双栏 PDF。':busy?(paused?'先停下了，点“继续”接着翻。':'在翻《'+prog.title+'》'+(eta?'，'+eta+'翻完。':'。')):(Date.now()<prog.doneUntil?'翻好了：'+prog.title+'。':(queue.length?'马上开始下一本。':'在睡觉，没有要翻的书。'));
  var bp=$('btn-pause');bp.disabled=!busy;bp.textContent=paused?'继续':'暂停';
  var h='';
  if(busy||prog.phase==='building'){
    var n=prog.pages,group=Math.max(1,Math.ceil(n/240)),cells=Math.ceil(n/group);
    var per=Math.max(1,Math.min(cells,Math.ceil(cells/Math.max(1,Math.ceil(cells/24))))),ts=Math.max(5,Math.min(13,Math.floor((316+3)/per)-3));
    var tiles='';for(var c=0;c<cells;c++){var st='d',seen={};for(var k=c*group+1;k<=Math.min(n,(c+1)*group);k++)seen[pageState[k]]=1;
      st=seen.f?'f':seen.t?'t':seen.w?'w':seen.u?'u':seen.e?'e':'d';tiles+='<i class="tile '+st+'" title="第 '+(c*group+1)+(group>1?'–'+Math.min(n,(c+1)*group):'')+' 页"></i>'}
    h='<div class="book"><div class="book-title">'+esc(prog.title)+'</div><div class="book-from">'+esc(prog.from)+'，并发 '+getConc()+'</div>'
      +'<div class="tiles" style="--ts:'+ts+'px">'+tiles+'</div>'
      +'<div class="stats"><span class="big">'+prog.done+'<small>/ '+n+' 页</small></span>'
      +(prog.phase==='building'?'<span class="chip">正在生成双栏 PDF</span>':(eta&&!paused?'<span class="chip">'+eta+'</span>':''))
      +(prog.failPages?'<span class="chip bad">'+prog.failPages+' 页有失败段落</span>':'')+'</div></div>';
  }else{
    h='<div class="idle"><div class="face" style="--img:url('+VENDOR+'tray/face-'+mood+'.png)"></div><p>'
      +(Date.now()<prog.doneUntil?'《'+esc(prog.title)+'》翻好了。':'把 PDF 交给我，翻完放回原处。')+'</p></div>'}
  $('job').innerHTML=h;
  $('queue').innerHTML=queue.length?queue.map(function(x){return '<li><div class="li-main"><div class="li-t">'+esc(baseOf(x.path))+'</div><div class="li-s">'+(x.key?'来自 Zotero':'本地文件')+'</div></div></li>'}).join(''):'<li class="empty">没有排队的书。</li>';
  $('recent').innerHTML=recent.length?recent.map(function(r,i){return '<li><div class="li-main"><div class="li-t">'+esc(r.title)+'</div><div class="li-s">'+ago(r.at)+'，'+r.pages+' 页'+(r.fails?'，'+r.fails+' 段失败':'')+(r.zotero?'，已在 Zotero':'')+'</div></div>'
    +(r.path?'<button class="lnk" data-open="'+i+'">打开</button><button class="lnk" data-reveal="'+i+'">在访达中显示</button>':'')
    +(r.zotero?'<span class="li-s">已在 Zotero</span>':(r.path&&r.source?'<button class="lnk" data-zotero="'+i+'"'+(r.importing?' disabled':'')+'>'+(r.importing?'加入中…':'加入 Zotero')+'</button>':''))+'</li>'}).join(''):'<li class="empty">还没有翻好的书。</li>'}

// ══ 面板：日志 ══
var TYPE_DOT={'引擎':'var(--lav)','翻译':'var(--tL)','合并':'var(--tS)','术语表':'var(--tP)','提取':'var(--faint)','任务':'var(--warn)','提示':'var(--warn)','清理规则':'var(--tJ)','结构扫描':'var(--tJ)'};
function renderLog(){
  if(!$('log'))return;
  var bad=LOG.filter(function(e){return !e.ok}).length,b=$('log-bad');
  var unseen=bad-logSeenBad;if(!$('tab-log').hidden)logSeenBad=bad,unseen=0;
  b.hidden=unseen<=0;b.textContent=unseen;
  var rows=LOG.filter(function(e){return logFilter==='all'||(logFilter==='bad'&&!e.ok)||(logFilter==='engine'&&e.type==='引擎')});
  $('log').innerHTML=rows.length?rows.slice(0,120).map(function(e){
    var pg=(e.page!=null&&e.page!=='-'&&e.page!=='?')?'<span>第 '+esc(e.page)+' 页</span>':'';
    return '<li data-id="'+e.id+'" class="'+(e.ok?'':'bad')+(e.full?' more':'')+(logOpen[e.id]?' open':'')+'" style="--dot:'+(TYPE_DOT[e.type]||'var(--lav)')+'"><div class="lg-h"><time>'+e.t+'</time><span class="tag">'+esc(e.type)+'</span>'+pg+'</div><div class="lg-m">'+esc(e.msg)+'</div>'+(e.full?'<div class="lg-full">'+esc(e.full)+'</div>':'')+'</li>'}).join('')
    :'<li class="empty" style="list-style:none">'+(logFilter==='bad'?'没有出错的记录。':'还没有记录。')+'</li>'}
function logText(){return LOG.slice().reverse().map(function(e){return e.t+' ['+e.type+(e.ok?'':'·出错')+']'+((e.page!=null&&e.page!=='-'&&e.page!=='?')?' 第'+e.page+'页':'')+' '+e.msg}).join('\n')}

// ══ 面板：菜单栏设置 ══
async function renderPreview(){
  var demo={pages:30,done:18,failPages:1},lines=barLines(demo,0,false,'约 6 分'),c=await trayCanvas('thinking',lines,bar);
  ['pv-light','pv-dark'].forEach(function(id){var cv=$(id);if(!cv)return;cv.width=c.width;cv.height=44;cv.style.width=(c.width/2)+'px';var x=cv.getContext('2d');x.clearRect(0,0,cv.width,44);
    x.drawImage(c,0,0);x.globalCompositeOperation='source-in';x.fillStyle=id==='pv-dark'?'#ffffff':'#1d1d1f';x.fillRect(0,0,cv.width,44);x.globalCompositeOperation='source-over'})}
function initBarSettings(){
  ['set-top','set-bottom'].forEach(function(id){var s=$(id);s.innerHTML=BAR_KINDS.map(function(k){return '<option value="'+k[0]+'">'+k[1]+'</option>'}).join('')});
  $('set-top').value=bar.top;$('set-bottom').value=bar.bottom;$('set-face').checked=bar.face;$('set-sym').checked=bar.sym;$('set-fail').checked=bar.fail;
  var save=function(){bar.top=$('set-top').value;bar.bottom=$('set-bottom').value;bar.face=$('set-face').checked;bar.sym=$('set-sym').checked;bar.fail=$('set-fail').checked;
    lsSet('pdfyi_bar_top',bar.top);lsSet('pdfyi_bar_bottom',bar.bottom);lsSet('pdfyi_bar_face',bar.face?'1':'0');lsSet('pdfyi_bar_sym',bar.sym?'1':'0');lsSet('pdfyi_bar_fail',bar.fail?'1':'0');
    renderPreview();pushTray()};
  ['set-top','set-bottom','set-face','set-sym','set-fail'].forEach(function(id){$(id).onchange=save});
  renderPreview()}

// ══ 面板：交互 ══
function showTab(name){document.querySelectorAll('.tabs button').forEach(function(b){b.classList.toggle('on',b.dataset.tab===name)});
  ['now','log','bar'].forEach(function(t){$('tab-'+t).hidden=t!==name});if(name==='log')renderLog();if(name==='bar')renderPreview()}
function togglePause(){if(prog.phase!=='translating')return;paused=!paused;log(paused?'暂停（路上的请求翻完就停）':'继续');if(!paused)resume();refresh()}
function bindUI(){
  document.querySelectorAll('.tabs button').forEach(function(b){b.onclick=function(){showTab(b.dataset.tab)}});
  $('btn-pause').onclick=togglePause;
  $('btn-add').onclick=function(){if(T)T.core.invoke('bg_pick').catch(function(e){log('打不开选文件的窗口：'+e,false)})};
  $('btn-reader').onclick=function(){if(T)T.core.invoke('show_main').catch(function(){})};
  $('recent').onclick=function(e){var o=e.target.dataset.open,r=e.target.dataset.reveal,z=e.target.dataset.zotero,i=o!=null?o:r;if(z!=null){importRecent(+z);return}if(i==null||!T)return;var it=recent[+i];if(!it||!it.path)return;
    T.core.invoke(o!=null?'open_path':'reveal_path',{path:it.path}).catch(function(err){log('打不开：'+err,false)})};
async function importRecent(i){
  var r=recent[i];if(!T||!r||r.zotero||r.importing||!r.path||!r.source)return;
  r.importing=true;renderNow();log('正在加入 Zotero：'+r.title);
  try{
    var doi=r.doi||'';
    if(!doi&&r.p1Text){
      var mD=r.p1Text.match(/\b10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/);
      if(mD)doi=mD[0].replace(/[.,;)]+$/,'');
    }
    var csl=null;
    if(!doi&&r.p1Text&&activeModel){
      try{
        var prompt='Extract bibliographic metadata from this first page of an academic document as CSL-JSON.\n'
          +'Return ONLY a valid JSON object matching CSL-JSON format (type, title, author: [{given, family}], container-title, issued: {date-parts: [[year]]}). No markdown, no explanation.\n\n'
          +r.p1Text.slice(0,3000);
        var body={model:getMagpieModel(),messages:[{role:'user',content:prompt}],temperature:0};
        var resp=await fetch(getMagpieUrl(),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+getKey()},body:JSON.stringify(body)});
        if(resp.ok){
          var data=await resp.json(),raw=getMsgContent(data),clean=raw.replace(/```[a-z]*\n?/g,'').trim();
          var j0=clean.indexOf('{'),j1=clean.lastIndexOf('}');
          if(j0>=0&&j1>j0)csl=JSON.parse(clean.slice(j0,j1+1));
        }
      }catch(e){console.warn('CSL extraction failed:',e)}
    }
    var raw=await T.core.invoke('zotero_import',{body:{source_path:r.source,output_path:r.path,title:r.title,doi:doi,csl:csl}}),ans={};try{ans=JSON.parse(raw)}catch(e){}
    if(!ans.ok)throw new Error(ans.error||raw||'Zotero 没有确认导入');
    r.zotero=true;r.importing=false;lsSet('pdfyi_recent',JSON.stringify(recent));log('已加入 Zotero：'+(ans.title||r.title));refresh()}
  catch(e){r.importing=false;log('加入 Zotero 失败：'+(e.message||e),false);refresh()}}
  document.querySelectorAll('#log-filter button').forEach(function(b){b.onclick=function(){logFilter=b.dataset.f;document.querySelectorAll('#log-filter button').forEach(function(x){x.classList.toggle('on',x===b)});renderLog()}});
  $('log-copy').onclick=function(){var t=logText();(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){$('log-copy').textContent='已复制'},function(){$('log-copy').textContent='复制失败'})};
  $('log-clear').onclick=function(){LOG=[];logSeenBad=0;logOpen={};renderLog()};
  $('log').onclick=function(e){var li=e.target.closest('li.more');if(!li||e.target.closest('.lg-full'))return;var id=li.dataset.id;if(logOpen[id])delete logOpen[id];else logOpen[id]=1;li.classList.toggle('open',!!logOpen[id])};
  initBarSettings();renderNow();renderLog()}
bindUI();

// ══ 接任务：都由 Rust 接收后放进待办列表，这里去取（本地文件是“file:路径”） ══
function onDeepLink(u){try{var url=new URL(u);if(url.protocol!=='pdfyi:'){log('不认识的链接：'+u,false);return}var q=url.searchParams;
  enqueue({path:q.get('path'),key:q.get('key'),lib:parseInt(q.get('lib'))||1,mode:q.get('mode')==='linked'?'linked':'stored'})}catch(e){log('链接解析失败：'+u+'：'+e,false)}}
async function drain(why){try{var js=await T.core.invoke('take_jobs');if(js&&js.length)log('取到 '+js.length+' 个任务（'+why+'）');
  (js||[]).forEach(function(x){if(String(x).indexOf('file:')===0)enqueue({path:String(x).slice(5)});else onDeepLink(String(x))})}catch(e){log('取任务失败：'+e,false)}}
if(T){
  log('后台引擎启动：读文件 '+(!!(T.fs&&T.fs.readFile))+'，写文件 '+(!!(T.fs&&T.fs.writeFile))+'，事件 '+(!!T.event)+'，通知 '+(!!T.notification));
  T.event.listen('pdfyi-job',function(){drain('收到通知')}).catch(function(e){log('监听任务通知失败：'+e,false)});
  T.event.listen('popover-shown',function(){renderNow();renderLog()}).catch(function(){});
  drain('启动时');
  T.event.listen('tray-action',function(ev){var id=String(ev.payload||'');
    if(id==='pause')togglePause();
    else if(id==='progress')T.core.invoke('show_main').catch(function(){});
    else if(id==='open_last'&&lastOut)T.core.invoke('open_path',{path:lastOut}).catch(function(){});
    else if(id==='reveal'&&lastOut)T.core.invoke('reveal_path',{path:lastOut}).catch(function(){});
    else if(id==='notify'){notifyOn=!notifyOn;lsSet('pdfyi_notify',notifyOn?'1':'0');pushTray()}});
  try{if(T.notification)T.notification.isPermissionGranted().then(function(g){if(!g)T.notification.requestPermission()}).catch(function(){})}catch(e){}
  pushTray();
}
// 给测试和调试用
window.PDFYI_WORKER={enqueue:enqueue,state:function(){return {job:job,queue:queue.slice(),prog:prog,paused:paused,lastOut:lastOut,pageState:pageState.slice(),log:LOG.slice(0,40),bar:bar,recent:recent}}};
})();
