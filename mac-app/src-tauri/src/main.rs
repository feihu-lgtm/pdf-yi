// PDF译 的 Mac 外壳。翻译、提取、生成双栏 PDF 都在页面（www/）里做，这里只负责：
//   1. 开窗口；关窗口时只是藏起来，翻译接着跑
//   0. main 阅读器、worker 菜单栏面板、engine-1..4 隔离的隐藏翻译引擎
//   2. 菜单栏：小鱼按状态换表情，旁边显示进度文字；点开是一份随状态变化的菜单
//   3. 接收 Zotero 插件发来的 pdfyi:// 链接（交给页面处理）
//   4. 把翻好的双栏 PDF 交给 Zotero 插件挂回条目（从这里发请求，不受网页跨域限制）
//   5. 打开文件、在访达中显示
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    PhysicalPosition,
    AppHandle, Emitter, Manager, WindowEvent, Wry,
};

// 小鱼的四种表情（小狐画的，打包进程序里）：睡着了=空闲，在思考=翻译中，平时=暂停，来灵感=生成和完成
const SLEEPING: &[u8] = include_bytes!("../icons/tray/sleeping.png");
const THINKING: &[u8] = include_bytes!("../icons/tray/thinking.png");
const NORMAL: &[u8] = include_bytes!("../icons/tray/normal.png");
const INSPIRED: &[u8] = include_bytes!("../icons/tray/inspired.png");

fn mood_icon(mood: &str) -> &'static [u8] {
    match mood {
        "thinking" => THINKING,
        "normal" => NORMAL,
        "inspired" => INSPIRED,
        _ => SLEEPING,
    }
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Job {
    path: String,
    key: Option<String>,
    lib: u64,
    mode: String,
}

#[derive(Clone, serde::Serialize)]
struct RunningBook {
    job: Job,
    started_at: u64,
    status: serde_json::Value,
}

#[derive(Clone, serde::Serialize)]
struct BackgroundState {
    queue: VecDeque<Job>,
    running: HashMap<String, RunningBook>,
    recent: Vec<serde_json::Value>,
    parallelism: usize,
    paused: bool,
}

struct PendingJobs(Mutex<BackgroundState>);
static LINK_LAUNCH: AtomicBool = AtomicBool::new(false);
static STARTUP_PENDING: AtomicBool = AtomicBool::new(true);
#[cfg(target_os = "macos")]
static APP_READY: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static LAUNCH_DECIDED: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static NORMAL_LAUNCH: AtomicBool = AtomicBool::new(false);

fn settings_path(app: &AppHandle, name: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(name))
}

fn persist_recent(app: &AppHandle, recent: &[serde_json::Value]) {
    if let Some(path) = settings_path(app, "background-recent.json") {
        if let Ok(bytes) = serde_json::to_vec(recent) { let _ = std::fs::write(path, bytes); }
    }
}

fn publish_background(app: &AppHandle) {
    let snapshot = app.state::<PendingJobs>().0.lock().unwrap().clone();
    let _ = app.emit_to("worker", "background-state", snapshot);
}

fn wake_engines(app: &AppHandle) {
    for i in 1..=4 { let _ = app.emit_to(format!("engine-{i}"), "pdfyi-job", ()); }
}

fn lifecycle_log(app: &AppHandle, label: &str, action: &str, path: &str) {
    let line = format!("{} {} {} {}\n", now_ms(), label, action, path);
    eprint!("{line}");
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("engines.log")) {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

fn push_job(app: &AppHandle, raw: String) {
    let mut job = if let Some(path) = raw.strip_prefix("file:") {
        Job { path: path.into(), key: None, lib: 1, mode: "linked".into() }
    } else {
        let Ok(url) = tauri::Url::parse(&raw) else { return };
        if url.scheme() != "pdfyi" || url.host_str() != Some("translate") { return; }
        LINK_LAUNCH.store(true, Ordering::SeqCst);
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        let Some(path) = q.get("path").filter(|p| !p.is_empty()) else { return };
        Job { path: path.clone(), key: q.get("key").filter(|k| !k.is_empty()).cloned(),
            lib: q.get("lib").and_then(|s| s.parse().ok()).unwrap_or(1),
            mode: if q.get("mode").map(String::as_str) == Some("linked") { "linked" } else { "stored" }.into() }
    };
    if let Ok(path) = std::fs::canonicalize(&job.path) { job.path = path.to_string_lossy().into_owned(); }
    let state = app.state::<PendingJobs>();
    let mut s = state.0.lock().unwrap();
    if s.queue.iter().any(|j| j.path == job.path) || s.running.values().any(|r| r.job.path == job.path) { return; }
    s.queue.push_back(job);
    drop(s);
    publish_background(app);
    wake_engines(app);
}

// v59：后台引擎是挂在菜单栏小鱼下面的面板。点到别处时收起；刚收起的那一下又点小鱼，不要马上又弹出来
static LAST_HIDE: AtomicU64 = AtomicU64::new(0);
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// 在点击位置正下方弹出面板；已经开着就收起
fn toggle_popover(app: &AppHandle, at: Option<PhysicalPosition<f64>>) {
    let Some(w) = app.get_webview_window("worker") else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        return;
    }
    if now_ms().saturating_sub(LAST_HIDE.load(Ordering::Relaxed)) < 300 {
        return;
    }
    let scale = w.scale_factor().unwrap_or(2.0);
    let size = w.outer_size().map(|s| (s.width as f64, s.height as f64)).unwrap_or((380.0 * scale, 600.0 * scale));
    let (x, y) = match at {
        Some(p) => (p.x - size.0 / 2.0, p.y + 14.0 * scale),
        None => {
            // 没有点击位置（从菜单里打开）：放在屏幕右上角
            let mw = w.current_monitor().ok().flatten().map(|m| m.size().width as f64).unwrap_or(1440.0 * scale);
            (mw - size.0 - 12.0 * scale, 30.0 * scale)
        }
    };
    let _ = w.set_position(PhysicalPosition::new(x.max(8.0 * scale), y));
    let _ = w.show();
    let _ = w.set_focus();
    let _ = w.emit("popover-shown", ());
}

// 弹出选文件的窗口，选好的 PDF 交给后台引擎（菜单和面板上的“添加 PDF”都用这个）
fn pick_files_job(app: &AppHandle) {
    let h = app.clone();
    app.dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .pick_files(move |files| {
            if let Some(fs) = files {
                for f in fs {
                    if let Ok(p) = f.into_path() {
                        push_job(&h, format!("file:{}", p.to_string_lossy()));
                    }
                }
            }
        });
}

#[tauri::command]
fn bg_pick(app: AppHandle) {
    pick_files_job(&app);
}

// 每个引擎一次只领取一本；领取和并发上限检查在同一把锁里，未就绪的引擎不会丢任务。
#[tauri::command]
fn engine_pull(app: AppHandle, window: tauri::WebviewWindow) -> Option<Job> {
    let label = window.label();
    if !matches!(label, "engine-1" | "engine-2" | "engine-3" | "engine-4") { return None; }
    let state = app.state::<PendingJobs>();
    let mut s = state.0.lock().unwrap();
    if s.paused || s.running.len() >= s.parallelism || s.running.contains_key(label) { return None; }
    let job = s.queue.pop_front()?;
    s.running.insert(label.into(), RunningBook { job: job.clone(), started_at: now_ms(), status: serde_json::json!({
        "prog": { "pages": 0, "done": 0, "failPages": 0, "failParas": 0, "doneTimes": [], "phase": "loading",
            "doneUntil": 0, "title": std::path::Path::new(&job.path).file_stem().unwrap_or_default().to_string_lossy(),
            "from": if job.key.is_some() { "来自 Zotero" } else { "本地文件" } }, "pageState": [], "conc": 6 }) });
    drop(s);
    lifecycle_log(&app, label, "START", &job.path);
    publish_background(&app);
    Some(job)
}

#[tauri::command]
fn engine_progress(app: AppHandle, window: tauri::WebviewWindow, status: serde_json::Value) {
    if let Some(book) = app.state::<PendingJobs>().0.lock().unwrap().running.get_mut(window.label()) {
        book.status = status;
    }
    publish_background(&app);
}

#[tauri::command]
fn engine_log(app: AppHandle, window: tauri::WebviewWindow, entry: serde_json::Value) {
    let _ = app.emit_to("worker", "engine-log", serde_json::json!({ "engine": window.label(), "entry": entry }));
}

#[tauri::command]
fn engine_finish(app: AppHandle, window: tauri::WebviewWindow, result: Option<serde_json::Value>) {
    let state = app.state::<PendingJobs>();
    let mut s = state.0.lock().unwrap();
    let Some(book) = s.running.remove(window.label()) else { return };
    let success = result.is_some();
    if let Some(r) = result {
        s.recent.retain(|old| old["source"] != r["source"]);
        s.recent.insert(0, r);
        s.recent.truncate(30);
        persist_recent(&app, &s.recent);
    }
    drop(s);
    lifecycle_log(&app, window.label(), if success { "FINISH" } else { "FAIL" }, &book.job.path);
    publish_background(&app);
    wake_engines(&app);
}

#[tauri::command]
fn background_state(state: tauri::State<PendingJobs>) -> BackgroundState {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
fn set_book_parallelism(app: AppHandle, count: usize) -> Result<(), String> {
    if !(1..=4).contains(&count) { return Err("同时翻几本只能选 1–4".into()); }
    let path = settings_path(&app, "book-parallelism.json").ok_or("找不到设置目录")?;
    std::fs::write(path, count.to_string()).map_err(|e| e.to_string())?;
    app.state::<PendingJobs>().0.lock().unwrap().parallelism = count;
    publish_background(&app);
    wake_engines(&app);
    Ok(())
}

#[tauri::command]
fn background_pause(app: AppHandle) {
    let state = app.state::<PendingJobs>();
    let mut s = state.0.lock().unwrap();
    s.paused = !s.paused;
    let paused = s.paused;
    drop(s);
    let _ = app.emit("engines-paused", paused);
    publish_background(&app);
    if !paused { wake_engines(&app); }
}

#[tauri::command]
fn recent_init(app: AppHandle, recent: Vec<serde_json::Value>) {
    let state = app.state::<PendingJobs>();
    let mut s = state.0.lock().unwrap();
    for r in recent {
        if !s.recent.iter().any(|old| old["source"] == r["source"] && old["at"] == r["at"]) { s.recent.push(r); }
    }
    s.recent.sort_by_key(|r| std::cmp::Reverse(r["at"].as_u64().unwrap_or(0)));
    s.recent.truncate(30);
    persist_recent(&app, &s.recent);
    drop(s);
    publish_background(&app);
}

#[tauri::command]
fn recent_imported(app: AppHandle, source: String) {
    let state = app.state::<PendingJobs>();
    let mut s = state.0.lock().unwrap();
    for r in &mut s.recent { if r["source"].as_str() == Some(&source) { r["zotero"] = true.into(); } }
    persist_recent(&app, &s.recent);
    drop(s);
    publish_background(&app);
}

// 页面推过来的状态（见 www/index.html 里的 trayState）
#[derive(serde::Deserialize)]
struct TrayState {
    mood: String,
    title: String,
    book: String,
    line: String,
    fail_line: String,
    queue: Vec<String>,
    paused: bool,
    busy: bool,
    has_last: bool,
    notify: bool,
    // v51：页面画好的“小鱼 + 两行字”整张图（PNG）；有它就直接用，没有就按表情用单张图标
    #[serde(default)]
    image: Option<Vec<u8>>,
}

fn build_menu(app: &AppHandle, st: &TrayState) -> tauri::Result<Menu<Wry>> {
    let m = Menu::new(app)?;
    let none = None::<&str>;
    if !st.book.is_empty() {
        m.append(&MenuItem::with_id(app, "book", &st.book, false, none)?)?;
    }
    if !st.line.is_empty() {
        m.append(&MenuItem::with_id(app, "line", &st.line, false, none)?)?;
    }
    if !st.fail_line.is_empty() {
        m.append(&MenuItem::with_id(app, "progress", &st.fail_line, true, none)?)?;
    }
    if !st.queue.is_empty() {
        m.append(&PredefinedMenuItem::separator(app)?)?;
        m.append(&MenuItem::with_id(app, "queue_head", "接下来", false, none)?)?;
        for (i, q) in st.queue.iter().enumerate() {
            m.append(&MenuItem::with_id(app, format!("queue_{}", i), format!("　{}", q), false, none)?)?;
        }
    }
    m.append(&PredefinedMenuItem::separator(app)?)?;
    // v53：交给后台引擎翻（不打开阅读器）
    m.append(&MenuItem::with_id(app, "bg_open", "后台翻译文件…", true, none)?)?;
    let pause_text = if st.paused { "继续翻译" } else { "暂停翻译" };
    m.append(&MenuItem::with_id(app, "pause", pause_text, st.busy || st.paused, Some("CmdOrCtrl+P"))?)?;
    m.append(&MenuItem::with_id(app, "open_last", "打开上一份双栏 PDF", st.has_last, none)?)?;
    m.append(&MenuItem::with_id(app, "reveal", "在访达中显示", st.has_last, none)?)?;
    m.append(&PredefinedMenuItem::separator(app)?)?;
    m.append(&MenuItem::with_id(app, "show", "显示窗口", true, Some("CmdOrCtrl+0"))?)?;
    // v54：打开后台引擎的窗口，看当前任务和日志
    m.append(&MenuItem::with_id(app, "worker_show", "打开后台面板", true, none)?)?;
    m.append(&CheckMenuItem::with_id(app, "notify", "翻完通知我", true, st.notify, none)?)?;
    m.append(&PredefinedMenuItem::separator(app)?)?;
    m.append(&MenuItem::with_id(app, "quit", "退出 PDF译", true, Some("CmdOrCtrl+Q"))?)?;
    Ok(m)
}

// 页面上的状态一变，就调这个：换表情、换文字、重建菜单
#[tauri::command]
fn tray_update(app: AppHandle, window: tauri::WebviewWindow, state: TrayState) -> Result<(), String> {
    if window.label() == "main" {
        let bg = app.state::<PendingJobs>();
        let s = bg.0.lock().unwrap();
        if !s.running.is_empty() || !s.queue.is_empty() { return Ok(()); }
    }
    let tray = app.tray_by_id("main").ok_or("菜单栏图标还没建好")?;
    let composed = state.image.as_ref().map_or(false, |b| !b.is_empty());
    let img = match state.image.as_ref() {
        Some(b) if !b.is_empty() => Image::from_bytes(b),
        _ => Image::from_bytes(mood_icon(&state.mood)),
    }
    .map_err(|e| e.to_string())?;
    tray.set_icon(Some(img)).map_err(|e| e.to_string())?;
    let _ = tray.set_icon_as_template(true);
    // 两行字已经画进图里了，就不再另外显示一行文字
    let title = if composed || state.title.is_empty() { None } else { Some(state.title.clone()) };
    tray.set_title(title).map_err(|e| e.to_string())?;
    let tip = if state.line.is_empty() { "PDF译".to_string() } else { format!("PDF译：{}", state.line) };
    let _ = tray.set_tooltip(Some(tip));
    let menu = build_menu(&app, &state).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(())
}

// 本地安全口令：保存在 ~/.pdfyi-token，与 Zotero 插件共享以防止恶意网页跨站请求本地服务。
fn get_or_create_token() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let token_path = std::path::Path::new(&home).join(".pdfyi-token");
    if let Ok(content) = std::fs::read_to_string(&token_path) {
        let t = content.trim().to_string();
        if !t.is_empty() { return t; }
    }
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let token = format!("{:032x}", seed ^ 0x5a7c2b3d4e5f6071);
    let _ = std::fs::write(&token_path, &token);
    token
}

// Zotero 插件在本地服务注册的接口；由原生层请求，携带本地口令，拦截跨站调用。
fn zotero_post(endpoint: &str, body: serde_json::Value) -> Result<String, String> {
    let token = get_or_create_token();
    let url = format!("http://127.0.0.1:23119{}", endpoint);
    match ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("Zotero-Allowed-Request", "true")
        .set("X-PDFYi-Token", &token)
        .timeout(Duration::from_secs(120))
        .send_json(body)
    {
        Ok(r) => r.into_string().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => {
            let t = r.into_string().unwrap_or_default();
            Err(format!("Zotero 返回 {}：{}", code, t))
        }
        Err(e) => Err(format!("连不上 Zotero（Zotero 开着吗？插件装了吗？）：{}", e)),
    }
}

// 把双栏 PDF 交给 Zotero 插件挂回原条目。
#[tauri::command]
fn zotero_attach(body: serde_json::Value) -> Result<String, String> {
    zotero_post("/pdfyi/attach", body)
}

// 本地翻好的原文和双栏 PDF 一起导入 Zotero。
#[tauri::command]
fn zotero_import(body: serde_json::Value) -> Result<String, String> {
    zotero_post("/pdfyi/import", body)
}

// 用系统默认程序打开文件（“打开上一份双栏 PDF”）
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// 在访达里选中这个文件
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open").args(["-R", &path]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_main(app: AppHandle) {
    show_window(&app);
}

#[cfg(target_os = "macos")]
fn finish_startup(app: &AppHandle) {
    if APP_READY.load(Ordering::SeqCst) && LAUNCH_DECIDED.load(Ordering::SeqCst)
        && STARTUP_PENDING.swap(false, Ordering::SeqCst)
        && NORMAL_LAUNCH.load(Ordering::SeqCst) && !LINK_LAUNCH.load(Ordering::SeqCst)
    {
        show_window(app);
    }
}

// 使用 AppKit 的启动意图，不用“等几百毫秒没收到 URL 就显示”的时间猜测。
// 通知和 Tauri Ready 谁先到都可以；必须两者都完成后才决定是否打开阅读器。
#[cfg(target_os = "macos")]
fn observe_application(app: &AppHandle) -> [objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2::runtime::NSObjectProtocol>>; 2] {
    use objc2_app_kit::{NSApplicationDidFinishLaunchingNotification, NSApplicationDidHideNotification, NSApplicationLaunchIsDefaultLaunchKey};
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSNumber};
    let h = app.clone();
    let launched = block2::RcBlock::new(move |notification: std::ptr::NonNull<NSNotification>| {
        let note = unsafe { notification.as_ref() };
        let normal = note.userInfo()
            .and_then(|info| info.objectForKey(unsafe { NSApplicationLaunchIsDefaultLaunchKey }))
            .and_then(|value| value.downcast::<NSNumber>().ok())
            .is_some_and(|value| value.boolValue());
        NORMAL_LAUNCH.store(normal, Ordering::SeqCst);
        LAUNCH_DECIDED.store(true, Ordering::SeqCst);
        finish_startup(&h);
    });
    let h = app.clone();
    let hidden = block2::RcBlock::new(move |_: std::ptr::NonNull<NSNotification>| {
        let _ = h.set_activation_policy(tauri::ActivationPolicy::Accessory);
    });
    // NSApplication 的生命周期通知在主线程发送；队列为 None，闭包只捕获可 Send 的 AppHandle。
    unsafe {
        let center = NSNotificationCenter::defaultCenter();
        [
            center.addObserverForName_object_queue_usingBlock(Some(NSApplicationDidFinishLaunchingNotification), None, None, &launched),
            center.addObserverForName_object_queue_usingBlock(Some(NSApplicationDidHideNotification), None, None, &hidden),
        ]
    }
}

fn show_window(app: &AppHandle) {
    STARTUP_PENDING.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    // Accessory 程序被明确要求打开阅读器时，光 makeKeyAndOrderFront 不会激活应用。
    // 只在这条用户意图路径主动激活；后台链接从不走这里。
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(|| {
        if let Some(mtm) = objc2::MainThreadMarker::new() {
            #[allow(deprecated)]
            objc2_app_kit::NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        }
    });
}

fn main() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(false);
    let mut app = builder
        // 已经开着时再被叫起来（比如 Zotero 又交来一本），不再开第二个，链接交给开着的那个
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let links: Vec<_> = argv.iter().filter(|s| s.starts_with("pdfyi:")).collect();
            if links.is_empty() { show_window(app); }
            else { for url in links { push_job(app, url.clone()); } }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            tray_update,
            engine_pull,
            engine_progress,
            engine_finish,
            engine_log,
            background_state,
            background_pause,
            set_book_parallelism,
            recent_init,
            recent_imported,
            bg_pick,
            zotero_attach,
            zotero_import,
            open_path,
            reveal_path,
            show_main
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let parallelism = settings_path(app.handle(), "book-parallelism.json")
                .and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| s.parse::<usize>().ok())
                .filter(|n| (1..=4).contains(n)).unwrap_or(2);
            let recent = settings_path(app.handle(), "background-recent.json")
                .and_then(|p| std::fs::read(p).ok()).and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
            app.manage(PendingJobs(Mutex::new(BackgroundState {
                queue: VecDeque::new(), running: HashMap::new(), recent, parallelism, paused: false,
            })));
            // Zotero 交来的链接：程序已经开着时走这里
            let h = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for u in event.urls() {
                    push_job(&h, u.to_string());
                }
            });
            // 程序是被链接叫起来的：启动时就带着的链接
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for u in urls {
                    push_job(app.handle(), u.to_string());
                }
            }
            let idle = TrayState {
                mood: "sleeping".into(), title: String::new(), book: String::new(), line: String::new(),
                fail_line: String::new(), queue: vec![], paused: false, busy: false,
                has_last: false, notify: true, image: None,
            };
            let menu = build_menu(app.handle(), &idle)?;
            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(SLEEPING)?)
                .icon_as_template(true)
                .tooltip("PDF译")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } = event {
                        toggle_popover(tray.app_handle(), Some(position));
                    }
                })
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "show" => show_window(app),
                    // 由这里弹对话框（不要让看不见的窗口去弹），选好的文件交给后台引擎
                    "bg_open" => pick_files_job(app),
                    "worker_show" => toggle_popover(app, None),
                    "quit" => app.exit(0),
                    // 暂停、打开逐页进度、打开上一份、在访达中显示、通知开关：交给页面处理
                    other => {
                        let _ = app.emit("tray-action", other.to_string());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // 关窗口 = 藏起来，翻译接着跑；真正退出用菜单栏里的“退出 PDF译”
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    if window.label() == "main" {
                        #[cfg(target_os = "macos")]
                        let _ = window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                }
                // 面板（worker 窗口）点到别处就收起；它藏起来以后照样在翻
                WindowEvent::Focused(false) if window.label() == "worker" => {
                    LAST_HIDE.store(now_ms(), Ordering::Relaxed);
                    let _ = window.hide();
                }
                WindowEvent::Focused(false) if window.label() == "main" && !window.is_visible().unwrap_or(false) => {
                    #[cfg(target_os = "macos")]
                    let _ = window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("PDF译 启动失败");
    // 必须在 run() 前设置 Tao 的启动策略；setup 时才改会先短暂应用默认 Regular，
    // 即使 Info.plist 是 LSUIElement，也可能闪一下 Dock 图标。
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    #[cfg(target_os = "macos")]
    let _application_observers = observe_application(app.handle());
    app.run(|app, event| {
            match event {
                tauri::RunEvent::Ready => {
                    #[cfg(target_os = "macos")]
                    {
                        APP_READY.store(true, Ordering::SeqCst);
                        finish_startup(app);
                    }
                    #[cfg(not(target_os = "macos"))]
                    if !LINK_LAUNCH.load(Ordering::SeqCst) { show_window(app); }
                }
                tauri::RunEvent::Reopen { .. } => {
                    if !STARTUP_PENDING.load(Ordering::SeqCst) { show_window(app); }
                }
                _ => {}
            }
        });
}
