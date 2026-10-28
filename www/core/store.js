// 本文件由 coreport/assemble.py 从全量版 pdf-reader-v60.html 原样移植生成，逻辑与全量版一致。
// 缓存：IndexedDB “PDFTransCache”，pages 存译文（:p页号）和原文分段（:en页号），annotations 存清理规则（:clean）。
var cacheDB=null;
function openCacheDB(){return new Promise(function(resolve){
  if(cacheDB){resolve(cacheDB);return}
  var req=indexedDB.open('PDFTransCache',1);
  req.onupgradeneeded=function(e){var db=e.target.result;if(!db.objectStoreNames.contains('pages'))db.createObjectStore('pages');if(!db.objectStoreNames.contains('annotations'))db.createObjectStore('annotations')};
  req.onsuccess=function(e){cacheDB=e.target.result;resolve(cacheDB)};
  req.onerror=function(){resolve(null)};
})}
function idbGet(store,key){return new Promise(function(resolve){
  openCacheDB().then(function(db){if(!db){resolve(null);return}
    try{var tx=db.transaction(store,'readonly');var s=tx.objectStore(store);var r=s.get(key);
      r.onsuccess=function(){resolve(r.result!==undefined?r.result:null)};r.onerror=function(){resolve(null)}}catch(e){resolve(null)}});
})}
function idbSet(store,key,val){return new Promise(function(resolve){
  openCacheDB().then(function(db){if(!db){resolve();return}
    try{var tx=db.transaction(store,'readwrite');var s=tx.objectStore(store);s.put(val,key);
      tx.oncomplete=function(){resolve()};tx.onerror=function(){resolve()}}catch(e){resolve()}});
})}
