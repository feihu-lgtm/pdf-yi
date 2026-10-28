// 本文件由 coreport/assemble.py 从全量版 pdf-reader-v56.html 原样移植生成，逻辑与全量版一致。
// 双栏 PDF：左边原页（矢量，按裁剪盒和 /Rotate 转正），右边译文按原文高度对齐、放不下缩字号或加续页。
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
async function _pageColumns(pg,W,srcParas,n,bbs){
  if(!n||srcParas.length!==n)return null;
  var tc=await pg.getTextContent();_colOrder(tc.items,W);var info=_colOrder.info;
  if(!info||info.fullMid>0)return null;
  var items=tc.items.filter(function(it){return it.str&&it.str.trim()});
  var norm=function(t){return String(t).replace(/[\s\u00ad⁰¹²³⁴⁵⁶⁷⁸⁹]+/g,'').toLowerCase()};
  var cols=[],last=0,cnt=[0,0];
  var useBB=bbs&&bbs.length===n;
  srcParas.forEach(function(t,pi){var key=norm(t),c=-1,bb=useBB?bbs[pi]:null;
    // 先只在这一段原文所在的高度范围里找它的开头（两栏有同样开头的句子时不会认错），找不到再全页找
    for(var pass=0;pass<2&&c<0;pass++){if(pass===0&&!bb)continue;
      if(key.length>=6){for(var i=0;i<items.length;i++){var it=items[i],y=it.transform[5];if(pass===0&&(y<bb.y-2||y>bb.y+bb.h+2))continue;
        var s2=norm(it.str);if(s2.length<6)continue;var L=Math.min(12,s2.length,key.length);
        if(s2.slice(0,L)===key.slice(0,L)){var x=it.transform[4]+(it.width||0)/2;c=x<info.sx?0:1;break}}}}
    if(c<0)c=last;cols.push(c);last=c;cnt[c]++});
  if(!cnt[0]||!cnt[1])return null;
  var ysA=items.map(function(it){return it.transform[5]}),yT=Math.max.apply(null,ysA),yB=Math.min.apply(null,ysA),sp2=Math.max(1,yT-yB),lx0=Infinity,rx1=-Infinity;
  items.forEach(function(it){var y=it.transform[5];if(y>yT-sp2*0.08||y<yB+sp2*0.08)return;var a=it.transform[4],b=a+(it.width||0);if((a+b)/2<info.sx)lx0=Math.min(lx0,a);else rx1=Math.max(rx1,b)});
  return {sx:info.sx,cols:cols,lx0:isFinite(lx0)?lx0:0,rx1:isFinite(rx1)?rx1:W}}
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
      var pl={p:p,pg:pg,vp:vp,box:box,angle:angle,zh:zh,bbs:bbs,note:note,col:null};
      if(!note&&angle===0&&bpColumns())pl.col=await _pageColumns(pg,vp.width,pageTextCache[p]||[],zh.length,bbs);
      plans.push(pl);if(angle===0){idx.push(p-1);if(pl.col)idx.push(p-1)}}
    // 一次复制整本，页面之间共用字体和图片（按栏拆的页复制两份，资源仍共用）
    var copied=await out.copyPages(src,idx),ci=0;
    // 复制来的页如果和另一份共用内容列表或批注列表，先各自拆开，免得往一份里加东西另一份也跟着变
    var isolate=function(page){['Contents','Annots'].forEach(function(k){var v=page.node.get(PN.of(k));if(v instanceof lib.PDFRef){var o=ctx.lookup(v);if(o instanceof lib.PDFArray)page.node.set(PN.of(k),o.clone(ctx))}})};
    // 只保留落在 [x0,x1] 里的原页批注
    var keepAnnots=function(page,x0,x1){var A=page.node.Annots();if(!A)return;var keep=[];
      for(var i=0;i<A.size();i++){var an=ctx.lookup(A.get(i));var R=an&&an.get&&ctx.lookup(an.get(PN.of('Rect')));
        if(!R||!R.asArray){keep.push(A.get(i));continue}var r=R.asArray().map(function(n){return n.asNumber?n.asNumber():0});var cx=(r[0]+r[2])/2;if(cx>=x0&&cx<=x1)keep.push(A.get(i))}
      page.node.set(PN.of('Annots'),ctx.obj(keep))};
    // 把一组段落的译文排进 [tx,ty,tw,th] 这块区域；放不下就加“续”页（大小 contSize）
    var drawTrans=function(page,tx,ty,tw,th,list,contSize,contTitle,contSplit){
      if(contSplit==null)contSplit=contSize[0]/2;
      var m=Math.max(14,tw*0.06),x0=tx+m,colW=tw-2*m,top=th-m,bot=m;
      var base=bpFontSize()*Math.min(1.15,Math.max(0.85,tw/595)),minFs=Math.max(7.5,base-3.5),fs=base,plan=null;
      // 排一遍：每段放在原文的高度，上一段挤下来就往下让
      var layout=function(sz){var lh=sz*1.38,gap=sz*0.5,cursor=top,items=[],over=[];// v55：行距 1.38 倍
        list.forEach(function(pa){var lines=_wrap(pa.t,font,sz,colW);var want=pa.anchor!=null?Math.min(top,pa.anchor):cursor;var y=Math.min(cursor,want);
          lines.forEach(function(l){if(y-sz<bot){over.push({l:l,fail:pa.fail});return}items.push({l:l,y:y-sz,fail:pa.fail});y-=lh});
          cursor=y-gap});
        return {items:items,over:over,sz:sz}};
      for(fs=base;fs>=minFs;fs-=0.5){plan=layout(fs);if(!plan.over.length)break}
      if(plan.over.length)plan=layout(minFs);
      plan.items.forEach(function(it){page.drawText(it.l,{x:x0,y:ty+it.y,size:plan.sz,font:font,color:it.fail?MUTE:INK})});
      var rest=plan.over;
      while(rest.length){var cp=out.addPage(contSize);var half=contSplit;cp.drawLine({start:{x:half,y:0},end:{x:half,y:contSize[1]},thickness:0.6,color:LINE});
        cp.drawText(contTitle,{x:m,y:contSize[1]-m,size:9,font:font,color:MUTE});
        var y=top,next=[],lh=plan.sz*1.38;
        rest.forEach(function(r){if(y-plan.sz<bot){next.push(r);return}cp.drawText(r.l,{x:half+m,y:y-plan.sz,size:plan.sz,font:font,color:r.fail?MUTE:INK});y-=lh});
        if(next.length===rest.length)break;rest=next}};
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
        var anchors=useBB?pl.bbs.map(function(bb){return bb.y-yOff+bb.h}):[];
        // 小宝：bbox 记录的是原 PDF 坐标；旋转页用文字四角映射到显示坐标
        if(useBB&&angle){var tc=await pg.getTextContent();
          anchors=pl.bbs.map(function(bb){var topY=Infinity;
            tc.items.forEach(function(it){var t=it.transform;if(!it.str||!t||t[5]<bb.y-1||t[5]>bb.y+bb.h+1)return;
              var a=Math.atan2(t[1],t[0]),dx=Math.cos(a)*it.width,dy=Math.sin(a)*it.width,hx=-Math.sin(a)*it.height,hy=Math.cos(a)*it.height;
              [[t[4],t[5]],[t[4]+dx,t[5]+dy],[t[4]+hx,t[5]+hy],[t[4]+dx+hx,t[5]+dy+hy]].forEach(function(pt){topY=Math.min(topY,vp.convertToViewportPoint(pt[0],pt[1])[1])})});
            return isFinite(topY)?H-topY:null})}
        paras=pl.zh.map(function(t,i){var fail=String(t||'').indexOf('__TRANSFAIL__')===0;return {t:fail?'〔本段翻译失败〕':String(t||''),fail:fail,anchor:useBB?anchors[i]:null,i:i}})}
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
          drawTrans(page,cx0+cw,oy,tw,H,paras.filter(function(pa){return pl.col.cols[pa.i]===c}),[sw,H],'第 '+p+' 页'+(c?'右栏':'左栏')+'（续）',cw);
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
        else drawTrans(page,ox+W,oy,W,H,paras,[W*2,H],'第 '+p+' 页（续）');
        addHighlights(page,p,W,H,ox,oy,null,null)}
      if(p%5===0)await Promise.resolve();// 后台不用计时器让出
    }
    var bytes=await out.save();
    return bytes;
  }finally{_bpBusy=false}}
