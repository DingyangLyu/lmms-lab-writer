#[macro_use]
mod l10n;
mod commands;
#[cfg(target_os = "macos")]
mod dock;

use commands::codex::CodexState;
use commands::fs::{ProjectState, WatcherState};
use commands::latex::LaTeXCompilationState;
use commands::opencode::OpenCodeState;
use commands::terminal::PtyState;
#[cfg(target_os = "macos")]
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

fn is_external_url(url: &url::Url, dev_port: u16) -> bool {
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return false;
    }

    let host = url.host_str().unwrap_or("");
    let port = url.port();

    if host == "localhost" || host == "127.0.0.1" {
        if let Some(p) = port {
            return p != dev_port;
        }
        return false;
    }

    if host == "tauri.localhost" {
        return false;
    }

    true
}

fn is_writer_page(url: &url::Url) -> bool {
    let local = url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")
        || cfg!(debug_assertions)
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
            && url.port() == Some(3000);
    local && matches!(url.path(), "" | "/" | "/index.html") || url.as_str() == "about:blank"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // reqwest and tokio-tungstenite together enable both rustls backends, which leaves no
    // default; without one, the first wss:// connection would panic.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(PtyState::default())
        .manage(OpenCodeState::default())
        .manage(CodexState::default())
        .manage(commands::claude::ClaudeState::default())
        .manage(commands::writer_bridge::BridgeState::default())
        .manage(commands::saving::SaveGuard::default())
        .manage(LaTeXCompilationState::default())
        .manage(commands::collab::CollabState::default())
        .manage(commands::runner::RunnerState::default())
        .manage(Mutex::new(WatcherState::default()))
        .manage(Mutex::new(ProjectState::default()))
        .manage(commands::windows::WindowState::default())
        .invoke_handler(tauri::generate_handler![
            commands::annotations::pdf_list_annotations,
            commands::annotations::pdf_add_annotation,
            commands::annotations::pdf_update_annotation,
            commands::annotations::pdf_ensure_annotation_versions,
            commands::annotations::pdf_prepare_annotations,
            commands::source_annotations::writer_annotation_locations,
            commands::source_annotations::add_text_annotation,
            commands::source_annotations::annotation_marks_for_document,
            commands::document_merge::merge_save_document,
            commands::document_merge::read_document_revision,
            commands::document_merge::list_document_conflicts,
            commands::document_merge::resolve_document_conflict,
            commands::pdf_text::pdf_prepare_preview,
            commands::annotations::pdf_repair_annotation_quotes,
            commands::writer_bridge::writer_register_conversation,
            commands::writer_bridge::writer_unregister_conversation,
            commands::writer_bridge::writer_delivery_prepared,
            commands::writer_bridge::writer_bridge_snapshot,
            commands::writer_bridge::writer_cancel_queued_task,
            commands::chat_images::read_chat_image,
            commands::chat_files::import_chat_file,
            commands::chat_files::import_chat_file_data,
            commands::chat_files::validate_chat_files,
            commands::writing::writing_list_sources,
            commands::writing::writing_apply_changes,
            commands::writing::bibliography_lookup_doi,
            commands::writing::bibliography_zotero_local,
            commands::collab::collab_sign_in,
            commands::collab::collab_sign_out,
            commands::collab::collab_accounts,
            commands::collab::collab_request,
            commands::collab::collab_connect,
            commands::collab::collab_send,
            commands::collab::collab_close,
            commands::locale::set_locale,
            commands::collab::collab_runner_get,
            commands::collab::collab_runner_register,
            commands::collab::collab_runner_unregister,
            commands::collab::collab_runner_call,
            commands::runner::runner_execute,
            commands::runner::runner_cancel,
            commands::folder_sync::sync_list,
            commands::folder_sync::sync_read,
            commands::folder_sync::sync_write,
            commands::folder_sync::sync_remove,
            commands::folder_sync::sync_move,
            commands::folder_sync::sync_state_load,
            commands::folder_sync::sync_state_save,
            commands::folder_sync::sync_link_get,
            commands::folder_sync::sync_link_set,
            commands::folder_sync::sync_create_folder,
            commands::reviews::review_begin,
            commands::reviews::review_list,
            commands::reviews::review_read,
            commands::reviews::review_decide,
            commands::reviews::review_finalize,
            commands::fs::set_project_path,
            commands::windows::open_window,
            commands::windows::focus_project_window,
            commands::windows::window_is_primary,
            commands::local_files::resolve_local_file,
            commands::local_files::reveal_local_file,
            commands::fs::read_file,
            commands::fs::write_file,
            commands::saving::checkpoint_document,
            commands::saving::read_document,
            commands::saving::list_document_backups,
            commands::saving::read_document_backup,
            commands::saving::export_document_copy,
            commands::saving::register_save_guard,
            commands::saving::finish_close,
            commands::fs::get_file_tree,
            commands::fs::watch_directory,
            commands::fs::stop_watch,
            commands::fs::create_file,
            commands::fs::create_directory,
            commands::fs::rename_path,
            commands::fs::delete_path,
            commands::git::git_status,
            commands::git_snapshots::git_snapshot_status,
            commands::git_snapshots::git_create_snapshot,
            commands::git_snapshots::git_snapshot_history,
            commands::git_snapshots::git_snapshot_diff,
            commands::git_snapshots::git_snapshot_file,
            commands::git::git_log,
            commands::git::git_graph,
            commands::git::git_diff,
            commands::git::git_discard_all,
            commands::git::git_discard_file,
            commands::git::git_unstage,
            commands::git::git_add,
            commands::git::git_commit,
            commands::git::git_fetch,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_init,
            commands::git::git_add_remote,
            commands::git::gh_check,
            commands::git::gh_auth_login,
            commands::git::gh_create_repo,
            commands::terminal::spawn_pty,
            commands::terminal::write_pty,
            commands::terminal::resize_pty,
            commands::terminal::kill_pty,
            commands::opencode::opencode_status,
            commands::opencode::opencode_start,
            commands::opencode::opencode_stop,
            commands::opencode::opencode_restart,
            commands::opencode::kill_port_process,
            commands::claude::claude_initialize,
            commands::claude::claude_list_sessions,
            commands::claude::claude_create_session,
            commands::claude::claude_read_session,
            commands::claude::claude_rename_session,
            commands::claude::claude_start_turn,
            commands::claude::claude_steer_turn,
            commands::claude::claude_respond_permission,
            commands::claude::claude_stop,
            commands::codex::codex_initialize,
            commands::codex::codex_list_models,
            commands::codex::codex_start_thread,
            commands::codex::codex_resume_thread,
            commands::codex::codex_list_threads,
            commands::codex::codex_read_thread,
            commands::codex::codex_rename_thread,
            commands::codex::codex_start_turn,
            commands::codex::codex_steer_turn,
            commands::codex::codex_interrupt_turn,
            commands::codex::codex_respond_to_request,
            commands::codex::codex_pending_requests,
            commands::latex::latex_detect_compilers,
            commands::latex_project::latex_project_load,
            commands::latex_project::latex_project_save,
            commands::latex_project::latex_scan_targets,
            commands::latex_build::latex_build_target,
            commands::templates::latex_import_template,
            commands::latex::latex_stop_compilation,
            commands::latex::latex_synctex_edit,
            commands::latex::latex_install_synctex,
            commands::latex::latex_get_distributions,
            commands::latex::latex_install,
            commands::latex::latex_open_download_page,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, MenuItemKind};
                let menu = Menu::default(app.handle())?;
                let items = menu.items()?;
                // The macOS predefined Quit item calls NSApplication.terminate directly,
                // bypassing ExitRequested. Route Cmd+Q through Tauri's guarded exit instead.
                let quit = MenuItem::with_id(
                    app.handle(),
                    "writer-safe-quit",
                    tr!("退出 LMMs-Lab Writer", "Quit LMMs-Lab Writer"),
                    true,
                    Some("CmdOrCtrl+Q"),
                )?;
                if let Some(MenuItemKind::Submenu(app_menu)) = items.first() {
                    if let Some(predefined) = app_menu.items()?.last() {
                        app_menu.remove(predefined)?;
                    }
                    app_menu.append(&quit)?;
                }
                let new_window = MenuItem::with_id(
                    app.handle(),
                    "writer-new-window",
                    tr!("新建窗口", "New Window"),
                    true,
                    Some("CmdOrCtrl+Shift+N"),
                )?;
                if let Some(MenuItemKind::Submenu(file)) = items.get(1) {
                    file.insert(&new_window, 0)?;
                }
                app.set_menu(menu)?;
                app.manage(commands::windows::NativeMenu { new_window, quit });
                dock::install(app.handle());
            }

            commands::windows::create(app.handle(), false)?;

            // A link that arrives while no window is open gets a window to handle it.
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |_| {
                if handle.webview_windows().is_empty() {
                    let _ = commands::windows::create(&handle, true);
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "writer-safe-quit" => app.exit(0),
            "writer-new-window" => {
                if let Err(error) = commands::windows::create(app, false) {
                    eprintln!("[windows] could not open a window: {error}");
                }
            }
            _ => {}
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let guard = window.state::<commands::saving::SaveGuard>();
                if guard.must_flush(window.label()) {
                    api.prevent_close();
                    let _ = window.emit_to(
                        window.label(),
                        "writer-close-requested",
                        serde_json::json!({"quit":false}),
                    );
                }
            }
            tauri::WindowEvent::Focused(true) => commands::windows::on_focused(window),
            tauri::WindowEvent::Destroyed => commands::windows::on_destroyed(window),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Application exit can bypass Drop for managed Tauri state. Release
            // the OpenCode process group explicitly after the save guard passes.
            tauri::RunEvent::Exit => {
                app.state::<OpenCodeState>().shutdown_now();
                app.state::<commands::claude::ClaudeState>().shutdown_now();
            }
            // Closing the last window: macOS apps stay in the Dock; elsewhere the app exits, as
            // every window has already flushed through its own close.
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                if cfg!(target_os = "macos") {
                    api.prevent_exit();
                }
            }
            // Quit: every window flushes its editors first, then finish_close exits.
            tauri::RunEvent::ExitRequested { api, .. } => {
                let windows = app.state::<commands::saving::SaveGuard>().begin_quit();
                if windows.is_empty() {
                    #[cfg(target_os = "macos")]
                    dock::EXITING.store(true, Ordering::SeqCst);
                    return;
                }
                api.prevent_exit();
                for label in windows {
                    let _ = app.emit_to(
                        label.as_str(),
                        "writer-close-requested",
                        serde_json::json!({"quit":true}),
                    );
                }
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => match commands::windows::primary(app) {
                Some(window) => commands::windows::focus(&window),
                None => {
                    let _ = commands::windows::create(app, false);
                }
            },
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_url(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn document_links_cannot_replace_the_writer_page() {
        assert!(is_writer_page(&parse_url("tauri://localhost/")));
        assert!(is_writer_page(&parse_url(
            "http://tauri.localhost/index.html"
        )));
        for url in [
            "tauri://localhost/main.pdf",
            "tauri://localhost/en/main.tex#L4",
            "file:///tmp/main.pdf",
            "https://example.com/main.pdf",
        ] {
            assert!(!is_writer_page(&parse_url(url)), "{url}");
        }
    }

    #[test]
    fn external_https_url_is_external() {
        assert!(is_external_url(&parse_url("https://example.com"), 3000));
    }

    #[test]
    fn localhost_same_port_is_not_external() {
        assert!(!is_external_url(&parse_url("http://localhost:3000"), 3000));
    }

    #[test]
    fn localhost_different_port_is_external() {
        assert!(is_external_url(&parse_url("http://localhost:4000"), 3000));
    }

    #[test]
    fn tauri_localhost_is_not_external() {
        assert!(!is_external_url(
            &parse_url("https://tauri.localhost"),
            3000
        ));
    }

    #[test]
    fn non_http_scheme_is_not_external() {
        assert!(!is_external_url(&parse_url("ftp://example.com"), 3000));
        assert!(!is_external_url(&parse_url("tauri://localhost"), 3000));
    }

    #[test]
    fn ip_127_same_port_is_not_external() {
        assert!(!is_external_url(&parse_url("http://127.0.0.1:3000"), 3000));
    }

    #[test]
    fn ip_127_different_port_is_external() {
        assert!(is_external_url(&parse_url("http://127.0.0.1:4000"), 3000));
    }
}
