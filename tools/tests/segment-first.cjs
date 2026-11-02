// Run: node tools/tests/segment-first.cjs
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), prepared = new Set(), writes = [], calls = [], timers = [];
const c = vm.createContext({ console, performance, URLSearchParams, Headers, Blob, Response, AbortController, Uint8Array, ArrayBuffer,
  location: { search: '?engine=1' }, document: { documentElement: { style: {} }, getElementById() { return null; } },
  localStorage: { getItem: () => null }, addEventListener() {}, fetch() {},
  setTimeout(fn, ms) { timers.push(ms); return 1; }, clearTimeout() {},
  pdfjsLib: { GlobalWorkerOptions: {}, getDocument() { return { promise: Promise.resolve({ numPages: 4 }) }; } },
  __TAURI__: { fs: { readFile: async () => new Uint8Array([1, 2]), writeFile: async () => {} }, event: { listen: async () => {} }, core: { invoke: async name => name === 'background_state' ? { paused: false } : null } }
});
c.window = c;
for (const file of ['textutil.js', 'extract.js', 'translate.js', 'bilingual.js']) vm.runInContext(fs.readFileSync(path.join(root, 'www/core', file), 'utf8'), c);
c.idbGet = async (store, key) => key.endsWith(':p1') ? ['缓存译文'] : key.endsWith(':en1') ? { texts: ['cached source'], bboxes: [{ y: 10, h: 14 }] } : null;
c.idbSet = async (...args) => writes.push(args);
c.autoCleanRules = async () => ({ running: [] }); c.validateCleanRules = async () => ({ running: [] });
c.rawOf = async p => ({ texts: ['source ' + p], bboxes: [{ y: 10, h: 14 }], rawLines: ['Source page ' + p + '.'], rawYs: [10] });
c.prepOf = async p => { prepared.add(p); return { rawLines: ['Source page ' + p + '.'], rawYs: [10] }; };
c.aiMergeLines = async lines => { assert.equal(prepared.size, 3, 'every uncached page is locally segmented before any model call'); calls.push('merge'); const result = Array.from(lines).filter(Boolean); result._idx = Array.from(lines, (t, i) => t ? [i] : null).filter(Boolean); return result; };
c.buildGlossary = async () => { assert.equal(prepared.size, 3); calls.push('glossary'); };
c.apiBatch = async (_, texts) => { calls.push('translate'); assert.equal(prepared.size, 3); return Array.from(texts, (_, i) => '译文' + i); };
c.buildBilingualPdf = async () => new Uint8Array([1]);
let worker = fs.readFileSync(path.join(root, 'www/worker.js'), 'utf8').replace('window.PDFYI_WORKER={state:', 'window.runTest=async function(j){job=j;await run(j)};window.PDFYI_WORKER={state:');
vm.runInContext(worker, c);
(async () => {
  await c.runTest({ path: '/tmp/segment-first-regression.pdf' });
  const state = c.PDFYI_WORKER.state(); assert.equal(state.prog.done, 4); assert.ok(state.prog.phaseAMs >= 0);
  assert.deepEqual(Array.from(c.memCache[1]), ['缓存译文']);
  assert.equal(calls.filter(x => x === 'translate').length, 1, 'three pages share one request');
  assert.equal(writes.filter(x => /:p1$/.test(x[1])).length, 0, 'clean page is reused, not overwritten');
  for (let p = 2; p <= 4; p++) { const en = writes.findIndex(x => x[1].endsWith(':en' + p)), tr = writes.findIndex(x => x[1].endsWith(':p' + p)); assert.ok(en >= 0 && tr > en, 'source segmentation commits before completed translations'); assert.equal(c.pageTextCache[p].length, c.memCache[p].length); }
  console.log('PASS: all-page local segmentation precedes model calls, cross-page worker request, clean-cache reuse, page-based progress, compatible complete-page persistence');
})().catch(e => { console.error(e); process.exitCode = 1; });
