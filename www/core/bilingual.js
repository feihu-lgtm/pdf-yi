// 本文件由 coreport/assemble.py 从全量版 pdf-reader-v60.html 原样移植生成，逻辑与全量版一致。
// 双栏 PDF：左边原页（矢量，按裁剪盒和 /Rotate 转正），右边译文按原文高度对齐、放不下缩字号，不生成续页。
var PDFLib=null,_fontkitP=null,_cjkFontP=null,_bpBusy=false,highlights=[],_pageNotes={};
function pickFontFile(){return Promise.reject(new Error('找不到中文字体文件 vendor/fonts/NotoSansSC-Sub.ttf'))}
function _loadScript(src){return new Promise(function(res,rej){var s=document.createElement('script');s.src=src;s.onload=res;s.onerror=function(){rej(new Error('加载失败：'+src))};document.head.appendChild(s)})}
async function loadPdfLib(){if(PDFLib)return PDFLib;return new Promise(function(res,rej){var s=document.createElement('script');s.src=VENDOR?VENDOR+'pdf-lib.min.js':'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';s.onload=function(){PDFLib=window.PDFLib;res(PDFLib)};s.onerror=rej;document.head.appendChild(s)})}
function loadFontkit(){if(window.fontkit)return Promise.resolve(window.fontkit);
  if(!_fontkitP)_fontkitP=_loadScript(VENDOR?VENDOR+'fontkit.umd.min.js':'https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js').then(function(){return window.fontkit});
  return _fontkitP}
function loadCjkFont(){
  if(!_cjkFontP)_cjkFontP=(async function(){
    var urls=[(VENDOR||'')+'fonts/NotoSansSC-Sub.ttf','fonts/NotoSansSC-Sub.ttf'];
    for(var i=0;i<urls.length;i++){try{var r=await fetch(urls[i]);if(r.ok){var b=await r.arrayBuffer();if(b.byteLength>100000)return b}}catch(e){}}
    try{var saved=await idbGet('annotations','font:cjk');if(saved&&saved.byteLength)return saved}catch(e){}
    var picked=await pickFontFile();
    try{await idbSet('annotations','font:cjk',picked)}catch(e){}
    return picked})().catch(function(e){_cjkFontP=null;throw e});
  return _cjkFontP}
function bpFontSize(){var v=12;try{v=parseFloat(localStorage.getItem('pdfyi_bp_size'))||12}catch(e){}return [10.5,12,13.5].indexOf(v)>=0?v:12}
function bpColumns(){try{return localStorage.getItem('pdfyi_bp_cols')!=='0'}catch(e){return true}}
function _matchKeys(norm,t){var key=norm(t),bare=key.replace(/^[^a-z]+/,'');return bare&&bare!==key?[key,bare]:[key]}
function _matchHead(t){var m=String(t).toLowerCase().match(/[a-z]{3,}/);return m?m[0]:''}
async function _pageColumns(pg,W,srcParas,n,bbs){
  if(!n||srcParas.length!==n)return null;
  var tc=await pg.getTextContent();_colOrder(tc.items,W);var info=_colOrder.info;
  if(!info||info.fullMid>0)return null;
  var items=tc.items.filter(function(it){return it.str&&it.str.trim()});
  var norm=function(t){return String(t).replace(/[\s\u00ad⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,'').toLowerCase()};
  var cols=[],last=0,cnt=[0,0];
  var useBB=bbs&&bbs.length===n;
  srcParas.forEach(function(t,pi){var ks=_matchKeys(norm,t),c=-1,bb=useBB?bbs[pi]:null;
    // 先只在这一段原文所在的高度范围里找它的开头；编号标题再试去掉编号
    for(var pass=0;pass<2&&c<0;pass++){if(pass===0&&!bb)continue;
      for(var q=0;q<ks.length&&c<0;q++){var key=ks[q];if(key.length<6)continue;
        for(var i=0;i<items.length;i++){var it=items[i],y=it.transform[5];if(pass===0&&(y<bb.y-2||y>bb.y+bb.h+2))continue;
          var s2=norm(it.str);if(s2.length<6)continue;var L=Math.min(12,s2.length,key.length);
          if(s2.slice(0,L)===key.slice(0,L)){var x=it.transform[4]+(it.width||0)/2;c=x<info.sx?0:1;break}}}}
    if(c<0&&bb){var yAim=bb.y0!=null?bb.y0:bb.y+bb.h-14,head=_matchHead(t),best=null;
      if(head)items.forEach(function(it){var y=it.transform[5],s2=norm(it.str),d=Math.abs(y-yAim);if(y<bb.y-2||y>bb.y+bb.h+2||s2.slice(0,head.length)!==head)return;
        if(!best||d<best.d||(d===best.d&&String(it.str).length>String(best.it.str).length))best={it:it,d:d}});
      if(best){var x=best.it.transform[4]+(best.it.width||0)/2;c=x<info.sx?0:1}}
    if(c<0)c=last;cols.push(c);last=c;cnt[c]++});
  if(!cnt[0]||!cnt[1])return null;
  var ysA=items.map(function(it){return it.transform[5]}),yT=Math.max.apply(null,ysA),yB=Math.min.apply(null,ysA),sp2=Math.max(1,yT-yB),lx0=Infinity,rx1=-Infinity;
  items.forEach(function(it){var y=it.transform[5];if(y>yT-sp2*0.08||y<yB+sp2*0.08)return;var a=it.transform[4],b=a+(it.width||0);if((a+b)/2<info.sx)lx0=Math.min(lx0,a);else rx1=Math.max(rx1,b)});
  return {sx:info.sx,cols:cols,lx0:isFinite(lx0)?lx0:0,rx1:isFinite(rx1)?rx1:W}}
function _paraSpans(items,info,srcParas,bbs){
  if(!info||!srcParas.length)return null;
  var its=items.filter(function(it){return it.str&&it.str.trim()});
  var norm=function(t){return String(t).replace(/[\s\u00ad⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,'').toLowerCase()};
  var sx=info.sx,lx0=Infinity,rx1=-Infinity,useBB=bbs&&bbs.length===srcParas.length;
  its.forEach(function(it){var a=it.transform[4],b=a+(it.width||0);if(a<sx-4&&b>sx+4)return;if((a+b)/2<sx)lx0=Math.min(lx0,a);else rx1=Math.max(rx1,b)});
  var spans=srcParas.map(function(t,pi){var key=norm(t),bb=useBB?bbs[pi]:null,hit=null;
    for(var pass=0;pass<2&&!hit;pass++){if(pass===0&&!bb)continue;if(key.length<6)break;
      for(var i=0;i<its.length;i++){var it=its[i],y=it.transform[5];if(pass===0&&(y<bb.y-2||y>bb.y+bb.h+2))continue;
        var s2=norm(it.str);if(s2.length<6)continue;var L=Math.min(12,s2.length,key.length);if(s2.slice(0,L)===key.slice(0,L)){hit=it;break}}}
    if(!hit)return 'F';
    // 这一段开头那一行（同一基线上的所有片段）的左右范围
    // 这一段开头那一行：分界线两边都有字、分界线附近的空隙又不到 8pt（单词间的空格），就是横跨两栏的一行
    var y0=hit.transform[5],leftEdge=-Infinity,rightEdge=Infinity,cross=false,hasL=false,hasR=false;
    its.forEach(function(it){if(Math.abs(it.transform[5]-y0)>1.5)return;var x=it.transform[4],x2=x+(it.width||0);
      if(x<sx&&x2>sx){cross=true;return}
      if(x2<=sx){hasL=true;leftEdge=Math.max(leftEdge,x2)}else{hasR=true;rightEdge=Math.min(rightEdge,x)}});
    if(cross||(hasL&&hasR&&rightEdge-leftEdge<8))return 'F';
    return (hit.transform[4]+(hit.width||0)/2)<sx?'L':'R'});
  var lFrac=(isFinite(lx0)&&isFinite(rx1)&&rx1>lx0)?Math.min(0.75,Math.max(0.25,(sx-lx0)/(rx1-lx0))):0.5;
  return {spans:spans,lFrac:lFrac}}
function _paraGeometry(items,srcParas,bbs){
  var its=items.filter(function(it){return it.str&&it.str.trim()});if(!its.length||!srcParas.length)return null;
  var norm=function(t){return String(t).replace(/[\s\u00ad⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,'').toLowerCase()};
  var X0=function(it){return it.transform[4]},X1=function(it){return it.transform[4]+(it.width||0)};
  var FS=function(it){var t=it.transform;return Math.hypot(t[0],t[1])||Math.abs(t[3])||0};
  var useBB=bbs&&bbs.length===srcParas.length;
  return srcParas.map(function(t,pi){var ks=_matchKeys(norm,t),bb=useBB?bbs[pi]:null,hit=null;
    for(var pass=0;pass<2&&!hit;pass++){if(pass===0&&!bb)continue;
      for(var q=0;q<ks.length&&!hit;q++){var key=ks[q];if(key.length<4)continue;
        for(var i=0;i<its.length;i++){var it=its[i],y=it.transform[5];if(pass===0&&(y<bb.y-2||y>bb.y+bb.h+2))continue;
          var s2=norm(it.str);if(s2.length<4)continue;var L=Math.min(12,s2.length,key.length);if(s2.slice(0,L)===key.slice(0,L)){hit=it;break}}}}
    if(!hit&&bb){var yAim=bb.y0!=null?bb.y0:bb.y+bb.h-14,head=_matchHead(t),best=null;
      // PDF.js 经常把段首拆成单词片段；先按首词和 bbox 顶部找，不让另一栏的长片段抢走
      if(head)its.forEach(function(it){var y=it.transform[5],s2=norm(it.str),d=Math.abs(y-yAim);if(y<bb.y-2||y>bb.y+bb.h+2||s2.slice(0,head.length)!==head)return;
        if(!best||d<best.d||(d===best.d&&String(it.str).length>String(best.it.str).length))best={it:it,d:d}});
      if(best)hit=best.it}
    if(!hit&&bb){var yAim=bb.y0!=null?bb.y0:bb.y+bb.h-14,best=null;
      its.forEach(function(it){var y=it.transform[5],d=Math.abs(y-yAim);if(y<bb.y-2||y>bb.y+bb.h+2)return;
        if(!best||d<best.d||(d===best.d&&String(it.str).length>String(best.it.str).length))best={it:it,d:d}});
      if(best)hit=best.it}
    if(!hit)return {ext:null,sfs:null,ind:null};
    // 开头那一行里，和开头片段连着的部分（相邻片段的空隙不到 10pt；两栏之间的空隙更宽，不会连过去）
    var y0=hit.transform[5],row=its.filter(function(it){return Math.abs(it.transform[5]-y0)<=1.5}).sort(function(p,q){return X0(p)-X0(q)});
    var k=row.indexOf(hit),a=X0(hit),b=X1(hit);
    for(var r=k+1;r<row.length&&X0(row[r])<=b+10;r++)b=Math.max(b,X1(row[r]));
    for(var l=k-1;l>=0&&X1(row[l])>=a-10;l--)a=Math.min(a,X0(row[l]));
    // 再并上这一段其他行里，和它左右连着的片段（标题这类单行段就保持原宽）
    // v66：顺便记下其他行的最左端，和首行比，判断原文是首行缩进还是悬挂缩进（参考文献）
    var firstX=a,restX=Infinity;
    if(bb){var yLo=bb.y-1,yHi=(bb.y0!=null?bb.y0:bb.y+bb.h-14)+1;
      for(var rep=0;rep<2;rep++)its.forEach(function(it){var y=it.transform[5];if(y<yLo||y>yHi)return;var p0=X0(it),p1=X1(it);if(p1>=a-10&&p0<=b+10){a=Math.min(a,p0);b=Math.max(b,p1);if(Math.abs(y-y0)>1.5)restX=Math.min(restX,p0)}})}
    var fs0=FS(hit),ind=null;
    if(isFinite(restX)&&fs0>0){if(firstX-restX>fs0*0.6)ind='first';else if(restX-firstX>fs0*0.6)ind='hang'}
    return {ext:[a,b],sfs:fs0,ind:ind}})}
// 生成双栏 PDF，返回文件内容（Uint8Array）。没翻的页、读不出字的页，右边写 _pageNotes 里的原因
async function buildBilingualPdf(){
  if(!pdfDoc||!rawPdfBytes)throw new Error('没有打开 PDF');
  _bpBusy=true;
  try{
    var lib=await loadPdfLib(),fk=await loadFontkit(),fb=await loadCjkFont();
    var src=await lib.PDFDocument.load(rawPdfBytes,{ignoreEncryption:true});
    var out=await lib.PDFDocument.create();out.registerFontkit(fk);
    var font=await out.embedFont(fb,{subset:true});
    var sp=src.getPages(),N=sp.length,PN=lib.PDFName,ctx=out.context;
    var INK=lib.rgb(0.16,0.11,0.22),MUTE=lib.rgb(0.55,0.5,0.62),LINE=lib.rgb(0.82,0.78,0.9),WHITE=lib.rgb(1,1,1);
    // ── 第一遍：每一页怎么排（v55：两栏且中间没有通栏内容的页，按栏拆成两张） ──
    var plans=[],idx=[];
    for(var p=1;p<=N;p++){
      var pg=await pdfDoc.getPage(p),vp=pg.getViewport({scale:1}),box=pg.view,angle=((pg.rotate%360)+360)%360;
      var zh=memCache[p],bbs=(pageBboxCache[p]&&pageBboxCache[p].bboxes)||[],note=null;
      if(!zh||!zh.length){note=_pageNotes[p]||'这一页还没有翻译。'}
      var pl={p:p,pg:pg,vp:vp,box:box,angle:angle,zh:zh,bbs:bbs,note:note,col:null,twoCol:false};
      if(!note){try{var tcP=await pg.getTextContent();_colOrder(tcP.items,vp.width);var infoP=_colOrder.info;pl.twoCol=!!infoP;
        if(angle===0)pl.geo=_paraGeometry(tcP.items,pageTextCache[p]||[],bbs)}catch(e){}}
      if(!note&&angle===0&&bpColumns())pl.col=await _pageColumns(pg,vp.width,pageTextCache[p]||[],zh.length,bbs);
      plans.push(pl);if(angle===0){idx.push(p-1);if(pl.col)idx.push(p-1)}}
    // v66：全书正文字号＝各段原文字号按译文字数加权的中位数；每页都按它排，翻页时字号不跳
    var _ws=[],BODY=0;
    plans.forEach(function(pl){if(pl.geo&&pl.zh)pl.geo.forEach(function(g,i){if(g&&g.sfs>0)_ws.push({v:g.sfs,w:Math.max(1,String(pl.zh[i]||'').length)})})});
    _ws.sort(function(a,b){return a.v-b.v});
    (function(){var tot=_ws.reduce(function(a,o){return a+o.w},0),acc=0;for(var i=0;i<_ws.length;i++){acc+=_ws[i].w;if(acc>=tot/2){BODY=_ws[i].v;break}}})();
    // 一次复制整本，页面之间共用字体和图片（按栏拆的页复制两份，资源仍共用）
    var copied=await out.copyPages(src,idx),ci=0;
    // 复制来的页如果和另一份共用内容列表或批注列表，先各自拆开，免得往一份里加东西另一份也跟着变
    // 小宝定位：内容列表可能是引用指向的数组，也可能直接就是数组；两种都要拆开（原始内容流仍共用）
    var isolate=function(page){['Contents','Annots'].forEach(function(k){var v=page.node.get(PN.of(k));var o=v instanceof lib.PDFRef?ctx.lookup(v):v;if(o instanceof lib.PDFArray)page.node.set(PN.of(k),o.clone(ctx))})};
    // 只保留落在 [x0,x1] 里的原页批注
    var keepAnnots=function(page,x0,x1){var A=page.node.Annots();if(!A)return;var keep=[];
      for(var i=0;i<A.size();i++){var an=ctx.lookup(A.get(i));var R=an&&an.get&&ctx.lookup(an.get(PN.of('Rect')));
        if(!R||!R.asArray){keep.push(A.get(i));continue}var r=R.asArray().map(function(n){return n.asNumber?n.asNumber():0});var cx=(r[0]+r[2])/2;if(cx>=x0&&cx<=x1)keep.push(A.get(i))}
      page.node.set(PN.of('Annots'),ctx.obj(keep))};
    // ── v66 排版 ──
    // 整页统一字号和行距：正文、小字（图注、参考文献、脚注）、标题三级，都按原文字号相对全书正文定；标题加粗。
    // 首行缩进、悬挂缩进照原文；上标脚注号画成小号上移数字；中文字体缺的符号改用 PDF 标准字体画。
    // 放不下时先压行距，再整页等比缩小；缩到原来的 3/4 还放不下，整张改顺排。
    var SYMF=await out.embedFont(lib.StandardFonts.Symbol),HELV=await out.embedFont(lib.StandardFonts.Helvetica);
    var _cjkF=null;try{_cjkF=font.embedder&&font.embedder.font}catch(e){}
    var _gl={},_enc=new Map();
    var hasG=function(ch){if(_gl[ch]!=null)return _gl[ch];var ok=true;try{if(_cjkF&&_cjkF.hasGlyphForCodePoint)ok=!!_cjkF.hasGlyphForCodePoint(ch.codePointAt(0))}catch(e){}return _gl[ch]=ok};
    var canEnc=function(f,ch){var key=(f===SYMF?'s':'h')+ch;if(_enc.has(key))return _enc.get(key);var ok=true;try{f.encodeText(ch)}catch(e){ok=false}_enc.set(key,ok);return ok};
    var SUP={'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9'};
    var runsOf=function(s){var runs=[],cur=null;Array.from(String(s)).forEach(function(ch){var k;
        if(SUP[ch]){k='sup';ch=SUP[ch]}else if(hasG(ch))k='cjk';else if(canEnc(SYMF,ch))k='sym';else if(canEnc(HELV,ch))k='helv';else k='cjk';
        if(cur&&cur.k===k)cur.s+=ch;else runs.push(cur={k:k,s:ch})});return runs};
    var runF=function(r){return r.k==='sym'?SYMF:r.k==='helv'?HELV:font};
    var runW=function(r,fs){var z=r.k==='sup'?fs*0.62:fs;try{return runF(r).widthOfTextAtSize(r.s,z)}catch(e){return r.s.length*z}};
    var lineW=function(s,fs){return runsOf(s).reduce(function(a,r){return a+runW(r,fs)},0)};
    var drawLine=function(page,s,x,y,fs,color,bold){
      if(bold)page.pushOperators(lib.pushGraphicsState(),lib.setTextRenderingMode(lib.TextRenderingMode.FillAndOutline),lib.setLineWidth(fs*0.03),lib.setStrokingColor(color));
      runsOf(s).forEach(function(r){var z=r.k==='sup'?fs*0.62:fs;page.drawText(r.s,{x:x,y:y+(r.k==='sup'?fs*0.36:0),size:z,font:runF(r),color:color});x+=runW(r,fs)});
      if(bold)page.pushOperators(lib.popGraphicsState())};
    // 图表刻度、表格里只有数字和符号的段：原文就在左边，右边不再重复
    var numOnly=function(t){t=String(t);return /\d/.test(t)&&!/[A-Za-z\u00c0-\u024f\u3400-\u4dbf\u4e00-\u9fff]/.test(t)};
    var bodyOf=function(tw){return BODY?Math.min(12.5,Math.max(7.5,BODY)):bpFontSize()*Math.min(1.15,Math.max(0.85,tw/595))};
    var styleOf=function(pa){var r=pa.sfs&&BODY?pa.sfs/BODY:1;
      if(r>=1.3)return {k:'h1',f:Math.min(1.9,Math.max(1.3,r*0.92)),bold:true,LH:1.3};
      if(r>=1.08&&String(pa.t).length<=40)return {k:'h2',f:1.12,bold:true,LH:1.35};
      if(r<=0.92)return {k:'sm',f:Math.max(0.75,r),bold:false};
      return {k:'p',f:1,bold:false}};
    var wrapPara=function(pa,st,fs,w){var ind=(st.k==='p'||st.k==='sm')?pa.ind:null,em=fs*2;
      if(w-em<fs*6)ind=null;
      return {ind:ind,em:em,lines:ind==='first'?_wrap(pa.t,font,fs,w,w-em):ind==='hang'?_wrap(pa.t,font,fs,w-em,w):_wrap(pa.t,font,fs,w)}};
    var indX=function(wp,j){return (wp.ind==='first'&&j===0)||(wp.ind==='hang'&&j>0)?wp.em:0};
    // 整页顺排兜底：忽略原文锚点，按阅读顺序排全部译文，绝不越界或续页；校验基线和中文字数
    var drawSequential=function(page,tx,ty,tw,th,list,pageNo){
      list=list.filter(function(pa){return pa.fail||!numOnly(pa.t)});if(!list.length)return;
      var m=Math.max(14,tw*0.06),x0=tx+m,colW=tw-2*m,top=th-Math.min(m,24),bottom=14,minFs=3,body0=bodyOf(tw),plan=null;
      var layout=function(body,LH){
        var cursor=top,items=[],fits=colW>0&&top>=bottom;
        list.forEach(function(pa){var st=styleOf(pa),fs=body*st.f,lh=st.LH?Math.min(st.LH,LH):LH,wp=wrapPara(pa,st,fs,colW),y=cursor;
          wp.lines.forEach(function(l,j){items.push({l:l,x:x0+indX(wp,j),y:y-fs,fs:fs,fail:pa.fail,bold:st.bold});if(y-fs<bottom||y-fs>top)fits=false;y-=fs*lh});
          cursor=y-fs*(st.k==='h1'||st.k==='h2'?0.6:0.35)});
        return {items:items,body:body,fits:fits}};
      for(var body=Math.max(minFs,body0);;body=Math.max(minFs,body*0.92)){
        [1.5,1.4,1.3,1.25].some(function(L){plan=layout(body,L);return plan.fits});if(plan.fits||body===minFs)break}
      if(!plan.fits){var message='第 '+pageNo+' 张顺排校验失败：3pt 仍放不下，已停止导出以免越界或丢字';
        addTransLog(pageNo,'',message,activeModel,'排版',false);throw new Error(message)}
      plan.items.forEach(function(it){drawLine(page,it.l,it.x,ty+it.y,it.fs,it.fail?MUTE:INK,it.bold)});
      var countZh=function(t){return (String(t).match(/[\u4e00-\u9fff]/g)||[]).length};
      var expected=countZh(list.map(function(pa){return pa.t}).join('\n'));
      var actual=countZh(plan.items.map(function(it){return it.l}).join('\n'));
      var bounded=plan.items.every(function(it){return it.y>=bottom&&it.y<=top}),ok=bounded&&actual===expected;
      var message='第 '+pageNo+' 张顺排校验'+(ok?'成功':'失败')+'：基线'+(bounded?'全部在界内':'越界')+'，中文 '+actual+'/'+expected+' 字，正文字号 '+plan.body.toFixed(2)+'pt';
      addTransLog(pageNo,'',message,activeModel,'排版',ok);if(!ok)throw new Error(message)};
    // 把一组段落排进原页译文区；有原文位置走 boxFit，没有就整张顺排
    var drawTrans=function(page,tx,ty,tw,th,list,pageNo,byHeight,mapX){
      if(list.length&&list.every(function(pa){return pa.anchor!=null})){boxFit(page,tx,ty,tw,th,list,mapX,pageNo);return}
      drawSequential(page,tx,ty,tw,th,list,pageNo)};
    // 每段从原文这一段的高度开始；同一竖条里上一段还没写完就接在它下面（不重叠）。整页同一套字号和行距。
    var boxFit=function(page,tx,ty,tw,th,list,mapX,pageNo){
      list=list.filter(function(pa){return pa.fail||!numOnly(pa.t)});if(!list.length)return;
      var pad=4,top=th-6,bot=14,mg=Math.max(14,tw*0.06),colX0=tx+mg,colX1=tx+tw-mg,mid=(colX0+colX1)/2,body0=bodyOf(tw);
      var B=list.map(function(pa,i){var x0,x1,st=styleOf(pa);
        if(pa.ext&&mapX){x0=mapX(pa.ext[0]);x1=mapX(pa.ext[1])}else{x0=colX0;x1=colX1}
        x0=Math.max(tx+pad,x0);x1=Math.min(tx+tw-pad,x1);
        // 居中的标题在整栏里居中，不受原文那一行的宽度限制
        var center=(st.k==='h1'||st.k==='h2')&&Math.abs((x0+x1)/2-mid)<tw*0.06&&(x1-x0)<(colX1-colX0)*0.8;
        if(center){x0=colX0;x1=colX1}
        // 图里、目录里的短条目原文很窄，中文至少给九个字宽，免得一字一行；左边对齐原文，往右加宽
        var minW=Math.min(colX1-colX0,body0*9);
        if(x1-x0<minW){x1=Math.min(tx+tw-pad,x0+minW);x0=Math.max(tx+pad,x1-minW)}
        return {pa:pa,i:i,x0:x0,x1:x1,top:Math.min(top,pa.anchor),st:st,center:center}})
        .sort(function(a,b){return (b.top-a.top)||(a.i-b.i)});
      var ovl=function(a,b){return a.x0<b.x1-2&&b.x0<a.x1-2};
      var place=function(body,LH){var drawn=[],items=[];
        for(var k=0;k<B.length;k++){var o=B[k],fs=body*o.st.f,lh=o.st.LH?Math.min(o.st.LH,LH):LH,w=o.x1-o.x0;
          var start=o.top;drawn.forEach(function(d){if(ovl(o,d))start=Math.min(start,d.bottom-d.gap)});
          var wp=wrapPara(o.pa,o.st,fs,w),y=start;
          for(var j=0;j<wp.lines.length;j++){if(y-fs<bot||y>top+0.01)return null;
            var lx=o.center?o.x0+Math.max(0,(w-lineW(wp.lines[j],fs))/2):o.x0+indX(wp,j);
            items.push({l:wp.lines[j],x:lx,y:y-fs,fs:fs,fail:o.pa.fail,bold:o.st.bold});y-=fs*lh}
          drawn.push({x0:o.x0,x1:o.x1,bottom:y+fs*lh-fs-fs*0.25,gap:fs*(o.st.k==='h1'||o.st.k==='h2'?0.8:0.55)})}
        return items};
      var items=null;
      for(var body=body0;body>=Math.max(6,body0*0.75)-1e-6&&!items;body*=0.95)[1.6,1.5,1.4].some(function(L){items=place(body,L);return !!items});
      if(!items){addTransLog(pageNo,'','第 '+pageNo+' 张按原位排要缩到原字号 3/4 以下，改用顺排',activeModel,'排版',false);
        drawSequential(page,tx,ty,tw,th,list,pageNo);return}
      items.forEach(function(it){drawLine(page,it.l,it.x,ty+it.y,it.fs,it.fail?MUTE:INK,it.bold)})};
    // 你的高亮写成 PDF 批注（只取中心落在 [x0,x1] 里的）
    var addHighlights=function(page,p,W,H,ox,oy,x0,x1){
      var hls=highlights.filter(function(h){return h.pageNum===p});if(!hls.length)return;
      var ce=document.querySelector('#pdf-wrap-'+p+' canvas'),cssW=ce?parseFloat(ce.style.width):0,cssH=ce?parseFloat(ce.style.height):0;if(!cssW||!cssH)return;
      var sX=W/cssW,sY=H/cssH,refs=[],PNum=lib.PDFNumber;
      hls.forEach(function(hl){var hex=hl.pdfColor||'FFE84D',r=parseInt(hex.slice(0,2),16)/255,g=parseInt(hex.slice(2,4),16)/255,b=parseInt(hex.slice(4,6),16)/255;
        var qp=[],mnX=Infinity,mnY=Infinity,mxX=-Infinity,mxY=-Infinity;
        hl.rects.forEach(function(rc){var X0=ox+rc.x*sX,Y0=oy+H-(rc.y+rc.h)*sY,X1=X0+rc.w*sX,Y1=Y0+rc.h*sY;qp.push(X0,Y1,X1,Y1,X0,Y0,X1,Y0);mnX=Math.min(mnX,X0);mnY=Math.min(mnY,Y0);mxX=Math.max(mxX,X1);mxY=Math.max(mxY,Y1)});
        if(!qp.length)return;var cx=(mnX+mxX)/2;if(x0!=null&&(cx<x0||cx>x1))return;
        refs.push(ctx.register(ctx.obj({Type:PN.of('Annot'),Subtype:PN.of('Highlight'),Rect:ctx.obj([mnX,mnY,mxX,mxY]),QuadPoints:ctx.obj(qp),
          Contents:lib.PDFHexString.fromText(hl.note||String(hl.text||'').slice(0,300)),T:lib.PDFHexString.fromText('PDF译'),C:ctx.obj([r,g,b]),CA:PNum.of(0.45),F:PNum.of(4)})))});
      // 原页自带的批注（链接等）保留，新的接在后面
      if(refs.length){var exA=page.node.Annots();if(exA)refs.forEach(function(r){exA.push(r)});else page.node.set(PN.of('Annots'),ctx.obj(refs))}};
    // ── 第二遍：逐页生成 ──
    for(var k=0;k<plans.length;k++){
      var pl=plans[k],p=pl.p,pg=pl.pg,vp=pl.vp,box=pl.box,angle=pl.angle,W=vp.width,H=vp.height,yOff=box[1];
      // 每段译文：文字、是否失败、该放的高度（相对页面底边）
      var paras=null;
      if(!pl.note){
        var useBB=pl.bbs.length===pl.zh.length;
        // v57：优先用这一段第一行的高度（以前缓存的位置框没有，就用整段最高点）
        var anchors=useBB?pl.bbs.map(function(bb){return bb.y0!=null?bb.y0-yOff+14:bb.y-yOff+bb.h}):[];
        // 小宝：bbox 记录的是原 PDF 坐标；旋转页用文字四角映射到显示坐标
        if(useBB&&angle){var tc=await pg.getTextContent();
          anchors=pl.bbs.map(function(bb){var topY=Infinity;
            tc.items.forEach(function(it){var t=it.transform;if(!it.str||!t||t[5]<bb.y-1||t[5]>bb.y+bb.h+1)return;
              var a=Math.atan2(t[1],t[0]),dx=Math.cos(a)*it.width,dy=Math.sin(a)*it.width,hx=-Math.sin(a)*it.height,hy=Math.cos(a)*it.height;
              [[t[4],t[5]],[t[4]+dx,t[5]+dy],[t[4]+hx,t[5]+hy],[t[4]+dx+hx,t[5]+dy+hy]].forEach(function(pt){topY=Math.min(topY,vp.convertToViewportPoint(pt[0],pt[1])[1])})});
            return isFinite(topY)?H-topY:null})}
        paras=pl.zh.map(function(t,i){var fail=String(t||'').indexOf('__TRANSFAIL__')===0,g=pl.geo&&pl.geo[i];return {t:fail?'〔本段翻译失败〕':String(t||''),fail:fail,anchor:useBB?anchors[i]:null,i:i,ext:(g&&g.ext)||null,sfs:(g&&g.sfs)||null,ind:(g&&g.ind)||null}})}
      if(pl.col){
        // ── 按栏：左栏一张、右栏一张，每张“这一栏原文 + 这一栏译文” ──
        for(var c=0;c<2;c++){
          // 按这一栏文字实际所在的范围切，两边各留 8pt；译文区是这一栏的 1.35 倍宽（中文同字号时要多占地方）
          var cx0=c===0?Math.max(box[0],pl.col.lx0-8):pl.col.sx-3,cx1=c===0?pl.col.sx+3:Math.min(box[2],pl.col.rx1+8),cw=cx1-cx0,tw=cw*1.35,sw=cw+tw,oy=box[1];
          var page=out.addPage(copied[ci++]);isolate(page);
          page.setMediaBox(cx0,oy,sw,H);page.setCropBox(cx0,oy,sw,H);
          try{page.setTrimBox(cx0,oy,sw,H);page.setBleedBox(cx0,oy,sw,H);page.setArtBox(cx0,oy,sw,H)}catch(e){}
          keepAnnots(page,cx0,cx1);
          page.drawRectangle({x:cx0+cw,y:oy,width:tw,height:H,color:WHITE});
          page.drawLine({start:{x:cx0+cw,y:oy},end:{x:cx0+cw,y:oy+H},thickness:0.6,color:LINE});
          page.drawText(p+(c?' 右栏':' 左栏'),{x:cx0+sw-46,y:oy+H-12,size:7,font:font,color:MUTE});
          drawTrans(page,cx0+cw,oy,tw,H,paras.filter(function(pa){return pl.col.cols[pa.i]===c}),out.getPageCount(),true,(function(cx0,cw){return function(a){return cx0+cw+(a-cx0)*1.35}})(cx0,cw));
          addHighlights(page,p,W,H,box[0],oy,cx0,cx1)}
      }else{
        var ox=0,oy=0,page;
        if(angle===0){
          // 没旋转：直接用复制来的原页，把页面向右加宽一倍，右半边铺白底再写译文；原页的链接和批注都留着
          page=out.addPage(copied[ci++]);isolate(page);ox=box[0];oy=box[1];
          page.setMediaBox(ox,oy,W*2,H);page.setCropBox(ox,oy,W*2,H);
          try{page.setTrimBox(ox,oy,W*2,H);page.setBleedBox(ox,oy,W*2,H);page.setArtBox(ox,oy,W*2,H)}catch(e){}
          page.drawRectangle({x:ox+W,y:oy,width:W,height:H,color:WHITE});
        }else{
          // 旋转过的页：小宝的办法，按裁剪盒嵌入再转正
          var ep=await out.embedPage(sp[p-1],{left:box[0],bottom:box[1],right:box[2],top:box[3]});
          page=out.addPage([W*2,H]);page.drawPage(ep,{x:angle===180||angle===270?W:0,y:angle===90||angle===180?H:0,rotate:lib.degrees(-angle)});
        }
        page.drawLine({start:{x:ox+W,y:oy},end:{x:ox+W,y:oy+H},thickness:0.6,color:LINE});
        page.drawText(String(p),{x:ox+W*2-Math.max(18,W*0.06),y:oy+H-Math.max(18,W*0.06)*0.6,size:7,font:font,color:MUTE});
        if(pl.note){var m0=Math.max(18,W*0.06);_wrap(pl.note,font,9,W-2*m0).forEach(function(l,i){page.drawText(l,{x:ox+W+m0,y:oy+H-m0-9-i*13,size:9,font:font,color:MUTE})})}
        else drawTrans(page,ox+W,oy,W,H,paras,out.getPageCount(),!pl.twoCol,angle===0?(function(ox,W,bx){return function(a){return ox+W+(a-bx)}})(ox,W,box[0]):null);
        addHighlights(page,p,W,H,ox,oy,null,null)}
      if(p%5===0)await Promise.resolve();// 后台不用计时器让出
    }
    var bytes=await out.save();
    return bytes;
  }finally{_bpBusy=false}}
