//! macOS Dock menu with "New Window", and Dock or system quit routed through the save guard.
//!
//! Tauri has no Dock menu API, so these methods are added to the application delegate that tao
//! (Tauri's window layer) registers; tao implements neither of them.

use objc2::ffi::class_addMethod;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply, NSMenu, NSMenuItem};
use objc2_foundation::NSString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Set once the app's own guarded exit has been approved.
pub static EXITING: AtomicBool = AtomicBool::new(false);

unsafe extern "C-unwind" fn dock_menu(this: &AnyObject, _: Sel, _: *mut AnyObject) -> *mut NSMenu {
    let Some(mtm) = MainThreadMarker::new() else {
        return std::ptr::null_mut();
    };
    let menu = NSMenu::new(mtm);
    let item = NSMenuItem::initWithTitle_action_keyEquivalent(
        NSMenuItem::alloc(mtm),
        &NSString::from_str(tr!("新建窗口", "New Window")),
        Some(sel!(writerNewWindow:)),
        &NSString::from_str(""),
    );
    item.setTarget(Some(this));
    menu.addItem(&item);
    Retained::autorelease_return(menu)
}

unsafe extern "C-unwind" fn new_window(_: &AnyObject, _: Sel, _: *mut AnyObject) {
    if let Some(app) = APP.get().cloned() {
        tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::commands::windows::create(&app, false) {
                eprintln!("[windows] could not open a window: {error}");
            }
        });
    }
}

/// Dock "Quit", logout and shutdown call terminate: directly, skipping Tauri's exit request.
unsafe extern "C-unwind" fn should_terminate(
    _: &AnyObject,
    _: Sel,
    _: *mut AnyObject,
) -> NSApplicationTerminateReply {
    if EXITING.load(Ordering::SeqCst) {
        return NSApplicationTerminateReply::TerminateNow;
    }
    match APP.get().cloned() {
        Some(app) => {
            // The guarded exit flushes every window, then exits through Tauri.
            tauri::async_runtime::spawn(async move { app.exit(0) });
            NSApplicationTerminateReply::TerminateCancel
        }
        None => NSApplicationTerminateReply::TerminateNow,
    }
}

/// Call on the main thread once the app has launched (Tauri's setup hook).
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
        return;
    };
    let object: &AnyObject = delegate.as_ref();
    let class = object.class() as *const AnyClass as *mut AnyClass;
    // SAFETY: each function matches its type encoding: object return or void, then self, _cmd and
    // one object argument; NSApplicationTerminateReply is an NSUInteger ("Q").
    unsafe {
        type Menu = unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> *mut NSMenu;
        type Action = unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject);
        type Reply = unsafe extern "C-unwind" fn(
            &AnyObject,
            Sel,
            *mut AnyObject,
        ) -> NSApplicationTerminateReply;
        class_addMethod(
            class,
            sel!(applicationDockMenu:),
            std::mem::transmute::<Menu, Imp>(dock_menu),
            c"@@:@".as_ptr(),
        );
        class_addMethod(
            class,
            sel!(writerNewWindow:),
            std::mem::transmute::<Action, Imp>(new_window),
            c"v@:@".as_ptr(),
        );
        class_addMethod(
            class,
            sel!(applicationShouldTerminate:),
            std::mem::transmute::<Reply, Imp>(should_terminate),
            c"Q@:@".as_ptr(),
        );
    }
    // AppKit may record which optional delegate methods exist when the delegate is assigned;
    // assign it again so it sees the ones just added.
    let ns_app = NSApplication::sharedApplication(mtm);
    ns_app.setDelegate(None);
    ns_app.setDelegate(Some(&delegate));
}
