// 本文件由 coreport/assemble.py 从全量版 pdf-reader-v54.html 原样移植生成，逻辑与全量版一致。
// 文字工具：拼接、康熙部首、上标、分栏、句末判断、断行。全部是纯函数。
var VENDOR=window.PDFYI_VENDOR||'vendor/';
var _TERM=/[.!?。！？…]["”’)\]）」』》]*(\d{0,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹*†‡]{0,3})$/;
var _ABBR=/(?:\be\.g|\bi\.e|\bc\.f|\bal|\betc|\bvs|\bcf|\bDr|\bProf|\bMr|\bMrs|\bMs|\bSt|\bNo|\bpp|\bp|\bvol|\bch|\bed|\beds|\bU\.S|\b[A-Z])\.$/;
var _ROMAN=/^(?=[mdclxvi])m*(c[md]|d?c{0,3})(x[cl]|l?x{0,3})(i[xv]|v?i{0,3})$/i;
var _CJKEND=/[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]$/,_CJKSTART=/^[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
var _BREAK_TOK=/[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef\u2014\u2026]|[^\s\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef\u2014\u2026]+|\s+/g;
var _NO_START=/^[，。、；：！？）」』》〉】,.;:!?)\]…—’”%]/;
function _kangxi(t){return /[\u2F00-\u2FDF]/.test(t)?t.replace(/[\u2F00-\u2FDF]/g,function(c){return c.normalize('NFKC')}):t}
function _jn(a,b){if(!a)return b||'';if(!b)return a;if(/\s$/.test(a)||/^\s/.test(b))return a+b;if(_CJKEND.test(a)&&_CJKSTART.test(b))return a+b;if(/[⁰¹²³⁴⁵⁶⁷⁸⁹]$/.test(a)&&_CJKSTART.test(b))return a+b;return a+' '+b}
function _jnAll(arr){var t='';arr.forEach(function(x){t=_jn(t,x)});return t}
function _isZhPara(t){var cjk=(String(t).match(/[\u3400-\u9fff\uf900-\ufaff]/g)||[]).length,lat=(String(t).match(/[A-Za-z]/g)||[]).length;return cjk>=2&&cjk*3>=lat}
function _isPageNo(x){return (/^[\d\s.\-–—\/:()（）|·,]{1,24}$/.test(x)&&/\d/.test(x))||_ROMAN.test(x)||/^\(?[ivxlc]{1,6}\)?$/i.test(x)}
function pageTextQuality(lines){
  // 先去掉页码行：读坏的页常常只剩页码
  var body=(lines||[]).filter(function(l){l=String(l||'').replace(/\s+/g,' ').trim();return l&&!_isPageNo(l)});
  var t=body.join(''),ns=t.replace(/\s/g,'').length,letters=(t.match(/[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)||[]).length;
  if(ns===0)return {kind:'empty',msg:'这一页提取不到正文文字（一个字都没有，或者只读出了页码）：可能是扫描件、整页图片、空白页，或者字体缺少字符映射。'};
  if(ns>=15&&letters/ns<0.35)return {kind:'garbled',msg:'这一页的字读不出来，只剩标点和数字：可能是扫描件，或者字体缺少字符映射。'};
  return null}
function _colOrder(items,W){
  var its=items.filter(function(it){return it&&it.str&&it.str.trim()});
  if(its.length<16||!W)return items;
  var x0=function(it){return it.transform[4]},x1=function(it){return it.transform[4]+(it.width||0)};
  var byLine={};its.forEach(function(it){var k=Math.round(it.transform[5]/3);(byLine[k]=byLine[k]||[]).push(it)});
  var lines=Object.keys(byLine).map(function(k){return byLine[k]});
  var best=null;
  for(var f=0.30;f<=0.701;f+=0.01){var sx=W*f,both=0,free=0;
    lines.forEach(function(L){var hasL=L.some(function(it){return x1(it)<=sx-4}),hasR=L.some(function(it){return x0(it)>=sx+4}),cov=L.some(function(it){return x0(it)<sx+4&&x1(it)>sx-4});
      if(hasL&&hasR){both++;if(!cov)free++}});
    if(!best||free>best.free)best={sx:sx,free:free,both:both}}
  if(!best||best.both<5||best.free<5||best.free<best.both*0.6)return items;
  var sx=best.sx,ys=function(L){return L[0].transform[5]};
  lines.sort(function(a,b){return ys(b)-ys(a)});
  var out=[],blockL=[],blockR=[];
  var flush=function(){blockL.forEach(function(L){out.push.apply(out,L)});blockR.forEach(function(L){out.push.apply(out,L)});blockL=[];blockR=[]};
  lines.forEach(function(L){
    L.sort(function(a,b){return x0(a)-x0(b)});
    var full=L.some(function(it){return x0(it)<sx-4&&x1(it)>sx+4});
    if(full){flush();out.push.apply(out,L);return}
    var l=L.filter(function(it){return (x0(it)+x1(it))/2<sx}),r=L.filter(function(it){return (x0(it)+x1(it))/2>=sx});
    if(l.length)blockL.push(l);if(r.length)blockR.push(r)});
  flush();
  return out}
function extractParas(tc,viewport){
  var pdfH=viewport.height,pdfW=viewport.width;var lines=[],prevY=null,prevYRaw=null,cur='',curItems=[];
  var _items=_colOrder(tc.items,pdfW);// v40：双栏先分栏
  // v41：正文字号 = 全页字数最多的那个字号；用来认上标脚注号和脚注区
  var _fsOf=function(it){var t=it.transform;return Math.hypot(t[0],t[1])||Math.abs(t[3])||0};
  var _fw={};_items.forEach(function(it){if(!it||!it.str||!it.str.trim())return;var k=Math.round(_fsOf(it)*2)/2;_fw[k]=(_fw[k]||0)+it.str.trim().length});
  var bodyFs=0,_bw=-1;Object.keys(_fw).forEach(function(k){if(_fw[k]>_bw){_bw=_fw[k];bodyFs=parseFloat(k)}});
  var _supTidy=function(t){return t.replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹*†‡]+)\s+(?=[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef])/g,'$1')};// 上标和汉字、中文标点之间不留空格
  var _SUP={'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹'};
  var _lineFs=function(its){var a=its.filter(function(it){return it.str&&it.str.trim()&&!it._sup}).map(_fsOf).sort(function(x,y){return x-y});return a.length?a[Math.floor(a.length/2)]:0};
  for(var i=0;i<_items.length;i++){var item=_items[i];
    if(item&&item.str&&/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\u2060\ufeff]/.test(item.str)){item=Object.assign({},item,{str:item.str.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\u2060\ufeff]/g,'')});if(!item.str)continue}
    if(item&&item.str&&/[\u2F00-\u2FDF]/.test(item.str))item=Object.assign({},item,{str:_kangxi(item.str)});
    var y=Math.round(item.transform[5]),yRaw=item.transform[5],st=(item.str||'').trim(),ifs=_fsOf(item),rise=(prevYRaw===null)?0:yRaw-prevYRaw;
    // 上标脚注号：字号不到正文 80%、比当前行略高（1–8pt）、只有 1–3 位数字或符号 → 贴在前一个字后面
    var _supTxt=st.replace(/\s+/g,'');
    if(cur&&prevY!==null&&bodyFs&&/^(\d{1,3}|[*†‡§¶])$/.test(_supTxt)&&((ifs<bodyFs*0.8&&rise>=1&&rise<=8)||(ifs<=bodyFs*1.02&&rise>=bodyFs*0.25&&rise<=bodyFs*0.6))){
      st=_supTxt;
      cur=cur.replace(/\s+$/,'')+st.replace(/\d/g,function(d){return _SUP[d]});curItems.push(Object.assign({},item,{_sup:true}));continue}
    if(prevY!==null&&Math.abs(y-prevY)>5){if(cur.trim())lines.push({str:_supTidy(cur.trim()),y:prevY,items:curItems.slice(),fs:_lineFs(curItems)});cur=item.str;curItems=[item]}
    else{cur=_jn(cur,item.str);curItems.push(item)}prevY=y;if(st)prevYRaw=yRaw}
  if(cur.trim())lines.push({str:_supTidy(cur.trim()),y:prevY,items:curItems,fs:_lineFs(curItems)});
  // ── 规则预合并：行间距异常大（段落空白行）才强制断段，其余全部暂时合入同一组 ──
  // 真正的段落边界由 aiMergeLines 决定；这里只做行→初步分组
  var paras=[],paraLines=[];
  for(var i=0;i<lines.length;i++){
    var ln=lines[i];if(!ln.str){if(paraLines.length){paras.push(paraLines.slice());paraLines=[]}continue}
    // 行间距超过字高1.8倍视为段落空行
    if(paraLines.length&&i>0){
      var gap=Math.abs(ln.y-lines[i-1].y);var approxLineH=14;
      if(gap>approxLineH*1.8){paras.push(paraLines.slice());paraLines=[ln];continue}}
    paraLines.push(ln)}
  if(paraLines.length)paras.push(paraLines);
  var texts=[],bboxes=[],rawLines=[],rawYs=[],rawFs=[];
  paras.forEach(function(pls){
    // 把每个初步分组里的行逐行记录，供AI合并
    pls.forEach(function(l){rawLines.push(l.str);rawYs.push(l.y);rawFs.push(l.fs||0)});
    rawLines.push('');rawYs.push(null);rawFs.push(null);// 空字符串作为组间分隔符
  });
  // 同时保留一份 fallback 的传统合并结果
  paras.forEach(function(pls){var t=_jnAll(pls.map(function(l){return l.str})).replace(/\s+/g,' ').trim();if(t.length<=2)return;
    var minY=Infinity,maxY=-Infinity;pls.forEach(function(l){if(l.y<minY)minY=l.y;if(l.y>maxY)maxY=l.y});
    texts.push(t);bboxes.push({y:minY,h:maxY-minY+14})});
  return{texts:texts,bboxes:bboxes,pdfH:pdfH,pdfW:pdfW,rawLines:rawLines,rawYs:rawYs,rawFs:rawFs,bodyFs:bodyFs}}
function groupsToBboxes(groups,ys){
  if(!groups||!ys)return [];
  return groups.map(function(g){var mn=Infinity,mx=-Infinity;g.forEach(function(i){var y=ys[i];if(y==null)return;if(y<mn)mn=y;if(y>mx)mx=y});
    return isFinite(mn)?{y:mn,h:mx-mn+14}:{y:0,h:14}})}
function _lines(r){var out=[];(r.rawLines||[]).forEach(function(x,i){var t=String(x||'').replace(/\s+/g,' ').trim();if(t)out.push({s:t,i:i})});return out}
function _normLine(x){return x.toLowerCase().replace(/[\d#]+/g,'').replace(/[^a-z\u00c0-\u024f\u4e00-\u9fff]+/g,' ').trim()}
function _headingLike(x){
  if(x.length>70||_TERM.test(x))return false;
  var w=x.split(' ').filter(function(t){return /[A-Za-z]/.test(t)});if(!w.length)return true;
  return w.filter(function(t){return /^[A-Z0-9]/.test(t)}).length/w.length>=0.6}
function _sentEnd(t){
  var re=/[.!?]["”’)\]]*(?:\d{1,3}|[⁰¹²³⁴⁵⁶⁷⁸⁹*†‡]{1,3})?(?=\s|$)|[。！？…]["”’）」』》⁰¹²³⁴⁵⁶⁷⁸⁹]*/g,m;
  while((m=re.exec(t))){var end=m.index+m[0].length;if(end<2)continue;
    if(m[0][0]==='.'&&_ABBR.test(t.slice(Math.max(0,m.index-6),m.index+1)))continue;
    return end}
  return -1}
function groupRaw(lines,ys){
  var texts=[],bboxes=[],cur=[],cy=[];
  function flush(){var t=_jnAll(cur).replace(/\s+/g,' ').trim();if(t.length>2){texts.push(t);var mn=cy.length?Math.min.apply(null,cy):0,mx=cy.length?Math.max.apply(null,cy):0;bboxes.push({y:mn,h:mx-mn+14})}cur=[];cy=[]}
  lines.forEach(function(l,i){if(!l||!String(l).trim()){flush();return}cur.push(l);if(ys[i]!=null)cy.push(ys[i])});flush();
  return {texts:texts,bboxes:bboxes}}
function getMsgContent(d){var c=d&&d.choices&&d.choices[0]&&d.choices[0].message?d.choices[0].message.content:'';if(c==null)return '';return typeof c==='string'?c:JSON.stringify(c)}
function getFinishReason(d){return d&&d.choices&&d.choices[0]?(d.choices[0].finish_reason||''):''}
function _wrap(text,font,size,maxW){
  var toks=String(text).match(_BREAK_TOK)||[],lines=[],cur='',w=function(t){try{return font.widthOfTextAtSize(t,size)}catch(e){return t.length*size}};
  toks.forEach(function(t){
    if(/^\s+$/.test(t)){if(cur)cur+=' ';return}
    if(w(cur+t)<=maxW||!cur.trim()||(_NO_START.test(t)&&w(cur+t)<=maxW*1.06)){
      if(!cur.trim()&&w(t)>maxW){// 一个词比一行还长：硬切
        var buf='';Array.from(t).forEach(function(ch){if(w(buf+ch)>maxW&&buf){lines.push(buf);buf=''}buf+=ch});cur=buf;return}
      cur+=t;return}
    lines.push(cur.replace(/\s+$/,''));cur=t});
  if(cur.trim())lines.push(cur.replace(/\s+$/,''));
  return lines}
