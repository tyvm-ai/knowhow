//! NSAlert based dialogs (alert / confirm / prompt).

use crate::gui::{DialogKind, DialogReply, DialogRequest, DialogResult};
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertSecondButtonReturn, NSApplication,
    NSApplicationActivationPolicy, NSTextField,
};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString};

/// The host runs as an Accessory (menu-bar only) app. macOS does not let a
/// bare Accessory executable become the active app when its window is clicked,
/// so keystrokes would keep going to the previously active app. While a form
/// or dialog is visible we switch to the Regular policy (Dock icon, like an
/// AHK GUI's taskbar button) and drop back to Accessory once none is visible.
pub fn activate(mtm: MainThreadMarker) {
    let app = NSApplication::sharedApplication(mtm);
    if app.activationPolicy() != NSApplicationActivationPolicy::Regular {
        app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    }
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
}

/// Return to the Accessory policy when no titled (main-capable) window is visible.
pub fn refresh_policy(mtm: MainThreadMarker) {
    let app = NSApplication::sharedApplication(mtm);
    let any_visible = app
        .windows()
        .iter()
        .any(|w| w.isVisible() && w.canBecomeMainWindow());
    if !any_visible && app.activationPolicy() != NSApplicationActivationPolicy::Accessory {
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    }
}

/// Runs the modal loop and answers `reply` before returning.
pub fn run(mtm: MainThreadMarker, req: &DialogRequest, reply: DialogReply) {
    activate(mtm);
    let alert = unsafe { NSAlert::new(mtm) };
    let (first, second) = match req.kind {
        DialogKind::Alert => ("OK", None),
        DialogKind::Confirm => ("Yes", Some("No")),
        DialogKind::Prompt => ("OK", Some("Cancel")),
    };
    let field = if req.kind == DialogKind::Prompt {
        let f = unsafe {
            NSTextField::textFieldWithString(&NSString::from_str(&req.default), mtm)
        };
        f.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(280.0, 24.0)));
        Some(f)
    } else {
        None
    };
    unsafe {
        alert.setMessageText(&NSString::from_str(if req.title.is_empty() { &req.message } else { &req.title }));
        if !req.title.is_empty() {
            alert.setInformativeText(&NSString::from_str(&req.message));
        }
        alert.addButtonWithTitle(&NSString::from_str(first));
        if let Some(s) = second {
            alert.addButtonWithTitle(&NSString::from_str(s));
        }
        if let Some(f) = &field {
            alert.setAccessoryView(Some(f));
            alert.window().setInitialFirstResponder(Some(f));
        }
    }
    let resp = unsafe { alert.runModal() };
    let ok = resp == NSAlertFirstButtonReturn;
    let result = match req.kind {
        DialogKind::Alert => DialogResult { button: "ok".into(), value: None },
        DialogKind::Confirm => DialogResult {
            button: if ok { "yes" } else { "no" }.into(),
            value: None,
        },
        DialogKind::Prompt => {
            if ok {
                let v = field.as_ref().map(|f| unsafe { f.stringValue() }.to_string()).unwrap_or_default();
                DialogResult { button: "ok".into(), value: Some(v) }
            } else {
                DialogResult { button: "cancel".into(), value: None }
            }
        }
    };
    let _ = NSAlertSecondButtonReturn;
    unsafe { alert.window().orderOut(None) };
    refresh_policy(mtm);
    reply(Ok(result));
}
