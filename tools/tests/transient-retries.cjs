// Run: node tools/tests/transient-retries.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');

function workerContext() {
  const delays = [], writes = [], entries = [];
  const context = vm.createContext({
    URLSearchParams, Promise, Date, console,
    location: { search: '?engine=1' }, VENDOR: 'vendor/',
    document: { documentElement: { style: {} }, getElementById: () => null },
    pdfjsLib: { GlobalWorkerOptions: {} },
    localStorage: { getItem: key => key === 'pdfyi_conc' ? '6' : null },
    addEventListener() {},
    setTimeout(callback, ms) { delays.push(ms); queueMicrotask(callback); return 1; },
    clearTimeout() {},
    totalPages: 4, cacheKey: 'regression', memCache: {}, pageTextCache: {},
    idbSet: async (...args) => writes.push(args)
  });
  context.window = context;
  let source = fs.readFileSync(path.join(root, 'www/worker.js'), 'utf8');
  const anchor = 'window.PDFYI_WORKER={state:';
  assert.ok(source.includes(anchor), 'worker state seam exists');
  source = source.replace(anchor,
    'window.retryTest={retryTransientFailures:retryTransientFailures,isTransientFailure:isTransientFailure,processPages:processPages,setStates:function(value){pageState=value}};' + anchor);
  vm.runInContext(source, context);
  context.addTransLog = (...args) => entries.push(args);
  return { context, delays, writes, entries };
}

(async function () {
  const { context: c, delays, writes, entries } = workerContext();
  const transient = c.retryTest.isTransientFailure;
  for (const reason of ['网络错误 Load failed', 'HTTP 429 rate limit', 'HTTP 503 unavailable', '超时（300 秒）']) {
    assert.equal(transient('__TRANSFAIL__' + reason), true, reason);
  }
  for (const reason of ['未匹配到译文（模型返回格式异常）', '读不出字', 'HTTP 401 invalid key', '结果缺失']) {
    assert.equal(transient('__TRANSFAIL__' + reason), false, reason);
  }
  assert.equal(transient('HTTP 503 in successfully translated prose'), false);
  c.memCache = {
    1: ['已有译文', '__TRANSFAIL__网络错误 Load failed', '__TRANSFAIL__HTTP 503 unavailable', '__TRANSFAIL__未匹配到译文（模型返回格式异常）'],
    2: ['__TRANSFAIL__模型返回空内容'],
    3: ['__TRANSFAIL__HTTP 429 rate limit']
  };
  c.pageTextCache = { 1: ['keep', 'network', 'server', 'deterministic'], 2: ['parse'], 3: ['rate limit'] };
  c.retryTest.setStates(['w', 'f', 'f', 'f', 'u']); // unreadable page 4 has no translations to retry
  Object.assign(c.PDFYI_WORKER.state().prog, { pages: 4, done: 4, failPages: 3, failParas: 5 });
  const calls = [], attempts = {};
  c.translatePage = async (page, paragraphs) => {
    calls.push({ page, paragraphs: Array.from(paragraphs) });
    attempts[page] = (attempts[page] || 0) + 1;
    if (page === 1) return attempts[page] === 1 ? ['网络恢复', '__TRANSFAIL__HTTP 429 retry'] : ['服务器恢复'];
    if (page === 3) return ['__TRANSFAIL__HTTP 429 still limited'];
    throw new Error('Deterministic/unreadable page must not be retried');
  };
  await c.retryTest.retryTransientFailures();
  assert.deepEqual(delays, [2000, 4000]);
  assert.equal(attempts[1], 2);
  assert.equal(attempts[3], 2);
  assert.equal(attempts[2], undefined);
  assert.deepEqual(calls.filter(call => call.page === 1).map(call => call.paragraphs), [['network', 'server'], ['server']]);
  assert.deepEqual(Array.from(c.memCache[1]), ['已有译文', '网络恢复', '服务器恢复', '__TRANSFAIL__未匹配到译文（模型返回格式异常）']);
  assert.equal(c.PDFYI_WORKER.state().prog.done, 4, 'retries do not double-count completed pages');
  assert.equal(c.PDFYI_WORKER.state().prog.failPages, 3);
  assert.equal(c.PDFYI_WORKER.state().prog.failParas, 3);
  assert.equal(writes.length, 4, 'each settled retry persists its result');
  assert.equal(entries.filter(args => String(args[2]).startsWith('自动重试第')).length, 2);

  const pool = workerContext().context;
  let active = 0, peak = 0;
  await pool.retryTest.processPages(Array.from({ length: 14 }, (_, i) => i + 1), async () => {
    active++; peak = Math.max(peak, active);
    await Promise.resolve(); active--;
  }, false);
  assert.equal(peak, 6, 'retry pool observes the same live per-book concurrency setting');

  const http = vm.createContext({
    console, Headers, Blob, Response, AbortController, setTimeout, clearTimeout,
    cacheKey: 'http-test', localStorage: { getItem: () => null },
    addTransLog() {}, toast() {}, setStatus() {},
    fetch: async () => new Response(JSON.stringify({ error: { message: 'upstream busy' } }), { status: 503 })
  });
  http.window = http; http.PDFYI_WORKER = true;
  vm.runInContext(fs.readFileSync(path.join(root, 'www/core/translate.js'), 'utf8'), http);
  const result = await http.apiBatch('key', ['text'], 1);
  assert.match(result[0], /^__TRANSFAIL__HTTP 503 upstream busy$/, 'HTTP status survives human-readable provider errors');
  const nativeCalls = [], browserCalls = [];
  const native = vm.createContext({
    URL, Request, Response, Headers, Blob, DOMException, Promise, Error,
    location: { href: 'tauri://localhost/worker.html' },
    fetch: async (...args) => { browserCalls.push(args); return new Response('asset'); },
    __TAURI__: { core: { invoke: async (name, args) => {
      nativeCalls.push({ name, request: args.request });
      return { status: 429, statusText: 'Too Many Requests', headers: [['content-type', 'application/json']], body: '{"error":{"message":"slow down"}}' };
    } } }
  });
  native.window = native;
  const bridgeSource = fs.readFileSync(path.join(root, 'www/model-http.js'), 'utf8');
  vm.runInContext(bridgeSource, native);
  assert.equal(native.PDFYI_NATIVE_HTTP, true);
  const response = await native.fetch('http://127.0.0.1:3426/v1/chat/completions', {
    method: 'POST', headers: new Headers({ Authorization: 'Bearer test' }),
    body: new Blob(['{"model":"test"}'], { type: 'application/json' })
  });
  assert.equal(response.status, 429);
  assert.equal(response.ok, false);
  assert.equal((await response.json()).error.message, 'slow down');
  assert.equal(nativeCalls[0].name, 'model_http');
  assert.equal(nativeCalls[0].request.body, '{"model":"test"}');
  assert.ok(nativeCalls[0].request.headers.some(([key, value]) => key === 'content-type' && value === 'application/json'));
  await native.fetch('https://provider.example/custom/v1/models');
  await native.fetch('https://provider.example/v1/text/chatcompletion_v2', { method: 'POST', body: '{}' });
  assert.equal(nativeCalls.length, 3, 'all configured provider model endpoints use native transport');
  await native.fetch('vendor/fonts/font.ttf');
  assert.equal(browserCalls.length, 1, 'assets remain on browser transport');
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(native.fetch('http://127.0.0.1:3426/v1/chat/completions', { method: 'POST', signal: cancelled.signal }), { name: 'AbortError' });
  assert.equal(nativeCalls.length, 3);
  const browserFetch = () => {};
  const lightweight = vm.createContext({ fetch: browserFetch });
  lightweight.window = lightweight;
  vm.runInContext(bridgeSource, lightweight);
  assert.equal(lightweight.fetch, browserFetch, 'lightweight browser edition remains unchanged');
  console.log('PASS: transient classification, two backoff rounds, paragraph preservation, failure totals, concurrency cap, HTTP status markers, native model transport, browser fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
