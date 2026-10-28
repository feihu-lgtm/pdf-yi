/* PDF译 的 Zotero 7 插件
 * 1. 在条目右键菜单里加“用 PDF译 翻译（左原文右译文）”：把选中条目的 PDF 附件交给 PDF译（pdfyi:// 链接）
 * 2. 在 Zotero 本地服务注册 /pdfyi/attach（挂回原条目）和 /pdfyi/import（导入原文与双栏 PDF）。
 *    挂回时沿用原附件的存储/链接模式；新导入按原文内容去重，两个 PDF 都复制进 Zotero。
 */
var MENU_ID = 'pdfyi-translate-menuitem';
var ENDPOINT = '/pdfyi/attach';
var IMPORT_ENDPOINT = '/pdfyi/import';
var SOURCE_MARKER = 'PDFYi-Source-MD5: ';
var ORIGINAL_MARKER = 'PDFYi-Original-Key: ';
var BILINGUAL_MARKER = 'PDFYi-Bilingual-Key: ';
var importQueue = Promise.resolve();

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  registerEndpoint();
  for (let win of Zotero.getMainWindows()) addMenu(win);
}

function shutdown() {
  for (let win of Zotero.getMainWindows()) removeMenu(win);
  delete Zotero.Server.Endpoints[ENDPOINT];
  delete Zotero.Server.Endpoints[IMPORT_ENDPOINT];
}

function onMainWindowLoad({ window }) { addMenu(window); }
function onMainWindowUnload({ window }) { removeMenu(window); }

// ── 右键菜单 ──
function addMenu(win) {
  let doc = win.document;
  if (doc.getElementById(MENU_ID)) return;
  let popup = doc.getElementById('zotero-itemmenu');
  if (!popup) return;
  let item = doc.createXULElement('menuitem');
  item.id = MENU_ID;
  item.setAttribute('label', '用 PDF译 翻译（左原文右译文）');
  item.addEventListener('command', () => translateSelected(win));
  popup.appendChild(item);
  // 选中的东西里没有 PDF 时，把这一项藏起来
  popup.addEventListener('popupshowing', () => {
    let el = doc.getElementById(MENU_ID);
    if (el) el.hidden = !win.ZoteroPane.getSelectedItems().some(it => pdfOf(it));
  });
}

function removeMenu(win) {
  let el = win.document.getElementById(MENU_ID);
  if (el) el.remove();
}

// 条目本身是 PDF 附件就用它；是普通条目就用它最好的那个 PDF 附件
function pdfOf(item) {
  if (item.isAttachment()) return item.isPDFAttachment() ? item : null;
  if (!item.isRegularItem()) return null;
  for (let id of item.getAttachments()) {
    let a = Zotero.Items.get(id);
    if (a && a.isPDFAttachment() && !/_双栏$/.test(a.getField('title'))) return a;
  }
  return null;
}

async function translateSelected(win) {
  let atts = [];
  for (let it of win.ZoteroPane.getSelectedItems()) {
    let a = pdfOf(it);
    if (a && !atts.includes(a)) atts.push(a);
  }
  if (!atts.length) { win.alert('选中的条目里没有 PDF 附件。'); return; }
  let sent = 0, missing = [];
  for (let a of atts) {
    let path = await a.getFilePathAsync();
    if (!path) { missing.push(a.getField('title')); continue; }
    let linked = a.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE;
    let url = 'pdfyi://translate?path=' + encodeURIComponent(path)
      + '&key=' + a.key + '&lib=' + a.libraryID + '&mode=' + (linked ? 'linked' : 'stored');
    try {
      await Zotero.Utilities.Internal.exec('/usr/bin/open', [url]);
      sent++;
    } catch (e) {
      Zotero.logError(e);
      win.alert('叫不起 PDF译：' + e + '\n请确认 PDF译.app 已经装好、并且打开过一次。');
      return;
    }
  }
  let pw = new Zotero.ProgressWindow();
  pw.changeHeadline('PDF译');
  pw.addDescription(sent + ' 份 PDF 已交给 PDF译，在后台翻。翻完会以“…_双栏”的名字挂回原条目。'
    + (missing.length ? '\n这几份找不到文件，没交：' + missing.join('、') : ''));
  pw.show();
  pw.startCloseTimer(6000);
}

function jsonResponse(status, data) {
  return [status, 'application/json', JSON.stringify(data)];
}

function requestData(req) {
  try {
    let data = typeof req.data === 'string' ? JSON.parse(req.data) : req.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch (e) {
    throw Object.assign(new Error('参数不对：需要 JSON 对象'), { status: 400 });
  }
}

var expectedToken = null;
async function getExpectedToken() {
  if (expectedToken) return expectedToken;
  try {
    let home = Services.dirsvc.get('Home', Ci.nsIFile).path;
    let p = PathUtils.join(home, '.pdfyi-token');
    if (await IOUtils.exists(p)) {
      expectedToken = (await IOUtils.readUTF8(p)).trim();
      return expectedToken;
    }
  } catch (e) {}
  try {
    let p2 = PathUtils.join(PathUtils.profileDir, '../../../../.pdfyi-token');
    if (await IOUtils.exists(p2)) {
      expectedToken = (await IOUtils.readUTF8(p2)).trim();
      return expectedToken;
    }
  } catch (e) {}
  return null;
}

async function checkSecurity(req) {
  let headers = (req && req.headers) || {};
  if (headers['origin']) {
    throw Object.assign(new Error('禁止跨域调用 (Origin rejected)'), { status: 403 });
  }
  if (headers['sec-fetch-site'] && headers['sec-fetch-site'] !== 'same-origin' && headers['sec-fetch-site'] !== 'none') {
    throw Object.assign(new Error('禁止跨站调用 (Sec-Fetch-Site rejected)'), { status: 403 });
  }
  let expected = await getExpectedToken();
  if (!expected) {
    throw Object.assign(new Error('未找到本地安全口令文件 ~/.pdfyi-token'), { status: 403 });
  }
  let given = (headers['x-pdfyi-token'] || '').trim();
  if (!given || given !== expected) {
    throw Object.assign(new Error('口令无效或缺失 (Invalid or missing token)'), { status: 403 });
  }
}

// 只读文件头和末尾，必须在创建、删除或替换任何 Zotero 条目前完成。
async function validatePDF(path) {
  if (typeof path !== 'string' || !path.trim()) {
    throw Object.assign(new Error('参数不对：需要 PDF 路径'), { status: 400 });
  }
  if (!(await IOUtils.exists(path))) {
    throw Object.assign(new Error('找不到文件 ' + path), { status: 404 });
  }
  let stat = await IOUtils.stat(path);
  if (stat.type !== 'regular' || stat.size < 10) {
    throw Object.assign(new Error('不是完整的 PDF 文件 ' + path), { status: 422 });
  }
  let header = await IOUtils.read(path, { maxBytes: 5 });
  let tail = await IOUtils.read(path, { offset: Math.max(0, stat.size - 2048), maxBytes: 2048 });
  if (String.fromCharCode(...header) !== '%PDF-' || !String.fromCharCode(...tail).includes('%%EOF')) {
    throw Object.assign(new Error('PDF 文件不完整或格式不对 ' + path), { status: 422 });
  }
}

function extraValue(item, prefix) {
  let line = item.getField('extra').split(/\r?\n/).find(line => line.startsWith(prefix));
  return line ? line.slice(prefix.length) : '';
}

function setExtraValue(item, prefix, value) {
  let lines = item.getField('extra').split(/\r?\n/).filter(line => line && !line.startsWith(prefix));
  lines.push(prefix + value);
  item.setField('extra', lines.join('\n'));
}

function markedAttachment(parent, prefix) {
  let key = extraValue(parent, prefix);
  if (!key) return null;
  for (let id of parent.getAttachments()) {
    let attachment = Zotero.Items.get(id);
    if (attachment && !attachment.deleted && attachment.key === key) return attachment;
  }
  return null;
}

// recognizeItems() 只接受顶层附件。底层识别 API 可读取子附件，并返回一个临时书目条目；
// 把元数据写回已有父条目，保留 key 和导入标记，不另外留下一个父条目。
async function recognizeOriginal(original, parent) {
  if (!Zotero.RecognizeDocument || typeof Zotero.RecognizeDocument._recognize !== 'function') return;
  let recognized;
  try {
    recognized = await Zotero.RecognizeDocument._recognize(original);
    if (!recognized || recognized.id === parent.id) return;
    await Zotero.DB.executeTransaction(async () => {
      let metadata = recognized.toJSON();
      for (let field of ['key', 'version', 'collections', 'relations', 'deleted', 'dateAdded', 'dateModified']) {
        delete metadata[field];
      }
      metadata.extra = [metadata.extra, parent.getField('extra')].filter(Boolean).join('\n');
      parent.fromJSON(metadata);
      await parent.save();
      await recognized.erase();
    });
  } catch (e) {
    Zotero.logError(e);
    if (recognized && recognized.id !== parent.id) {
      try { await recognized.eraseTx(); } catch (cleanupError) { Zotero.logError(cleanupError); }
    }
  }
}

async function importPDFs(d) {
  // 即使已导入过，也要先检查本次的两个文件，绝不以去重为由跳过校验。
  await validatePDF(d.source_path);
  await validatePDF(d.output_path);
  if (d.title !== undefined && typeof d.title !== 'string') {
    throw Object.assign(new Error('参数不对：标题需要是文字'), { status: 400 });
  }
  let hash = await Zotero.Utilities.Internal.md5Async(d.source_path);
  if (!hash) throw Object.assign(new Error('找不到原文 PDF'), { status: 404 });
  let marker = SOURCE_MARKER + hash;
  let libraryID = Zotero.Libraries.userLibraryID;
  let doi = String(d.doi || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/[.,;)]+$/, '');
  let parent = null;

  // 1. 去重优先按 DOI 查找
  if (doi) {
    let searchDoi = new Zotero.Search();
    searchDoi.libraryID = libraryID;
    searchDoi.addCondition('DOI', 'is', doi);
    for (let id of await searchDoi.search()) {
      let item = await Zotero.Items.getAsync(id);
      if (item && !item.deleted && item.isRegularItem()) { parent = item; break; }
    }
  }

  // 2. 其次按内容 MD5 标记查找
  if (!parent) {
    let search = new Zotero.Search();
    search.libraryID = libraryID;
    search.addCondition('extra', 'contains', marker);
    for (let id of await search.search()) {
      let item = await Zotero.Items.getAsync(id);
      if (item && !item.deleted && item.isRegularItem()
        && item.getField('extra').split(/\r?\n/).includes(marker)) {
        parent = item;
        break;
      }
    }
  }

  let duplicate = !!parent;
  let title = (d.title || '').trim() || PathUtils.filename(d.source_path).replace(/\.pdf$/i, '');

  // 3. 新建条目：优先按 DOI 查询正式元数据
  if (!parent && doi) {
    try {
      let translate = new Zotero.Translate.Search();
      translate.setIdentifier({ DOI: doi });
      let translators = await translate.getTranslators();
      if (translators && translators.length) {
        translate.setTranslator(translators);
        let items = await translate.translate({ libraryID: libraryID, saveAttachments: false });
        if (items && items.length) parent = items[0];
      }
    } catch (e) { Zotero.logError(e); }
  }

  // 4. 无 DOI 时，尝试用模型识别的 CSL-JSON 导入条目
  if (!parent && d.csl) {
    try {
      let translate = new Zotero.Translate.Import();
      translate.setString(typeof d.csl === 'string' ? d.csl : JSON.stringify(Array.isArray(d.csl) ? d.csl : [d.csl]));
      let translators = await translate.getTranslators();
      if (translators && translators.length) {
        translate.setTranslator(translators);
        let items = await translate.translate({ libraryID: libraryID });
        if (items && items.length) parent = items[0];
      }
    } catch (e) { Zotero.logError(e); }
  }

  // 5. 仍未建立条目：降级新建普通 document 条目
  if (!parent) {
    parent = new Zotero.Item('document');
    parent.libraryID = libraryID;
    parent.setField('title', title);
    if (doi) { try { parent.setField('DOI', doi); } catch (e) {} }
    await parent.saveTx();
  }

  // 确保父条目带有去重标记
  setExtraValue(parent, SOURCE_MARKER, hash);
  await parent.saveTx();

  // 6. 挂载原文附件
  let original = markedAttachment(parent, ORIGINAL_MARKER);
  if (!original) {
    original = await Zotero.Attachments.importFromFile({
      file: d.source_path, parentItemID: parent.id, title: title, contentType: 'application/pdf'
    });
    setExtraValue(parent, ORIGINAL_MARKER, original.key);
    await parent.saveTx();
  }

  // 7. 挂载双栏 PDF 附件
  let previous = markedAttachment(parent, BILINGUAL_MARKER);
  let bilingual = await Zotero.Attachments.importFromFile({
    file: d.output_path, parentItemID: parent.id, title: title.replace(/_双栏$/, '') + '_双栏',
    contentType: 'application/pdf'
  });
  await Zotero.DB.executeTransaction(async () => {
    setExtraValue(parent, BILINGUAL_MARKER, bilingual.key);
    await parent.save();
    if (previous) {
      previous.deleted = true;
      await previous.save();
    }
  });

  // 8. 降级创建的条目且没有 DOI/CSL 时，尝试在后台异步识别 PDF 元数据
  if (!duplicate && !doi && !d.csl) recognizeOriginal(original, parent).catch(e => Zotero.logError(e));

  return jsonResponse(200, {
    ok: true, key: parent.key, lib: parent.libraryID, title: parent.getField('title'), duplicate: duplicate
  });
}

// ── 本地服务：PDF译 翻完调这里 ──
function registerEndpoint() {
  let Attach = function () {};
  Attach.prototype = {
    supportedMethods: ['POST'],
    supportedDataTypes: ['application/json'],
    permitBookmarklet: false,
    init: async function (req) {
      try {
        await checkSecurity(req);
        let d = requestData(req);
        if (!d.key || typeof d.path !== 'string' || !/_双栏\.pdf$/.test(d.path)) return jsonResponse(400, { ok: false, error: '参数不对' });
        await validatePDF(d.path);
        let att = await Zotero.Items.getByLibraryAndKeyAsync(parseInt(d.lib) || Zotero.Libraries.userLibraryID, d.key);
        if (!att) return [404, 'application/json', JSON.stringify({ ok: false, error: '找不到原附件 ' + d.key })];
        let parentItemID = att.parentItemID || null;
        let title = d.title || 'PDF译_双栏';
        let parent = parentItemID ? Zotero.Items.get(parentItemID) : null;
        let replacesBilingual = false;
        // 同一个条目下已经有同名的双栏 PDF（之前翻过）：先移到回收站，换成新的
        if (parentItemID) {
          let bilingualKey = extraValue(parent, BILINGUAL_MARKER);
          for (let id of parent.getAttachments()) {
            let old = Zotero.Items.get(id);
            if (old && old.getField('title') === title) {
              if (old.key === bilingualKey) replacesBilingual = true;
              old.deleted = true;
              await old.saveTx();
            }
          }
        }
        let opts = { file: d.path, title: title, contentType: 'application/pdf' };
        if (parentItemID) opts.parentItemID = parentItemID;
        else { opts.libraryID = att.libraryID; opts.collections = att.getCollections(); }
        let created;
        if (d.mode === 'linked') {
          created = await Zotero.Attachments.linkFromFile(opts);
        } else {
          created = await Zotero.Attachments.importFromFile(opts);
          try { await IOUtils.remove(d.path); } catch (e) {}  // 已经复制进 Zotero，删掉临时文件
        }
        if (replacesBilingual) {
          setExtraValue(parent, BILINGUAL_MARKER, created.key);
          await parent.saveTx();
        }
        return [200, 'application/json', JSON.stringify({ ok: true, item: created.key })];
      } catch (e) {
        Zotero.logError(e);
        return jsonResponse(e.status || 500, { ok: false, error: String(e) });
      }
    }
  };
  Zotero.Server.Endpoints[ENDPOINT] = Attach;
  let Import = function () {};
  Import.prototype = {
    supportedMethods: ['POST'],
    supportedDataTypes: ['application/json'],
    permitBookmarklet: false,
    init: async function (req) {
      try {
        await checkSecurity(req);
        let d = requestData(req);
        // 查重与写入串行，防止同时点击导入时建立两个父条目。
        let result = importQueue.then(() => importPDFs(d));
        importQueue = result.catch(() => {});
        return await result;
      } catch (e) {
        Zotero.logError(e);
        return jsonResponse(e.status || 500, { ok: false, error: String(e) });
      }
    }
  };
  Zotero.Server.Endpoints[IMPORT_ENDPOINT] = Import;
}
