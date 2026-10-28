/* PDF译 的 Zotero 7 插件
 * 1. 在条目右键菜单里加“用 PDF译 翻译（左原文右译文）”：把选中条目的 PDF 附件交给 PDF译（pdfyi:// 链接）
 * 2. 在 Zotero 自带的本地服务（127.0.0.1:23119）上注册 /pdfyi/attach：PDF译 翻完以后调它，
 *    把双栏 PDF 挂回原条目。原附件是存在 Zotero 里的文件就复制进来；是链接到外部的文件就以链接挂上。
 */
var MENU_ID = 'pdfyi-translate-menuitem';
var ENDPOINT = '/pdfyi/attach';

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

// ── 本地服务：PDF译 翻完调这里 ──
function registerEndpoint() {
  let Attach = function () {};
  Attach.prototype = {
    supportedMethods: ['POST'],
    supportedDataTypes: ['application/json'],
    permitBookmarklet: false,
    init: async function (req) {
      try {
        let d = req.data || {};
        if (!d.key || !d.path || !/_双栏\.pdf$/.test(d.path)) return [400, 'application/json', JSON.stringify({ ok: false, error: '参数不对' })];
        if (!(await IOUtils.exists(d.path))) return [404, 'application/json', JSON.stringify({ ok: false, error: '找不到文件 ' + d.path })];
        let att = await Zotero.Items.getByLibraryAndKeyAsync(parseInt(d.lib) || Zotero.Libraries.userLibraryID, d.key);
        if (!att) return [404, 'application/json', JSON.stringify({ ok: false, error: '找不到原附件 ' + d.key })];
        let parentItemID = att.parentItemID || null;
        let title = d.title || 'PDF译_双栏';
        // 同一个条目下已经有同名的双栏 PDF（之前翻过）：先移到回收站，换成新的
        if (parentItemID) {
          let parent = Zotero.Items.get(parentItemID);
          for (let id of parent.getAttachments()) {
            let old = Zotero.Items.get(id);
            if (old && old.getField('title') === title) { old.deleted = true; await old.saveTx(); }
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
        return [200, 'application/json', JSON.stringify({ ok: true, item: created.key })];
      } catch (e) {
        Zotero.logError(e);
        return [500, 'application/json', JSON.stringify({ ok: false, error: String(e) })];
      }
    }
  };
  Zotero.Server.Endpoints[ENDPOINT] = Attach;
}
