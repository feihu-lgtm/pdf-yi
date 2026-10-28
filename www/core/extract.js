// 本文件由 coreport/assemble.py 从全量版 pdf-reader-v54.html 原样移植生成，逻辑与全量版一致。
// 提取：每页的原始行（pdf.js）、页眉页脚识别、脚注区、跨页补句。
// 下面这些是“当前这本书”的状态，后台引擎每开一本书就重置一次（见 worker.js 的 resetBook）。
var pdfDoc=null,rawPdfBytes=null,totalPages=0,cacheKey='';
var pageTextCache={},pageBboxCache={},memCache={},savedEnCache={},cachedAtLoad={},carryMark={},cleanRules=null;
var _rawCache={},_carryP={},_runningP=null,_runningEx={};
function rawOf(pn){
  if(!_rawCache[pn])_rawCache[pn]=pdfDoc.getPage(pn).then(function(pg){return pg.getTextContent().then(function(tc){return extractParas(tc,pg.getViewport({scale:1}))})})
    .catch(function(e){addTransLog(pn,'','提取失败: '+(e.message||e),activeModel,'提取',false);return {texts:[],bboxes:[],rawLines:[],rawYs:[],pdfH:800,pdfW:600}});
  return _rawCache[pn]}
function detectRunningLines(){
  if(_runningP)return _runningP;
  _runningP=(async function(){
    var N=totalPages,cnt={};
    for(var a=1;a<=N;a+=8){var ps=[];for(var p=a;p<Math.min(N+1,a+8);p++)ps.push(rawOf(p));
      (await Promise.all(ps)).forEach(function(r){var L=_lines(r),seen={};L.slice(0,3).concat(L.slice(-3)).forEach(function(x){var k=_normLine(x.s);if(k.length<3||seen[k])return;seen[k]=1;cnt[k]=(cnt[k]||0)+1;if(!_runningEx[k])_runningEx[k]=x.s})})}
    var set={},th=Math.max(3,Math.ceil(N/4));
    if(N>=4)Object.keys(cnt).forEach(function(k){if(cnt[k]>=th)set[k]=cnt[k]});
    return set})();
  return _runningP}
function _ruleHit(r,pn,k,n,str){
  if(!r||r.on===false)return false;
  if(r.pages==='odd'&&pn%2!==1)return false;
  if(r.pages==='even'&&pn%2!==0)return false;
  if(r.except&&r.except.indexOf(pn)>=0)return false;
  var top=k<3,bot=k>=n-3;
  if(r.where==='top'&&!top)return false;
  if(r.where==='bottom'&&!bot)return false;
  if(!top&&!bot)return false;
  return _normLine(str)===r.key}
function isRunningLine(pn,k,n,str,autoSet){
  if(k>=3&&k<n-3)return false;
  if(_isPageNo(str))return true;
  if(cleanRules)return cleanRules.running.some(function(r){return _ruleHit(r,pn,k,n,str)});
  var key=_normLine(str);return !!(autoSet&&key.length>=3&&autoSet[key])}
async function bodyLines(pn){
  var r=await rawOf(pn),set=cleanRules?null:await detectRunningLines(),L=_lines(r),n=L.length;
  return _dropFootnotes(r,L.filter(function(x,k){return !isRunningLine(pn,k,n,x.s,set)}))}
function _dropFootnotes(r,arr){
  var fs=r.rawFs,bf=r.bodyFs;if(!fs||!bf||arr.length<3)return arr;
  var k=arr.length;while(k>0){var f=fs[arr[k-1].i];if(f&&f<bf*0.92)k--;else break}
  if(k===arr.length||k===0)return arr;
  if(!/^(\d{1,3}|[*†‡§¶]|[⁰¹²³⁴⁵⁶⁷⁸⁹]{1,3})(?=[\s.)\]:A-Za-z\u4e00-\u9fff])/.test(arr[k].s))return arr;
  return arr.slice(0,k)}
async function _continued(N){
  if(N<1||N>=totalPages)return null;
  // 参考文献页往后接的不做跨页补句（条目结尾常常不是句号）；进入参考文献前那一页照常接
  if(cleanRules&&cleanRules.refs&&cleanRules.refs.on!==false&&N>=cleanRules.refs.from&&N<=cleanRules.refs.to)return null;
  var la=await bodyLines(N),lb=await bodyLines(N+1);
  if(!la.length||!lb.length)return null;
  var last=la[la.length-1].s,first=lb[0].s;
  if(last.length<25||_TERM.test(last)||_headingLike(first))return null;
  var t='',starts=[];
  for(var k=0;k<lb.length&&t.length<=900;k++){var nt=_jn(t,lb[k].s);starts.push(nt.length-lb[k].s.length);t=nt}
  var e=_sentEnd(t);if(e<0||e>900)return null;
  var cut=[],part=null;
  for(var j=0;j<starts.length;j++){
    var st=starts[j],en=st+lb[j].s.length;
    if(en<=e)cut.push(lb[j].i);
    else{if(st<e){var rest=lb[j].s.slice(e-st).trim();if(rest)part={i:lb[j].i,rest:rest};else cut.push(lb[j].i)}break}}
  return {text:t.slice(0,e).trim(),lastIdx:la[la.length-1].i,cut:cut,part:part}}
function carryOf(N){
  if(!_carryP[N])_carryP[N]=(async function(){
    if(N<1||N>=totalPages)return null;
    var c=await _continued(N);
    if(cachedAtLoad[N]){var sv=savedEnCache[N]&&savedEnCache[N].carry;return (c&&sv&&sv===c.text)?c:null}
    if(cachedAtLoad[N+1]){
      // 下一页已有译文：看它缓存里的原文还有没有这半句。没有了，说明当时挪到了本页，本页必须接上
      if(!c)return null;var se=savedEnCache[N+1];if(!se||!se.texts)return null;
      var all=se.texts.join(' ').replace(/\s+/g,' '),key=c.text.replace(/\s+/g,' ').slice(0,60);
      return all.indexOf(key)>=0?null:c}
    return c})().catch(function(e){console.warn('跨页判断出错',e);return null});
  return _carryP[N]}
async function prepOf(p){
  var r=await rawOf(p),lines=(r.rawLines||[]).slice(),ys=(r.rawYs||[]).slice();
  var head=p>1?await carryOf(p-1):null,tail=await carryOf(p);
  if(head){head.cut.forEach(function(i){lines[i]=''});if(head.part)lines[head.part.i]=head.part.rest}
  if(tail){var lp=lines[tail.lastIdx]||'';lines[tail.lastIdx]=(/-$/.test(lp)&&/^[a-z]/.test(tail.text))?lp.replace(/-$/,'')+tail.text:_jn(lp,tail.text).trim();carryMark[p]=tail.text}
  else carryMark[p]='';
  // 译文里隐藏页眉页脚和页码
  if(cleanRules&&cleanRules.hide){var L=_lines(r),n=L.length;L.forEach(function(x,k){if(isRunningLine(p,k,n,x.s,null))lines[x.i]=''})}
  return {rawLines:lines,rawYs:ys}}
async function validateCleanRules(c,autoList){
  var N=totalPages,ok=[],bad=[],all=[];
  for(var p=1;p<=N;p++)all.push(_lines(await rawOf(p)));
  function stats(r){var mid=0,hit=0,app=0;
    all.forEach(function(L,idx){var pn=idx+1,n=L.length,h=false;
      if(!(r.pages==='odd'&&pn%2!==1)&&!(r.pages==='even'&&pn%2!==0))app++;
      L.forEach(function(l,k){if(_normLine(l.s)!==r.key)return;if(k>=3&&k<n-3){if(r.except.indexOf(pn)<0)mid++;return}if(_ruleHit(r,pn,k,n,l.s))h=true});
      if(h)hit++});
    return {mid:mid,hit:hit,app:app}}
  function judge(r){var st=stats(r),need=Math.max(2,Math.ceil(st.app*0.3));
    if(st.hit<need)return {why:'只在 '+st.hit+' 页的页眉页脚位置出现',kind:'few'};
    if(st.mid>=3&&st.mid>st.hit*0.5)return {why:'正文中间也出现了 '+st.mid+' 次，像是正文',kind:'mid'};
    r.count=st.hit;r.mid=st.mid;return null}
  ((c&&c.running)||[]).slice(0,12).forEach(function(x){
    var tpl=String((x&&x.template)||'').trim(),key=_normLine(tpl);
    if(key.length<3){if(tpl&&!_isPageNo(tpl.replace(/#/g,'1')))bad.push({key:key,template:tpl,why:'太短，分不清',kind:'short'});return}// 只有数字和符号的（如 2022.7 #）按页码处理
    if(ok.some(function(o){return o.key===key})||bad.some(function(o){return o.key===key}))return;// AI 自己重复给的
    var r={key:key,template:tpl.slice(0,160),where:(x.where==='top'||x.where==='bottom')?x.where:'any',pages:(x.pages==='odd'||x.pages==='even')?x.pages:'all',
      except:(Array.isArray(x.except_pages)?x.except_pages:[]).map(function(v){return parseInt(v)}).filter(function(v){return v>=1&&v<=N}),on:true,src:'ai',count:0,mid:0};
    var j=judge(r);if(j)bad.push({key:key,template:r.template,why:j.why,kind:j.kind});else ok.push(r)});
  (autoList||[]).forEach(function(a0){
    if(ok.some(function(o){return o.key===a0.key}))return;// AI 已经有这一条
    if(bad.some(function(b0){return b0.key===a0.key&&b0.kind==='mid'}))return;// AI 那条因为像正文没用，这里也不加
    var r={key:a0.key,template:a0.template,where:'any',pages:'all',except:[],on:true,src:'auto',count:0,mid:0};
    var j=judge(r);
    if(j)return;// 自动识别自己没通过的不显示，免得卡上全是噪音
    bad=bad.filter(function(b0){return b0.key!==r.key});// AI 那条位置写错没过，用自动识别的替上
    ok.push(r)});
  var refs=null;if(c&&c.references&&parseInt(c.references.from)>=1){var rf=parseInt(c.references.from),rt=parseInt(c.references.to)||N;if(rf<=N)refs={from:rf,to:Math.min(N,Math.max(rf,rt)),on:true}}
  var skip=[];((c&&c.skip_pages)||[]).slice(0,6).forEach(function(x){var f=parseInt(x&&x.from),t=parseInt(x&&x.to)||f;if(f>=1&&f<=N)skip.push({from:f,to:Math.min(N,Math.max(f,t)),why:String((x&&x.why)||'').slice(0,40),on:false})});
  return {running:ok,rejected:bad,refs:refs,skip:skip}}
async function autoCleanRules(){
  var set=await detectRunningLines(),list=Object.keys(set).map(function(k){return {key:k,template:_runningEx[k]||k,where:'any',pages:'all',except:[],on:true,src:'auto',count:set[k]}});
  return {running:list,rejected:[],refs:null,skip:[]}}
