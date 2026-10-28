import base64, json, sys
from playwright.sync_api import sync_playwright
pdf=sys.argv[1]; pages=[int(x) for x in sys.argv[2].split(',')]
b64=base64.b64encode(open(pdf,'rb').read()).decode()
# 最坏情况：假设模型把一整页合成一个段落，看版面细分能不能切回来
JS="""async(a)=>{var raw=Uint8Array.from(atob(a.b64),c=>c.charCodeAt(0));
 pdfDoc=await pdfjsLib.getDocument({data:raw,cMapUrl:PDF_CMAP_URL,cMapPacked:true}).promise;totalPages=pdfDoc.numPages;_rawCache={};_carryP={};_runningP=null;cleanRules=null;
 var out={};for(const p of a.pages){var pr=await prepOf(p),L=pr.rawLines,all=[];L.forEach((t,i)=>{if(String(t).trim())all.push(i)});
   var G=_refineGroups([all],L);out[p]=G.map(g=>_jnAll(g.map(i=>L[i])).replace(/\\s+/g,' ').trim()).map(t=>[t.length,t.slice(0,60)])}return out}"""
with sync_playwright() as pw:
    b=pw.chromium.launch(); pg=b.new_page()
    pg.route('**/*',lambda r:r.continue_() if r.request.url.startswith('http://127.0.0.1:3427') else r.abort())
    pg.goto('http://127.0.0.1:3427/index.html'); pg.wait_for_timeout(800)
    res=pg.evaluate(JS,{'b64':b64,'pages':pages}); b.close()
for p in res:
    print(f'第{p}页：整页当一段交给细分 → {len(res[p])} 段')
    for n,t in res[p]: print(f'   {n:5d} | {t}')
