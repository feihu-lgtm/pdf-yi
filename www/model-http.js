// Native model transport must load before the reader/core retry wrappers.
// Without Tauri, leave browser fetch (including the lightweight edition) untouched.
(function(){
  'use strict';
  var T=window.__TAURI__;
  if(!T||!T.core||typeof T.core.invoke!=='function'||window.PDFYI_NATIVE_HTTP)return;
  var browserFetch=window.fetch.bind(window);
  function isModel(input,init){
    var url;
    try{url=new URL((input&&input.url)||String(input),window.location.href)}catch(e){return false}
    var method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
    return /^https?:$/.test(url.protocol)&&
      ((method==='POST'&&/\/(?:chat\/completions|chatcompletion_v2)\/?$/i.test(url.pathname))||
       (method==='GET'&&/\/models\/?$/i.test(url.pathname)));
  }
  function abortError(){return new DOMException('The operation was aborted.','AbortError')}
  window.fetch=function(input,init){
    if(!isModel(input,init))return browserFetch(input,init);
    return Promise.resolve().then(function(){
      // Request normalizes Headers, Blob content types and string bodies just as fetch does.
      var request=new Request(input,init),signal=request.signal;
      if(signal.aborted)throw abortError();
      return new Promise(function(resolve,reject){
        var finished=false;
        function finish(error,response){
          if(finished)return;
          finished=true;signal.removeEventListener('abort',onAbort);
          if(error)reject(error);else resolve(response);
        }
        function onAbort(){finish(abortError())}
        signal.addEventListener('abort',onAbort,{once:true});
        Promise.resolve().then(async function(){
          var headers=[];
          request.headers.forEach(function(value,name){headers.push([name,value])});
          var body=request.method==='GET'?null:await request.text();
          if(signal.aborted)throw abortError();
          var result=await T.core.invoke('model_http',{request:{
            url:request.url,method:request.method,headers:headers,body:body
          }});
          var noBody=request.method==='HEAD'||result.status===204||result.status===205||result.status===304;
          return new Response(noBody?null:result.body,{
            status:result.status,statusText:result.statusText,headers:result.headers
          });
        }).then(function(response){finish(null,response)},function(cause){
          var error=cause instanceof Error?cause:new Error(String(cause));
          if(error.name!=='AbortError'&&/timed?\s*out|timeout|超时/i.test(error.message))error.name='TimeoutError';
          finish(error);
        });
      });
    });
  };
  window.PDFYI_NATIVE_HTTP=true;
})();
