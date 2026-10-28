import re, json, os, sys
READER = '/mnt/user-data/outputs/pdf-reader-v52.html'
OUT = '/home/claude/build/www/core'
os.makedirs(OUT, exist_ok=True)
s = open(READER, encoding='utf-8').read(); js = s[s.index('<script>\n'):]

def fn(name):
    m = re.search(r'(?m)^[ \t]*(async\s+)?function\s+' + re.escape(name) + r'\s*\(', js)
    assert m, name
    i = m.start(); d = 0; j = js.index('{', i)
    for t in range(j, len(js)):
        if js[t] == '{': d += 1
        elif js[t] == '}':
            d -= 1
            if d == 0: return js[i:t+1].strip()
def line(prefix):
    m = re.search(r'(?m)^' + re.escape(prefix) + r'[^\n]*', js); assert m, prefix; return m.group(0)
def take(*names): return '\n'.join(fn(n) for n in names)
HEAD = '// 本文件由 coreport/assemble.py 从全量版 pdf-reader-v52.html 原样移植生成，逻辑与全量版一致。\n'

# ── textutil.js：纯文字处理，不碰页面 ──
textutil = HEAD + '''// 文字工具：拼接、康熙部首、上标、分栏、句末判断、断行。全部是纯函数。
var VENDOR=window.PDFYI_VENDOR||'vendor/';
''' + '\n'.join([line('var _TERM='), line('var _ABBR='), line('var _ROMAN='), line('var _CJKEND='), line('var _BREAK_TOK='), line('var _NO_START=')]) + '\n' + take(
    '_kangxi', '_jn', '_jnAll', '_isZhPara', '_isPageNo', 'pageTextQuality', '_colOrder', 'extractParas', 'groupsToBboxes',
    '_lines', '_normLine', '_headingLike', '_sentEnd', 'groupRaw', 'getMsgContent', 'getFinishReason', '_wrap') + '\n'
open(OUT + '/textutil.js', 'w', encoding='utf-8').write(textutil)

# ── store.js：缓存（和全量版同一个数据库、同样的键） ──
store = HEAD + '''// 缓存：IndexedDB “PDFTransCache”，pages 存译文（:p页号）和原文分段（:en页号），annotations 存清理规则（:clean）。
var cacheDB=null;
''' + take('openCacheDB', 'idbGet', 'idbSet') + '\n'
open(OUT + '/store.js', 'w', encoding='utf-8').write(store)

# ── extract.js：一本书的提取状态 + 页眉页脚、脚注、跨页补句 ──
extract = HEAD + '''// 提取：每页的原始行（pdf.js）、页眉页脚识别、脚注区、跨页补句。
// 下面这些是“当前这本书”的状态，后台引擎每开一本书就重置一次（见 worker.js 的 resetBook）。
var pdfDoc=null,rawPdfBytes=null,totalPages=0,cacheKey='';
var pageTextCache={},pageBboxCache={},memCache={},savedEnCache={},cachedAtLoad={},carryMark={},cleanRules=null;
var _rawCache={},_carryP={},_runningP=null,_runningEx={};
''' + take('rawOf', 'detectRunningLines', '_ruleHit', 'isRunningLine', 'bodyLines', '_dropFootnotes', '_continued', 'carryOf', 'prepOf',
           'validateCleanRules', 'autoCleanRules') + '\n'
open(OUT + '/extract.js', 'w', encoding='utf-8').write(extract)

# ── translate.js：调 Magpie（重试、错开）、合并段落、翻译 ──
a = js.index('// ══ v36：发给模型的请求统一重试一次'); b = js.index('function rateLimitDelay(){', a)
retry = js[a:b].strip()
translate = HEAD + '''// 翻译：只走 Magpie。配置和全量版共用同一份浏览器存储（端点、模型）。
var activeModel='magpie';
function getMagpieUrl(){var e='';try{e=(localStorage.getItem('pdfyi_magpie_endpoint')||'').trim()}catch(x){}var u=(e||'http://127.0.0.1:3426/v1').replace(/\\/+$/,'');
  if(u.endsWith('/chat/completions'))return u;if(u.endsWith('/v1'))return u+'/chat/completions';return u+'/v1/chat/completions'}
function getMagpieModel(){var m='',c='';try{m=localStorage.getItem('pdfyi_magpie_model')||'';c=(localStorage.getItem('pdfyi_magpie_model_custom')||'').trim()}catch(x){}
  if(m==='__custom__')return c||'auto/gemini-3.8-flash';return m||'auto/gemini-3.8-flash'}
function getKey(){return 'sk-antigravity'}
''' + retry + '\n' + take('aiMergeLines', 'apiBatch') + r'''
// 翻译一页：中文段落原样保留；按字数分批（约 3000 字符、最多 24 段）；没翻好的对半拆开重翻，最多三层
async function translatePage(p,paras,onBatch){
  var apiKey=getKey(),BUDGET=3000,MAXN=24,results=new Array(paras.length),need=[],ck0=cacheKey;
  paras.forEach(function(t,i){if(_isZhPara(t))results[i]=t;else need.push(i)});
  var batches=[],cur=[],len=0;
  need.forEach(function(k){var L=String(paras[k]).length;if(cur.length&&(len+L>BUDGET||cur.length>=MAXN)){batches.push(cur);cur=[];len=0}cur.push(k);len+=L});
  if(cur.length)batches.push(cur);
  var SPLITTABLE=/输出被截断|未匹配到译文|模型返回空内容|结果缺失/;
  var runIds=async function(ids,depth){
    var t=await apiBatch(apiKey,ids.map(function(k){return paras[k]}),p);
    if(cacheKey!==ck0)return false;
    var redo=[];
    ids.forEach(function(k,j){var r=(t&&t[j])!==undefined?t[j]:'__TRANSFAIL__结果缺失（批次未返回）';
      if(typeof r==='string'&&r.indexOf('__TRANSFAIL__')===0&&SPLITTABLE.test(r)&&ids.length>1&&depth<3)redo.push(k);else results[k]=r});
    if(redo.length){addTransLog(p,'',ids.length+' 段里有 '+redo.length+' 段没翻好，拆开重翻（第 '+(depth+1)+' 层）',activeModel,'翻译',false);
      var h=Math.ceil(redo.length/2);
      if(await runIds(redo.slice(0,h),depth+1)===false)return false;
      if(redo.length>h&&await runIds(redo.slice(h),depth+1)===false)return false}
    return true};
  for(var bi=0;bi<batches.length;bi++){if(await runIds(batches[bi],0)===false)return null;if(onBatch)onBatch()}
  for(var ri=0;ri<paras.length;ri++)if(results[ri]===undefined)results[ri]='__TRANSFAIL__结果缺失（批次未返回）';
  return results}
'''
open(OUT + '/translate.js', 'w', encoding='utf-8').write(translate)

# ── bilingual.js：生成双栏 PDF（从全量版 exportBilingualPdf 移植，存盘交给调用方） ──
ex = fn('exportBilingualPdf')
def rp(old, new):
    global ex
    assert ex.count(old) == 1, old[:80]; ex = ex.replace(old, new)
rp('async function exportBilingualPdf(auto){', '// 生成双栏 PDF，返回文件内容（Uint8Array）。没翻的页、读不出字的页，右边写 _pageNotes 里的原因\nasync function buildBilingualPdf(){')
rp("  if(!pdfDoc||!rawPdfBytes){if(!auto)toast('双栏 PDF 目前只支持 PDF 文件','err');return}\n", "  if(!pdfDoc||!rawPdfBytes)throw new Error('没有打开 PDF');\n")
rp("  if(_bpBusy)return;_bpBusy=true;trayPush();\n", "  _bpBusy=true;\n")
rp("    toast(auto?'翻完了，正在生成双栏 PDF…':'正在生成双栏 PDF…','ok');setProgress(5);\n", "")
rp("var zp=$('zh-page-'+p),un=zp&&zp.querySelector('.zh-unread,.zh-skip');note=un?un.textContent.replace(/^⚠\\s*/,''):'这一页还没有翻译。'",
   "note=_pageNotes[p]||'这一页还没有翻译。'")
rp("      if(p%5===0){setProgress(5+90*p/N);await new Promise(function(r){setTimeout(r,0)})}", "      if(p%5===0)await new Promise(function(r){setTimeout(r,0)});")
m = re.search(r"    var _bn=[^\n]*\n    var ok=[^\n]*\n    if\(ok&&!window.__TAURI__\)toast\([^\n]*\n", ex); assert m
ex = ex[:m.start()] + "    return bytes;\n" + ex[m.end():]
rp("  }catch(e){console.error(e);toast('双栏 PDF 没生成：'+(e.message||e),'err')}\n  finally{_bpBusy=false;setProgress(0);trayDone()}}", "  }finally{_bpBusy=false}}")
bilingual = HEAD + '''// 双栏 PDF：左边原页（矢量，按裁剪盒和 /Rotate 转正），右边译文按原文高度对齐、放不下缩字号或加续页。
var PDFLib=null,_fontkitP=null,_cjkFontP=null,_bpBusy=false,highlights=[],_pageNotes={};
function pickFontFile(){return Promise.reject(new Error('找不到中文字体文件 vendor/fonts/NotoSansSC-Sub.ttf'))}
''' + take('_loadScript', 'loadPdfLib', 'loadFontkit', 'loadCjkFont', 'bpFontSize') + '\n' + ex + '\n'
open(OUT + '/bilingual.js', 'w', encoding='utf-8').write(bilingual)

for f in sorted(os.listdir(OUT)):
    print(f, sum(1 for _ in open(OUT + '/' + f, encoding='utf-8')), '行')
