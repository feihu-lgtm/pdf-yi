// PDF译 的 Mac 外壳。翻译、提取、生成双栏 PDF 都在页面（www/）里做，这里只负责：
//   1. 开窗口；关窗口时只是藏起来，翻译接着跑
//   2. 菜单栏：小鱼头像随进度“染发”，旁边显示进度文字；点开是一份随状态变化的菜单
//   3. 接收 Zotero 插件发来的 pdfyi:// 链接（交给页面处理）
//   4. 把翻好的双栏 PDF 交给 Zotero 插件挂回条目（从这里发请求，不受网页跨域限制）
//   5. 打开文件、在访达中显示
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WindowEvent, Wry,
};

// 小鱼头像：0 是没染，8 是染满（打包进程序里）
const XIAOYU: [&[u8]; 9] = [
    include_bytes!("../icons/tray/xiaoyu-0.png"),
    include_bytes!("../icons/tray/xiaoyu-1.png"),
    include_bytes!("../icons/tray/xiaoyu-2.png"),
    include_bytes!("../icons/tray/xiaoyu-3.png"),
    include_bytes!("../icons/tray/xiaoyu-4.png"),
    include_bytes!("../icons/tray/xiaoyu-5.png"),
    include_bytes!("../icons/tray/xiaoyu-6.png"),
    include_bytes!("../icons/tray/xiaoyu-7.png"),
    include_bytes!("../icons/tray/xiaoyu-8.png"),
];

// 页面推过来的状态（见 www/index.html 里的 trayState）
#[derive(serde::Deserialize)]
struct TrayState {
    level: u8,
    title: String,
    book: String,
    line: String,
    fail_line: String,
    queue: Vec<String>,
    paused: bool,
    busy: bool,
    has_last: bool,
    notify: bool,
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
    let pause_text = if st.paused { "继续翻译" } else { "暂停翻译" };
    m.append(&MenuItem::with_id(app, "pause", pause_text, st.busy || st.paused, Some("CmdOrCtrl+P"))?)?;
    m.append(&MenuItem::with_id(app, "open_last", "打开上一份双栏 PDF", st.has_last, none)?)?;
    m.append(&MenuItem::with_id(app, "reveal", "在访达中显示", st.has_last, none)?)?;
    m.append(&PredefinedMenuItem::separator(app)?)?;
    m.append(&MenuItem::with_id(app, "show", "显示窗口", true, Some("CmdOrCtrl+0"))?)?;
    m.append(&CheckMenuItem::with_id(app, "notify", "翻完通知我", true, st.notify, none)?)?;
    m.append(&PredefinedMenuItem::separator(app)?)?;
    m.append(&MenuItem::with_id(app, "quit", "退出 PDF译", true, Some("CmdOrCtrl+Q"))?)?;
    Ok(m)
}

// 页面上的状态一变，就调这个：换头像、换文字、重建菜单
#[tauri::command]
fn tray_update(app: AppHandle, state: TrayState) -> Result<(), String> {
    let tray = app.tray_by_id("main").ok_or("菜单栏图标还没建好")?;
    let lv = state.level.min(8) as usize;
    let img = Image::from_bytes(XIAOYU[lv]).map_err(|e| e.to_string())?;
    tray.set_icon(Some(img)).map_err(|e| e.to_string())?;
    let _ = tray.set_icon_as_template(true);
    let title = if state.title.is_empty() { None } else { Some(state.title.clone()) };
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
            zotero_attach,
            open_path,
            reveal_path,
            show_main
        ])
        .setup(|app| {
            let idle = TrayState {
                level: 0, title: String::new(), book: String::new(), line: String::new(),
                fail_line: String::new(), queue: vec![], paused: false, busy: false,
                has_last: false, notify: true,
            };
            let menu = build_menu(app.handle(), &idle)?;
            TrayIconBuilder::with_id("main")
                .icon(Image::from_bytes(XIAOYU[0])?)
                .icon_as_template(true)
                .tooltip("PDF译")
                .menu(&menu)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "show" => show_window(app),
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
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
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
