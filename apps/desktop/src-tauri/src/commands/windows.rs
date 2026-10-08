//! Several Writer windows. Each shows at most one project, and a project is open in one window
//! only, so per-project state (buffers, watchers, sync, agents) never has two owners.

use super::fs::ProjectState;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, Window};
use tauri_plugin_opener::OpenerExt;

/// The first window; later ones are `writer-<n>`, so a label is never reused.
pub const FIRST: &str = "main";

#[derive(Default)]
pub struct WindowState {
    first_used: AtomicBool,
    next: AtomicU32,
    last_focused: Mutex<Option<String>>,
}

/// Opens a Writer window. `link` makes it handle the deep link that launched it.
pub fn create(app: &AppHandle, link: bool) -> tauri::Result<WebviewWindow> {
    let state = app.state::<WindowState>();
    let label = if !state.first_used.swap(true, Ordering::SeqCst) {
        FIRST.to_string()
    } else {
        format!("writer-{}", state.next.fetch_add(1, Ordering::SeqCst) + 1)
    };
    let url = if cfg!(debug_assertions) {
        WebviewUrl::External("http://localhost:3000".parse().expect("valid dev URL"))
    } else {
        WebviewUrl::App("index.html".into())
    };
    let mut builder = WebviewWindowBuilder::new(app, &label, url)
        .title("LMMs-Lab Writer")
        .inner_size(1400.0, 900.0)
        .min_inner_size(960.0, 640.0)
        .resizable(true);
    // Cascade from the window in front so a new one does not hide exactly behind it.
    builder =
        match focused(app).and_then(|w| Some((w.outer_position().ok()?, w.scale_factor().ok()?))) {
            Some((at, scale)) => {
                builder.position(at.x as f64 / scale + 28.0, at.y as f64 / scale + 28.0)
            }
            None => builder.center(),
        };
    if link {
        builder = builder.initialization_script("window.__WRITER_OPEN_LINK__ = true;");
    }
    let opener = app.clone();
    let target = label.clone();
    builder = builder.on_navigation(move |url| {
        if crate::is_external_url(url, 3000) {
            let url = url.to_string();
            let handle = opener.clone();
            std::thread::spawn(move || {
                let _ = handle.opener().open_url(&url, None::<&str>);
            });
            return false;
        }
        if crate::is_writer_page(url) {
            return true;
        }
        // A document link must never replace the application document.
        let _ = opener.emit_to(
            target.as_str(),
            "writer://open-link",
            serde_json::json!({"href":url.as_str()}),
        );
        false
    });
    let window = builder.build()?;
    #[cfg(debug_assertions)]
    window.open_devtools();
    Ok(window)
}

/// The window that answers app-wide requests such as deep links: the last one focused.
pub fn primary(app: &AppHandle) -> Option<WebviewWindow> {
    focused(app).or_else(|| {
        let mut windows: Vec<_> = app.webview_windows().into_values().collect();
        windows.sort_by(|a, b| a.label().cmp(b.label()));
        windows.into_iter().next()
    })
}

fn focused(app: &AppHandle) -> Option<WebviewWindow> {
    let label = app
        .state::<WindowState>()
        .last_focused
        .lock()
        .ok()?
        .clone()?;
    app.get_webview_window(&label)
}

pub fn focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn on_focused(window: &Window) {
    if let Ok(mut last) = window.state::<WindowState>().last_focused.lock() {
        *last = Some(window.label().to_string());
    }
}

/// Releases what a closed window held: its project, file watcher and terminals.
pub fn on_destroyed(window: &Window) {
    let label = window.label();
    if let Ok(mut projects) = window.state::<Mutex<ProjectState>>().lock() {
        projects.close(label);
    }
    if let Ok(mut watchers) = window.state::<Mutex<super::fs::WatcherState>>().lock() {
        watchers.stop(label);
    }
    super::terminal::kill_window(window.app_handle(), label);
    window
        .state::<super::latex::LaTeXCompilationState>()
        .close(label);
    window.state::<super::saving::SaveGuard>().forget(label);
    if let Ok(mut last) = window.state::<WindowState>().last_focused.lock() {
        if last.as_deref() == Some(label) {
            *last = None;
        }
    }
}

/// Window of the given canonical project root, if one has it open.
pub fn project_window(app: &AppHandle, project: &str) -> Option<WebviewWindow> {
    let label = app
        .state::<Mutex<ProjectState>>()
        .lock()
        .ok()?
        .window_with(project)?;
    app.get_webview_window(&label)
}

/// Async: creating a window from a synchronous command can deadlock on Windows.
#[tauri::command]
pub async fn open_window(app: AppHandle) -> Result<(), String> {
    create(&app, false).map(|_| ()).map_err(|e| e.to_string())
}

/// Brings forward the other window that has `path` open; false when no other window has it.
#[tauri::command]
pub fn focus_project_window(app: AppHandle, window: Window, path: String) -> Result<bool, String> {
    let Ok(canonical) = std::fs::canonicalize(&path) else {
        return Ok(false);
    };
    match project_window(&app, &canonical.to_string_lossy()) {
        Some(other) if other.label() != window.label() => {
            focus(&other);
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Whether this window should handle app-wide requests (all windows hear them).
#[tauri::command]
pub fn window_is_primary(app: AppHandle, window: Window) -> bool {
    primary(&app).is_some_and(|w| w.label() == window.label())
}

/// Writer's own macOS menu items, relabelled when the interface language changes.
#[cfg(target_os = "macos")]
pub struct NativeMenu {
    pub new_window: tauri::menu::MenuItem<tauri::Wry>,
    pub quit: tauri::menu::MenuItem<tauri::Wry>,
}

pub fn relabel_menu(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Some(menu) = app.try_state::<NativeMenu>() {
        let _ = menu.new_window.set_text(tr!("新建窗口", "New Window"));
        let _ = menu
            .quit
            .set_text(tr!("退出 LMMs-Lab Writer", "Quit LMMs-Lab Writer"));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
