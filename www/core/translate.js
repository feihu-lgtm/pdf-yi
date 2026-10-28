// 本文件由 coreport/assemble.py 从全量版 pdf-reader-v55.html 原样移植生成，逻辑与全量版一致。
// 翻译：只走 Magpie。配置和全量版共用同一份浏览器存储（端点、模型）。
var activeModel='magpie';
function getMagpieUrl(){var e='';try{e=(localStorage.getItem('pdfyi_magpie_endpoint')||'').trim()}catch(x){}var u=(e||'http://127.0.0.1:3426/v1').replace(/\/+$/,'');
  if(u.endsWith('/chat/completions'))return u;if(u.endsWith('/v1'))return u+'/chat/completions';return u+'/v1/chat/completions'}
function getMagpieModel(){var m='',c='';try{m=localStorage.getItem('pdfyi_magpie_model')||'';c=(localStorage.getItem('pdfyi_magpie_model_custom')||'').trim()}catch(x){}
  if(m==='__custom__')return c||'auto/gemini-3.8-flash';return m||'auto/gemini-3.8-flash'}
function getKey(){return 'sk-antigravity'}
// ══ v36：发给模型的请求统一重试一次（5xx / 超时 / 网络错误 / 返回不是完整 JSON） ══
(function(){
  var _f=window.fetch.bind(window);
  function isLLM(u,o){var url=String((u&&u.url)||u||'');return !!o&&String(o.method||'').toUpperCase()==='POST'&&/chat\/completions|chatcompletion_v2/.test(url)}
  // 把读出来的正文重新包成响应交给调用方；个别环境没有 Response 时用一个简单对象代替
  function mk(t,r){if(typeof Response==='function')return new Response(t,{status:r.status,statusText:r.statusText,headers:r.headers});
    return {ok:r.status>=200&&r.status<300,status:r.status,statusText:r.statusText||'',headers:r.headers,text:function(){return Promise.resolve(t)},json:function(){return Promise.resolve().then(function(){return JSON.parse(t)})}}}
  function errMsg(t){try{var j=JSON.parse(t);if(j&&j.error)return j.error.message||JSON.stringify(j.error)}catch(e){}return String(t||'').slice(0,200)}
  var _nextSlot=0;// v48：发给模型的请求之间至少隔 200 毫秒
  window.fetch=async function(u,o){
    if(!isLLM(u,o))return _f(u,o);
    var now=Date.now(),wait=Math.max(0,_nextSlot-now);_nextSlot=Math.max(now,_nextSlot)+200;
    if(wait&&!window.PDFYI_WORKER)await new Promise(function(res){setTimeout(res,wait)});// 后台引擎里不等：看不见的窗口计时器可能被冻结
    var why='';
    for(var attempt=1;attempt<=2;attempt++){
      var own=null,tm=null,opts=o;
      if(!o.signal){own=new AbortController();tm=setTimeout(function(){own.abort()},180000);opts=Object.assign({},o,{signal:own.signal})}
      try{
        var r=await _f(u,opts);
        var t=await r.text();
        if(r.status>=500){why='HTTP '+r.status+' '+errMsg(t)}
        else if(r.ok){try{JSON.parse(t);return mk(t,r)}catch(e){why='返回的不是完整的 JSON（'+t.length+' 字）'}}
        else return mk(t,r);
        if(attempt===2){addTransLog('?','',why+'，重试后仍失败',activeModel,'重试',false);
          if(r.status>=500)return mk(t,r);
          throw new Error(why)}
      }catch(e){
        if(o.signal&&o.signal.aborted)throw e;// 调用方自己取消的，不重试
        if(attempt===2){if(why&&e.message===why)throw e;why=(e&&e.name==='AbortError')?'超时（180 秒）':'网络错误 '+((e&&e.message)||e);addTransLog('?','',why+'，重试后仍失败',activeModel,'重试',false);throw new Error(why)}
        why=(e&&e.name==='AbortError')?'超时（180 秒）':'网络错误 '+((e&&e.message)||e);
      }finally{if(tm)clearTimeout(tm)}
      addTransLog('?','',why+'，1 秒后重试一次',activeModel,'重试',false);
      if(!window.PDFYI_WORKER)await new Promise(function(res){setTimeout(res,1000)});// 后台引擎里直接重试，不等计时器
    }
  };
})();
async function aiMergeLines(rawLines,apiKey){
  // 过滤掉纯空行，编号，送AI
  var numbered=[];var lineMap=[];
  for(var i=0;i<rawLines.length;i++){
    if(rawLines[i].trim()){numbered.push('['+(numbered.length+1)+'] '+rawLines[i]);lineMap.push(i)}}
  if(numbered.length===0)return[];
  if(numbered.length===1)return[rawLines[lineMap[0]]];
  var prompt='Below are numbered text lines extracted from a PDF page.\n'
    +'Your task: group consecutive lines that belong to the same paragraph.\n'
    +'Rules:\n'
    +'- A line break is a SOFT WRAP (same paragraph) if the previous line does not end a sentence and the text flows naturally.\n'
    +'- A line break is a PARAGRAPH BREAK if: (1) previous line ends with sentence-ending punctuation AND next line starts a new thought, OR (2) there is a clear topic/section shift.\n'
    +'- Short lines like headings, figure captions, or standalone labels are their own paragraph.\n'
    +'Return ONLY a JSON array of arrays, where each inner array contains the line numbers belonging to one paragraph.\n'
    +'Example: [[1,2,3],[4],[5,6,7,8]]\n'
    +'No explanation, no markdown, only the JSON.\n\n'
    +numbered.join('\n');
  try{
    var url,body;
    if(activeModel==='magpie'){url=getMagpieUrl();body={model:getMagpieModel(),messages:[{role:'user',content:prompt}],temperature:0,max_tokens:10000}}
    else if(activeModel==='deepseek'){url='https://api.deepseek.com/v1/chat/completions';body=Object.assign({model:getModelName('deepseek'),messages:[{role:'user',content:prompt}],temperature:0,max_tokens:8192},getThinkingParams('deepseek'))}
    else if(activeModel==='minimax'){url='https://api.minimax.io/v1/text/chatcompletion_v2';body={model:getModelName('minimax'),messages:[{role:'user',content:prompt}],temperature:0,max_tokens:8192}}
    else if(activeModel==='openai'){url=getOpenAIUrl();body={model:getOpenAIModel(),messages:[{role:'user',content:prompt}],temperature:0,max_tokens:10000}}
    var ck=apiKey.replace(/[^\x20-\x7E]/g,'').trim();var blob=new Blob([JSON.stringify(body)],{type:'application/json'});var h=new Headers();h.append('Authorization','Bearer '+ck);
    var resp=await fetch(url,{method:'POST',headers:h,body:blob});
    if(!resp.ok)throw new Error('api '+resp.status);
    var data=await resp.json();var raw=getMsgContent(data); addTransLog('?',body.messages[0].content,raw,activeModel,'合并',true);
    var clean=raw.replace(/```[a-z]*\n?/g,'').trim();
    var a0=clean.indexOf('['),a1=clean.lastIndexOf(']');
    if(a0<0||a1<=a0)throw new Error('no json array');
    var groups=JSON.parse(clean.slice(a0,a1+1));
    if(!Array.isArray(groups))throw new Error('bad json');
    // v33：校验覆盖——任何一行没被分进组，整页回退规则分段，避免静默丢句
    var covered={};groups.forEach(function(g){if(Array.isArray(g))g.forEach(function(n){n=parseInt(n);if(n>=1&&n<=numbered.length)covered[n]=1})});
    if(Object.keys(covered).length<numbered.length)throw new Error('合并结果遗漏 '+(numbered.length-Object.keys(covered).length)+' 行');
    var result=[],idxGroups=[];
    groups.forEach(function(g){
      if(!Array.isArray(g)||g.length===0)return;
      var idxs=g.map(function(n){return lineMap[parseInt(n)-1]}).filter(function(x){return x!==undefined});
      var parts=idxs.map(function(i){return rawLines[i]||''}).filter(Boolean);
      var merged=_jnAll(parts).replace(/\s+/g,' ').trim();
      if(merged.length>2){result.push(merged);idxGroups.push(idxs)}});
    result._idx=idxGroups;
    return result.length>0?result:null;// null → fallback到规则结果
  }catch(e){console.warn('aiMergeLines failed:',e.message);return null}}
async function apiBatch(apiKey,texts,pageNum){
  pageNum=pageNum===undefined?'?':pageNum;
  var FAIL='__TRANSFAIL__',myKey=cacheKey;
  var n=texts.length;var prompt='Translate the following '+n+' English paragraphs to Simplified Chinese.\nReturn EXACTLY '+n+' translations numbered [1][2] etc.\nOnly return the translations.\n\n'+texts.map(function(t,i){return '['+(i+1)+'] '+t}).join('\n\n');
  try{var url,body;
    if(activeModel==='magpie'){url=getMagpieUrl();body={model:getMagpieModel(),messages:[{role:'user',content:prompt}],temperature:.3,max_tokens:8192}}
    else if(activeModel==='deepseek'){url='https://api.deepseek.com/v1/chat/completions';body=Object.assign({model:getModelName('deepseek'),messages:[{role:'user',content:prompt}],temperature:.3,max_tokens:8192},getThinkingParams('deepseek'))}
    else if(activeModel==='minimax'){url='https://api.minimax.io/v1/text/chatcompletion_v2';body={model:getModelName('minimax'),messages:[{role:'user',content:prompt}],temperature:.3,max_tokens:8192}}
    else if(activeModel==='openai'){url=getOpenAIUrl();body={model:getOpenAIModel(),messages:[{role:'user',content:prompt}],temperature:.3,max_tokens:8192}}
    var ck=apiKey.replace(/[^\x20-\x7E]/g,'').trim();var blob=new Blob([JSON.stringify(body)],{type:'application/json'});var h=new Headers();h.append('Authorization','Bearer '+ck);
    var resp=await fetch(url,{method:'POST',headers:h,body:blob});
    if(cacheKey!==myKey)return [];
    if(!resp.ok){var err=await resp.json().catch(function(){return{}});if(cacheKey!==myKey)return [];var emsg=err.error&&err.error.message?err.error.message:('HTTP '+resp.status);toast('API error: '+emsg,'err');setStatus('error');addTransLog(pageNum,prompt,emsg,activeModel,'翻译',false);return texts.map(function(){return FAIL+emsg})}
    var data=await resp.json();if(cacheKey!==myKey)return [];var raw=getMsgContent(data); addTransLog(pageNum,body.messages[0].content,raw,activeModel,'翻译',true);
    var results=[];for(var i=0;i<texts.length;i++){var m=raw.match(new RegExp('\\['+(i+1)+'\\]\\s*([\\s\\S]*?)(?=\\s*\\['+(i+2)+'\\]|$)'));results.push(m&&m[1]?m[1].trim():FAIL+(raw?'未匹配到译文（模型返回格式异常）':'模型返回空内容'))}
    if(getFinishReason(data)==='length'){var li=-1;for(var k=results.length-1;k>=0;k--){if(results[k].indexOf(FAIL)!==0){li=k;break}}
      if(li>=0)results[li]=FAIL+'输出被截断（finish_reason=length）'}
    return results}catch(e){if(cacheKey!==myKey)return [];toast('请求失败: '+e.message,'err');setStatus('error');addTransLog(pageNum,prompt,e.message,activeModel,'翻译',false);return texts.map(function(){return FAIL+e.message})}}
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
