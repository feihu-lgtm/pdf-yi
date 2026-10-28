// PDF译 后台引擎：在一个看不见的窗口里跑，不画页面、不生成阅读界面。
// 流程：接任务（Zotero 链接 / 菜单栏“后台翻译文件…”）→ 逐页提取、合并、翻译 → 生成双栏 PDF → 存到原文件旁边或挂回 Zotero。
// 用到的核心模块：core/textutil.js、core/store.js、core/extract.js、core/translate.js、core/bilingual.js。
// 缓存和全量版是同一份：后台翻过的书，用全量版打开直接有译文。
(function(){
'use strict';
var T=window.__TAURI__||null;
pdfjsLib.GlobalWorkerOptions.workerSrc=VENDOR+'pdf.worker.min.js';
var CMAP=VENDOR+'cmaps/';

// ── 核心模块里用到的几个界面函数：后台没有界面，换成记日志 ──
var LOG=[];
window.addTransLog=function(page,input,output,model,type,ok){LOG.unshift({t:new Date().toLocaleTimeString(),page:page,type:type||'翻译',ok:ok!==false,msg:String(output||'').slice(0,300)});if(LOG.length>80)LOG.length=80;if(typeof renderStatus==='function')renderStatus()};
window.toast=function(msg,kind){if(kind==='err')addTransLog('?','',msg,'magpie','提示',false)};
window.setStatus=function(){};window.setProgress=function(){};

// ── 设置（和全量版共用） ──
function getConc(){var v=6;try{v=parseInt(localStorage.getItem('pdfyi_conc'))||6}catch(e){}return Math.max(6,Math.min(30,v))}
var notifyOn=true;try{notifyOn=localStorage.getItem('pdfyi_notify')!=='0'}catch(e){}

// ── 任务队列 ──
var queue=[],job=null,paused=false,lastOut=null;
var prog={pages:0,done:0,failPages:0,failParas:0,doneTimes:[],phase:'idle',doneUntil:0};
function enqueue(j){if(!j||!j.path)return;if(queue.some(function(x){return x.path===j.path})||(job&&job.path===j.path))return;queue.push(j);tray();next()}
function next(){if(job||!queue.length)return;job=queue.shift();run(job).catch(function(e){addTransLog('?','',String(e&&e.message||e),'magpie','任务',false);notify('这一本没翻成',baseOf(job.path)+'：'+(e&&e.message||e))}).finally(function(){job=null;prog.phase='idle';tray();Promise.resolve().then(next)})}// 不用计时器：看不见的窗口里计时器可能被冻结
function baseOf(p){return p.slice(p.lastIndexOf('/')+1).replace(/\.pdf$/i,'')}
function dirOf(p){var i=p.lastIndexOf('/');return i>=0?p.slice(0,i):'.'}

// ── 一本书 ──
function resetBook(){pdfDoc=null;rawPdfBytes=null;totalPages=0;pageTextCache={};pageBboxCache={};memCache={};savedEnCache={};cachedAtLoad={};carryMark={};cleanRules=null;
  _rawCache={};_carryP={};_runningP=null;_runningEx={};_pageNotes={};highlights=[]}
async function run(j){
  resetBook();
  var name=j.path.slice(j.path.lastIndexOf('/')+1);
  var bytes=await T.fs.readFile(j.path);
  cacheKey='pdftrans:'+name+':'+bytes.length;
  rawPdfBytes=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  pdfDoc=await pdfjsLib.getDocument({data:new Uint8Array(rawPdfBytes.slice(0)),cMapUrl:CMAP,cMapPacked:true}).promise;
  totalPages=pdfDoc.numPages;
  prog={pages:totalPages,done:0,failPages:0,failParas:0,doneTimes:[],phase:'translating',doneUntil:0,title:baseOf(j.path)};tray();
  // 已有的缓存（全量版翻过的也算）
  for(var p=1;p<=totalPages;p++){var v=await idbGet('pages',cacheKey+':p'+p);if(v&&Array.isArray(v)&&v.length){memCache[p]=v;cachedAtLoad[p]=1;
    var se=await idbGet('pages',cacheKey+':en'+p);if(se&&Array.isArray(se.texts)&&se.texts.length===v.length)savedEnCache[p]=se}}
  // 清理规则：用这本书确认过的；没有就自动识别（隐藏页眉页脚），并存下来，全量版打开时也按它来
  var saved=await idbGet('annotations',cacheKey+':clean');
  if(saved&&saved.running)cleanRules=saved;
  else{var au=await autoCleanRules(),v2=await validateCleanRules(null,au.running);
    cleanRules={running:v2.running,refs:null,skip:[],hide:true,from:'后台自动识别'};await idbSet('annotations',cacheKey+':clean',cleanRules)}
  // 逐页：并发按设置，暂停时不再取新页
  var order=[];for(var q=1;q<=totalPages;q++)order.push(q);var pos=0,active=0;
  await new Promise(function(resolve){
    function pump(){
      if(pos>=order.length&&active===0){resolve();return}
      while(!paused&&active<getConc()&&pos<order.length){var pn=order[pos++];active++;
        onePage(pn).catch(function(e){addTransLog(pn,'',String(e&&e.message||e),'magpie','翻译',false);prog.failPages++}).finally(function(){active--;prog.done++;prog.doneTimes.push(Date.now());if(prog.doneTimes.length>30)prog.doneTimes.shift();tray();pump()})}
      if(paused&&active===0)waitResume(pump)}
    pump()});
  // 生成并保存
  prog.phase='building';tray();
  var pdf=await buildBilingualPdf();
  var out=await saveOut(j,pdf);lastOut=out.path;
  prog.phase='done';prog.doneUntil=Date.now()+10000;tray();setTimeout(tray,10200);
  notify(out.zotero?'双栏 PDF 已经挂回 Zotero':'双栏 PDF 已存到原文件旁边',baseOf(j.path)+'_双栏 · '+totalPages+' 页 · '+prog.failParas+' 段失败')}
var resumeWaiters=[];function waitResume(fn){if(resumeWaiters.indexOf(fn)<0)resumeWaiters.push(fn)}
function resume(){var w=resumeWaiters;resumeWaiters=[];w.forEach(function(f){f()})}

async function onePage(p){
  var ck=cacheKey;
  if(memCache[p]){// 已有译文：沿用当时的原文分段
    var se=savedEnCache[p];
    if(se){pageTextCache[p]=se.texts.slice();var r0=await rawOf(p);pageBboxCache[p]=Object.assign({},r0,{texts:se.texts.slice(),bboxes:(se.bboxes&&se.bboxes.length===se.texts.length)?se.bboxes:r0.bboxes.slice()});carryMark[p]=se.carry||''}
    else{var r1=await rawOf(p);pageTextCache[p]=r1.texts.slice();pageBboxCache[p]=Object.assign({},r1,{texts:r1.texts.slice(),bboxes:r1.bboxes.slice()})}
    countFails(memCache[p]);return}
  var res=await rawOf(p);
  var q=pageTextQuality(res.rawLines);
  if(q){_pageNotes[p]=q.msg;pageTextCache[p]=[];pageBboxCache[p]=Object.assign({},res,{texts:[],bboxes:[]});return}
  var prep=await prepOf(p),g=groupRaw(prep.rawLines,prep.rawYs);
  pageTextCache[p]=g.texts.slice();
  pageBboxCache[p]=Object.assign({},res,{texts:g.texts.slice(),bboxes:g.bboxes.slice(),rawLines:prep.rawLines,rawYs:prep.rawYs});
  if(!g.texts.length){_pageNotes[p]='这一页只有页眉页脚或页码，没有正文。';return}
  try{var m2=await aiMergeLines(prep.rawLines,getKey());if(cacheKey!==ck)return;
    if(m2&&m2.length){pageTextCache[p]=m2;pageBboxCache[p].texts=m2;pageBboxCache[p].bboxes=groupsToBboxes(m2._idx,prep.rawYs)}}
  catch(e){addTransLog(p,'','合并失败: '+(e.message||e),'magpie','合并',false)}
  var paras=pageTextCache[p];
  var tr=await translatePage(p,paras);if(!tr||cacheKey!==ck)return;
  memCache[p]=tr;countFails(tr);
  var bb=pageBboxCache[p].bboxes;
  var enRec={texts:paras.slice(),bboxes:(bb&&bb.length===paras.length)?bb:[],carry:carryMark[p]||'',cv:cleanRules&&cleanRules.hide?1:0};
  savedEnCache[p]=enRec;
  await idbSet('pages',ck+':p'+p,tr);await idbSet('pages',ck+':en'+p,enRec)}
function countFails(arr){var f=arr.filter(function(t){return String(t).indexOf('__TRANSFAIL__')===0}).length;if(f){prog.failPages++;prog.failParas+=f}}

// ── 保存：Zotero 交来的照原附件方式挂回；其余存到原文件旁边 ──
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
function notify(title,body){try{if(notifyOn&&T.notification)T.notification.sendNotification({title:title,body:body})}catch(e){}}

// ── 菜单栏：小鱼的脸 + 状态符号 + 两行小字（和全量版同一套画法） ──
var _trayImgP={};
function _trayImg(name){if(!_trayImgP[name])_trayImgP[name]=new Promise(function(res){var im=new Image();im.onload=function(){res(im)};im.onerror=function(){res(null)};im.src=(VENDOR||'vendor/')+'tray/'+name+'.png'});return _trayImgP[name]}
var TRAY_FONT='-apple-system,"SF Pro Text","Helvetica Neue","PingFang SC",sans-serif';
var TRAY_SYM={sleeping:'zz',thinking:'bubble',normal:'pause',inspired:'bulb'};
async function trayCanvas(face,sym,lines){
  var H=44,gap=5,fim=await _trayImg('face-'+face),sim=sym?await _trayImg('sym-'+sym):null;
  var fw=fim?Math.round(fim.width*H/fim.height):0,SH=34,sw=sim?Math.round(sim.width*SH/sim.height):0;
  var c=document.createElement('canvas'),x=c.getContext('2d');
  var two=lines.length>=2,fs=two?19:26,font='600 '+fs+'px '+TRAY_FONT;x.font=font;
  var tw=lines.length?Math.ceil(Math.max.apply(null,lines.map(function(l){return x.measureText(l).width}))):0;
  c.width=Math.max(1,fw+(sw?gap+sw:0)+(tw?gap+2+tw:0));c.height=H;x=c.getContext('2d');
  var cur=0;
  if(fim){x.drawImage(fim,0,0,fw,H);cur=fw}
  if(sim){x.drawImage(sim,cur+gap,Math.round((H-SH)/2),sw,SH);cur+=gap+sw}
  x.fillStyle='#000';x.font=font;x.textBaseline='alphabetic';var tx=cur+gap+2;
  if(two){x.fillText(lines[0],tx,19);x.fillText(lines[1],tx,41)}
  else if(lines.length===1)x.fillText(lines[0],tx,32);
  return c}
async function trayImageBytes(mood,lines){
  var c=await trayCanvas(mood,TRAY_SYM[mood]||null,lines);
  var blob=await new Promise(function(r){c.toBlob(r,'image/png')});
  return blob?Array.from(new Uint8Array(await blob.arrayBuffer())):null}
var trayBusy=false,trayAgain=false,lastTrayJson='';
function etaText(){var left=prog.pages-prog.done,ts=prog.doneTimes;if(left<=0||ts.length<3)return '';var mins=(ts[ts.length-1]-ts[0])/60000,rate=(ts.length-1)/Math.max(mins,0.05),m=Math.round(left/rate);return m<1?'<1 分':'约 '+m+' 分'}
function trayState(){
  var busy=prog.phase==='translating',pct=prog.pages?Math.floor(prog.done/prog.pages*100)+'%':'',qn=queue.length?' +'+queue.length:'';
  var mood='sleeping',lines=[],title='',line='';
  if(prog.phase==='building'){mood='inspired';lines=['生成','PDF'];title='生成中';line='正在生成双栏 PDF'}
  else if(busy){mood=paused?'normal':'thinking';lines=paused?['暂停'+qn,pct]:[pct+qn,prog.failPages?'⚠'+prog.failPages+' 页':(etaText()||(prog.done+'/'+prog.pages))];
    title=(paused?'暂停 ':'')+prog.done+'/'+prog.pages;line=(paused?'已暂停 ':'翻译中 ')+prog.done+'/'+prog.pages+' 页'+(etaText()&&!paused?' · '+etaText():'')}
  else if(Date.now()<prog.doneUntil){mood='inspired';lines=['完成','✓'];title='完成';line='已完成 '+prog.pages+' 页'+(prog.failParas?' · '+prog.failParas+' 段失败':'')}
  else if(queue.length)lines=['排队'+qn.trim()];
  return {mood:mood,title:title,lines:lines,book:busy||prog.phase==='building'?(prog.title||''):'',line:line,
    fail_line:prog.failPages?'⚠ '+prog.failPages+' 页有失败段落 — 打开阅读器查看':'',
    queue:queue.map(function(x){return baseOf(x.path)+(x.key?' · 来自 Zotero':'')}),paused:paused,busy:busy,has_last:!!lastOut,notify:notifyOn}}
// v54：有变化就推，不用计时器节流（一页翻完才变一次，本来就不密）；正在推的时候又变了，推完再补一次
async function tray(){
  renderStatus();
  if(!T)return;if(trayBusy){trayAgain=true;return}trayBusy=true;
  try{do{trayAgain=false;var st=trayState(),j=JSON.stringify(st);if(j===lastTrayJson)continue;lastTrayJson=j;
      try{st.image=await trayImageBytes(st.mood,st.lines)}catch(e){st.image=null}
      await T.core.invoke('tray_update',{state:st}).catch(function(){})}while(trayAgain)}
  finally{trayBusy=false}}
// 状态页（菜单栏“后台引擎状态”打开这个窗口时看得到）
function esc(t){return String(t).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})}
function renderStatus(){var el=document.getElementById('st');if(!el)return;
  var head=job?('正在翻：'+esc(prog.title||baseOf(job.path))+'　'+prog.done+'/'+prog.pages+' 页'+(paused?'（已暂停）':'')+'　阶段：'+({translating:'翻译',building:'生成双栏 PDF',done:'完成',idle:'空闲'}[prog.phase]||prog.phase)):'空闲';
  el.innerHTML='<h3>'+head+'</h3><p>排队：'+(queue.length?queue.map(function(x){return esc(baseOf(x.path))}).join('、'):'没有')+'　并发：'+getConc()+(lastOut?'　上一份：'+esc(lastOut):'')+'</p>'
    +'<ol>'+LOG.slice(0,30).map(function(e){return '<li class="'+(e.ok?'ok':'bad')+'">'+e.t+'　第 '+esc(e.page)+' 页　'+esc(e.type)+'　'+esc(e.msg)+'</li>'}).join('')+'</ol>'}

// ── 接任务：Zotero 链接、菜单栏 ──
function onDeepLink(u){try{var url=new URL(u);if(url.protocol!=='pdfyi:')return;var q=url.searchParams;
  enqueue({path:q.get('path'),key:q.get('key'),lib:parseInt(q.get('lib'))||1,mode:q.get('mode')==='linked'?'linked':'stored'})}catch(e){}}
if(T){
  try{if(T.deepLink){T.deepLink.getCurrent().then(function(us){(us||[]).forEach(onDeepLink)}).catch(function(){});T.deepLink.onOpenUrl(function(us){(us||[]).forEach(onDeepLink)})}}catch(e){}
  T.event.listen('tray-action',async function(ev){var id=String(ev.payload||'');
    if(id==='pause'){paused=!paused;if(!paused)resume();tray()}
    else if(id==='bg_open'){try{var ps=await T.dialog.open({multiple:true,filters:[{name:'PDF',extensions:['pdf']}]});(Array.isArray(ps)?ps:(ps?[ps]:[])).forEach(function(p){enqueue({path:typeof p==='string'?p:p.path})})}catch(e){}}
    else if(id==='progress')T.core.invoke('show_main').catch(function(){});
    else if(id==='open_last'&&lastOut)T.core.invoke('open_path',{path:lastOut}).catch(function(){});
    else if(id==='reveal'&&lastOut)T.core.invoke('reveal_path',{path:lastOut}).catch(function(){});
    else if(id==='notify'){notifyOn=!notifyOn;try{localStorage.setItem('pdfyi_notify',notifyOn?'1':'0')}catch(e){}tray()}});
  try{if(T.notification)T.notification.isPermissionGranted().then(function(g){if(!g)T.notification.requestPermission()}).catch(function(){})}catch(e){}
  tray();
}
// 给测试和调试用
window.PDFYI_WORKER={enqueue:enqueue,state:function(){return {job:job,queue:queue.slice(),prog:prog,paused:paused,lastOut:lastOut,log:LOG.slice(0,20)}}};
})();
