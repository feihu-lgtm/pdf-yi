// PDF译 的 Mac 外壳。翻译、提取、生成双栏 PDF 都在页面（www/）里做，这里只负责：
//   1. 开窗口；关窗口时只是藏起来，翻译接着跑
//   0. 两个窗口：main 是全量版阅读器，worker 是看不见的后台引擎（Zotero 交来的书、“后台翻译文件…”都由它翻）
//   2. 菜单栏：小鱼按状态换表情，旁边显示进度文字；点开是一份随状态变化的菜单
//   3. 接收 Zotero 插件发来的 pdfyi:// 链接（交给页面处理）
//   4. 把翻好的双栏 PDF 交给 Zotero 插件挂回条目（从这里发请求，不受网页跨域限制）
//   5. 打开文件、在访达中显示
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicU64, Ordering};
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

// v54.1：后台任务一律由这里接收（Zotero 的 pdfyi:// 链接、菜单栏“后台翻译文件…”选的文件），
// 先放进待办列表，再通知后台引擎来取；后台引擎启动时也会取一次，所以通知没收到也不会丢。
// 链接原样存；本地文件存成 “file:路径”。
struct PendingJobs(Mutex<Vec<String>>);

fn push_job(app: &AppHandle, job: String) {
    if let Some(p) = app.try_state::<PendingJobs>() {
        if let Ok(mut v) = p.0.lock() {
            v.push(job);
        }
    }
    let _ = app.emit_to("worker", "pdfyi-job", ());
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

// 后台引擎来取待办任务（取走就清空）
#[tauri::command]
fn take_jobs(state: tauri::State<PendingJobs>) -> Vec<String> {
    match state.0.lock() {
        Ok(mut v) => std::mem::take(&mut *v),
        Err(_) => vec![],
    }
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
fn tray_update(app: AppHandle, state: TrayState) -> Result<(), String> {
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

// 把双栏 PDF 交给 Zotero 插件（插件在 Zotero 自带的本地服务上注册了 /pdfyi/attach）
#[tauri::command]
fn zotero_attach(body: serde_json::Value) -> Result<String, String> {
    let resp = ureq::post("http://127.0.0.1:23119/pdfyi/attach")
        .set("Content-Type", "application/json")
        .set("Zotero-Allowed-Request", "true")
        .timeout(Duration::from_secs(120))
        .send_json(body);
    match resp {
        Ok(r) => r.into_string().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => {
            let t = r.into_string().unwrap_or_default();
            Err(format!("Zotero 返回 {}：{}", code, t))
        }
        Err(e) => Err(format!("连不上 Zotero（Zotero 开着吗？插件装了吗？）：{}", e)),
    }
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

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        // 已经开着时再被叫起来（比如 Zotero 又交来一本），不再开第二个，链接交给开着的那个
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            tray_update,
            take_jobs,
            bg_pick,
            zotero_attach,
            open_path,
            reveal_path,
            show_main
        ])
        .setup(|app| {
            app.manage(PendingJobs(Mutex::new(vec![])));
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
                }
                // 面板（worker 窗口）点到别处就收起；它藏起来以后照样在翻
                WindowEvent::Focused(false) if window.label() == "worker" => {
                    LAST_HIDE.store(now_ms(), Ordering::Relaxed);
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("PDF译 启动失败")
        .run(|app, event| {
            // 点程序坞图标时把窗口叫回来
            if let tauri::RunEvent::Reopen { .. } = event {
                show_window(app);
            }
        });
}
