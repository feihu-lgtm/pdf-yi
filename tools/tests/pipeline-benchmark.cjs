// Real PDF + real model replay, without opening a window. Usage:
// node tools/tests/pipeline-benchmark.cjs PDF OUTPUT_PREFIX [source-www] [cap=24]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const [input, prefix, sourceArg, capArg] = process.argv.slice(2);
if (!input || !prefix) throw Error('PDF and output prefix required');
const source = path.resolve(sourceArg || path.join(__dirname, '../../www'));
const cap = Number(capArg || 24), metrics = { cap, requests: [], peakInFlight: 0, localMs: 0 };
function snapshot() { fs.writeFileSync(prefix + '.partial.json', JSON.stringify(metrics, null, 2)); }
let active = 0, permits = 0, waiters = [];
async function acquire() { if (permits >= cap) await new Promise(resolve => waiters.push(resolve)); else permits++; }
function release() { if (waiters.length) waiters.shift()(); else permits--; }
const pdfjsLib = require(path.join(source, 'vendor/pdf.min.js'));
pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(source, 'vendor/pdf.worker.min.js');
const cache = new Map(), logs = [], progress = [];
const timers = new Set();
const nativeFetch=globalThis.fetch.bind(globalThis),clockSetTimeout=setTimeout,clockClearTimeout=clearTimeout,nodeConsole=console;
// Use the host realm: pdf-lib validates arrays/points with instanceof.
const c=globalThis;Object.assign(c,{
  console: { log() {}, warn() {}, error: console.error },
  URL, URLSearchParams, Headers, Blob, Response, AbortController, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, performance, Date, Promise,
  pdfjsLib, location: { search: '?engine=1' },
  document: { documentElement: { style: {} }, getElementById() { return null; } },
  localStorage: { getItem(k) { return k === 'pdfyi_conc' ? String(cap) : k === 'pdfyi_notify' ? '0' : null; }, setItem() {} },
  addEventListener() {},
  setTimeout(fn, ms) { const t = clockSetTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; },
  clearTimeout(t) { timers.delete(t); clockClearTimeout(t); },
  async fetch(url, options) {
    if (!/^https?:/.test(url)) return new Response(fs.readFileSync(path.join(source, url)));
    const body = JSON.parse(await options.body.text()), prompt = body.messages.at(-1).content;
    const type = prompt.includes('group consecutive lines') ? 'merge' : prompt.includes('English paragraphs to Simplified Chinese') ? 'translate' : 'glossary';
    const paragraphs = type === 'translate' ? Array.from(prompt.matchAll(/^\[\d+\] ([\s\S]*?)(?=\n\n\[\d+\] |$)/gm), m => m[1]) : [];
    await acquire(); active++; metrics.peakInFlight = Math.max(metrics.peakInFlight, active);
    const start = performance.now();
    try {
      const response = await nativeFetch(url, options), text = await response.text();
      metrics.requests.push({ type, latencyMs: performance.now() - start, chars: paragraphs.reduce((n, p) => n + p.length, 0), paragraphs: paragraphs.length, status: response.status });
      snapshot();
      return new Response(text, { status: response.status, headers: response.headers });
    } finally { active--; release(); }
  },
  __TAURI__: {
    fs: { readFile: async p => new Uint8Array(fs.readFileSync(p)), writeFile: async (p, bytes) => fs.writeFileSync(prefix + '.pdf', bytes) },
    core: { invoke: async (name, args) => {
      if (name === 'background_state') return { paused: false };
      if (name === 'engine_progress') { progress.push(JSON.parse(JSON.stringify(args.status.prog))); if (metrics.lastPhase !== args.status.prog.phase) { metrics.lastPhase = args.status.prog.phase; snapshot(); } }
      if (name === 'engine_log') logs.push(args.entry);
      return null;
    } }, event: { listen: async () => {} }
  }
});
c.window = c; c.PDFYI_NATIVE_HTTP = true;
for (const file of ['textutil.js', 'extract.js', 'translate.js', 'bilingual.js']) vm.runInThisContext(fs.readFileSync(path.join(source, 'core', file), 'utf8'));
c.idbGet = async (store, key) => cache.get(store + ':' + key);
c.idbSet = async (store, key, value) => cache.set(store + ':' + key, structuredClone(value));
for (const name of ['extractParas', 'groupRaw']) {
  const original = c[name]; c[name] = (...args) => { const t = performance.now(); try { return original(...args); } finally { metrics.localMs += performance.now() - t; } };
}
let worker = fs.readFileSync(path.join(source, 'worker.js'), 'utf8');
worker = worker.replace('window.PDFYI_WORKER={state:', 'window.benchmarkRun=async function(j){job=j;await run(j);job=null};window.PDFYI_WORKER={state:');
c.PDFLib = require(path.join(source, 'vendor/pdf-lib.min.js'));
c.fontkit = require(path.join(source, 'vendor/fontkit.umd.min.js'));
worker = worker.replace("pdfjsLib.GlobalWorkerOptions.workerSrc=VENDOR+'pdf.worker.min.js';", '');
vm.runInThisContext(worker);
(async () => {
  const start = performance.now();
  await c.benchmarkRun({ path: path.resolve(input) });
  metrics.wallMs = performance.now() - start;
  metrics.pages = c.totalPages;
  metrics.sourceParagraphs = Object.values(c.pageTextCache).reduce((n, ps) => n + ps.length, 0);
  metrics.failedParagraphs = Object.values(c.memCache).flat().filter(t => String(t).startsWith('__TRANSFAIL__')).length;
  metrics.missingParagraphs = Object.keys(c.pageTextCache).reduce((n, p) => n + c.pageTextCache[p].filter((_, i) => !c.memCache[p]?.[i]).length, 0);
  metrics.phaseAMs = progress.find(p => p.phaseAMs != null)?.phaseAMs ?? null;
  metrics.byType = Object.fromEntries(['merge', 'translate', 'glossary'].map(type => {
    const rs = metrics.requests.filter(r => r.type === type);
    return [type, { count: rs.length, avgLatencyMs: rs.reduce((n, r) => n + r.latencyMs, 0) / (rs.length || 1), avgChars: rs.reduce((n, r) => n + r.chars, 0) / (rs.length || 1), avgParagraphs: rs.reduce((n, r) => n + r.paragraphs, 0) / (rs.length || 1) }];
  }));
  metrics.batchFill = metrics.byType.translate.avgChars / 3000;
  const output = await c.PDFLib.PDFDocument.load(fs.readFileSync(prefix + '.pdf'));
  metrics.outputPages = output.getPageCount(); assert.ok(metrics.outputPages >= metrics.pages);
  fs.writeFileSync(prefix + '.json', JSON.stringify(metrics, null, 2));
  nodeConsole.log(JSON.stringify({ ...metrics, requests: undefined }, null, 2));
  for (const t of timers) clearTimeout(t);
})().catch(error => { console.error(error); process.exitCode = 1; for (const t of timers) clearTimeout(t); });
