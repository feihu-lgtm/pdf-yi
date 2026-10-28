// 本文件由 coreport/assemble.py 从全量版 pdf-reader-v54.html 原样移植生成，逻辑与全量版一致。
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
// 生成双栏 PDF，返回文件内容（Uint8Array）。没翻的页、读不出字的页，右边写 _pageNotes 里的原因
async function buildBilingualPdf(){
  if(!pdfDoc||!rawPdfBytes)throw new Error('没有打开 PDF');
  _bpBusy=true;
  try{
    var lib=await loadPdfLib(),fk=await loadFontkit(),fb=await loadCjkFont();
    var src=await lib.PDFDocument.load(rawPdfBytes,{ignoreEncryption:true});
    var out=await lib.PDFDocument.create();out.registerFontkit(fk);
    var font=await out.embedFont(fb,{subset:true});
    var sp=src.getPages(),N=sp.length;
    // v54：一次复制整本，页面之间共用字体和图片（逐页嵌入会把共用资源每页复制一份，文件大好几倍）
    var copied=await out.copyPages(src,sp.map(function(_,i){return i}));
    var INK=lib.rgb(0.16,0.11,0.22),MUTE=lib.rgb(0.55,0.5,0.62),LINE=lib.rgb(0.82,0.78,0.9);
    for(var p=1;p<=N;p++){
      // 小宝：按 pdf.js 的显示边界（裁剪盒）嵌入原页，按 /Rotate 转过来再放
      var pg=await pdfDoc.getPage(p),vp=pg.getViewport({scale:1}),box=pg.view,angle=((pg.rotate%360)+360)%360;
      var W=vp.width,H=vp.height,yOff=box[1],ox=0,oy=0,page;
      if(angle===0){
        // 没旋转：直接用复制来的原页，把页面向右加宽一倍，右半边铺白底再写译文；原页的链接和批注都留着
        page=out.addPage(copied[p-1]);ox=box[0];oy=box[1];
        page.setMediaBox(ox,oy,W*2,H);page.setCropBox(ox,oy,W*2,H);
        try{page.setTrimBox(ox,oy,W*2,H);page.setBleedBox(ox,oy,W*2,H);page.setArtBox(ox,oy,W*2,H)}catch(e){}
        page.drawRectangle({x:ox+W,y:oy,width:W,height:H,color:lib.rgb(1,1,1)});
      }else{
        // 旋转过的页：小宝的办法，按裁剪盒嵌入再转正
        var ep=await out.embedPage(sp[p-1],{left:box[0],bottom:box[1],right:box[2],top:box[3]});
        page=out.addPage([W*2,H]);page.drawPage(ep,{x:angle===180||angle===270?W:0,y:angle===90||angle===180?H:0,rotate:lib.degrees(-angle)});
      }
      page.drawLine({start:{x:ox+W,y:oy},end:{x:ox+W,y:oy+H},thickness:0.6,color:LINE});
      var m=Math.max(18,W*0.06),x0=W+m,colW=W-2*m,top=H-m,bot=m;
      page.drawText(String(p),{x:ox+W*2-m,y:oy+H-m*0.6,size:7,font:font,color:MUTE});
      var zh=memCache[p],bbs=(pageBboxCache[p]&&pageBboxCache[p].bboxes)||[];
      var note=null;
      if(!zh||!zh.length){note=_pageNotes[p]||'这一页还没有翻译。'}
      if(note){_wrap(note,font,9,colW).forEach(function(l,i){page.drawText(l,{x:ox+x0,y:oy+top-9-i*13,size:9,font:font,color:MUTE})})}
      else{
        var paras=zh.map(function(t){var fail=String(t||'').indexOf('__TRANSFAIL__')===0;return {t:fail?'〔本段翻译失败〕':String(t||''),fail:fail}});
        var useBB=bbs.length===paras.length;
        // 小宝：bbox 记录的是原 PDF 坐标；旋转页用文字四角映射到显示坐标
        var anchors=useBB?bbs.map(function(bb){return bb.y-yOff+bb.h}):[];
        if(useBB&&angle){var tc=await pg.getTextContent();
          anchors=bbs.map(function(bb){var topY=Infinity;
            tc.items.forEach(function(it){var t=it.transform;if(!it.str||!t||t[5]<bb.y-1||t[5]>bb.y+bb.h+1)return;
              var a=Math.atan2(t[1],t[0]),dx=Math.cos(a)*it.width,dy=Math.sin(a)*it.width,hx=-Math.sin(a)*it.height,hy=Math.cos(a)*it.height;
              [[t[4],t[5]],[t[4]+dx,t[5]+dy],[t[4]+hx,t[5]+hy],[t[4]+dx+hx,t[5]+dy+hy]].forEach(function(pt){topY=Math.min(topY,vp.convertToViewportPoint(pt[0],pt[1])[1])})});
            return isFinite(topY)?H-topY:top})}
        // v45：按设置的字号排，按页宽微调（A4 宽为 1 倍）；最多比设定小 3.5pt，再放不下就加续页
        var base=bpFontSize()*Math.min(1.15,Math.max(0.85,W/595)),minFs=Math.max(7.5,base-3.5),fs=base,plan=null;
        // 排一遍：每段放在原文的高度，上一段挤下来就往下让
        var layout=function(sz){var lh=sz*1.5,gap=sz*0.6,cursor=top,items=[],over=[];
          paras.forEach(function(pa,i){var lines=_wrap(pa.t,font,sz,colW);var want=useBB?Math.min(top,anchors[i]):cursor;var y=Math.min(cursor,want);
            lines.forEach(function(l){if(y-sz<bot){over.push({l:l,fail:pa.fail});return}items.push({l:l,y:y-sz,fail:pa.fail});y-=lh});
            cursor=y-gap});
          return {items:items,over:over,sz:sz}};
        for(fs=base;fs>=minFs;fs-=0.5){plan=layout(fs);if(!plan.over.length)break}
        if(plan.over.length)plan=layout(minFs);
        plan.items.forEach(function(it){page.drawText(it.l,{x:ox+x0,y:oy+it.y,size:plan.sz,font:font,color:it.fail?MUTE:INK})});
        // 放不下的：加一页“续”
        var rest=plan.over;
        while(rest.length){var cp=out.addPage([W*2,H]);cp.drawLine({start:{x:W,y:0},end:{x:W,y:H},thickness:0.6,color:LINE});
          cp.drawText('第 '+p+' 页（续）',{x:m,y:H-m,size:9,font:font,color:MUTE});
          var y=top,next=[],lh=plan.sz*1.5;
          rest.forEach(function(r){if(y-plan.sz<bot){next.push(r);return}cp.drawText(r.l,{x:x0,y:y-plan.sz,size:plan.sz,font:font,color:r.fail?MUTE:INK});y-=lh});
          if(next.length===rest.length)break;rest=next}
      }
      // 批注：写成真正的 PDF 批注，放在左半边原文上
      var hls=highlights.filter(function(h){return h.pageNum===p});
      if(hls.length){var ce=document.querySelector('#pdf-wrap-'+p+' canvas'),cssW=ce?parseFloat(ce.style.width):0,cssH=ce?parseFloat(ce.style.height):0;
        if(cssW&&cssH){var sX=W/cssW,sY=H/cssH,refs=[],ctx=out.context,PN=lib.PDFName,PS=lib.PDFString,PNum=lib.PDFNumber;
          hls.forEach(function(hl){var hex=hl.pdfColor||'FFE84D',r=parseInt(hex.slice(0,2),16)/255,g=parseInt(hex.slice(2,4),16)/255,b=parseInt(hex.slice(4,6),16)/255;
            var qp=[],mnX=Infinity,mnY=Infinity,mxX=-Infinity,mxY=-Infinity;
            hl.rects.forEach(function(rc){var X0=ox+rc.x*sX,Y0=oy+H-(rc.y+rc.h)*sY,X1=X0+rc.w*sX,Y1=Y0+rc.h*sY;qp.push(X0,Y1,X1,Y1,X0,Y0,X1,Y0);mnX=Math.min(mnX,X0);mnY=Math.min(mnY,Y0);mxX=Math.max(mxX,X1);mxY=Math.max(mxY,Y1)});
            if(!qp.length)return;
            refs.push(ctx.register(ctx.obj({Type:PN.of('Annot'),Subtype:PN.of('Highlight'),Rect:ctx.obj([mnX,mnY,mxX,mxY]),QuadPoints:ctx.obj(qp),
              Contents:lib.PDFHexString.fromText(hl.note||String(hl.text||'').slice(0,300)),T:lib.PDFHexString.fromText('PDF译'),C:ctx.obj([r,g,b]),CA:PNum.of(0.45),F:PNum.of(4)})))});
          // 原页自带的批注（链接等）保留，新的接在后面
          if(refs.length){var exA=page.node.Annots();if(exA)refs.forEach(function(r){exA.push(r)});else page.node.set(PN.of('Annots'),ctx.obj(refs))}}}
      if(p%5===0)await Promise.resolve();// 后台不用计时器让出
    }
    var bytes=await out.save();
    return bytes;
  }finally{_bpBusy=false}}
