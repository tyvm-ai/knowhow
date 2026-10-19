//! Objective-C classes: the per-window target/delegate and a flipped view.

use super::state::WinState;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, Sel};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSControl, NSControlTextEditingDelegate, NSEvent, NSEventModifierFlags, NSPanel, NSTableView, NSTableViewDataSource, NSTableViewDelegate,
    NSTextDelegate, NSTextFieldDelegate, NSTextView, NSTextViewDelegate, NSUserInterfaceItemIdentification, NSView, NSWindow, NSWindowDelegate,
};
use objc2_foundation::{
    MainThreadMarker, NSInteger, NSNotification, NSObject, NSObjectProtocol, NSString,
};

define_class!(
    #[unsafe(super = NSView)]
    #[thread_kind = MainThreadOnly]
    #[name = "KhFlippedView"]
    pub struct FlippedView;

    impl FlippedView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }
    }
);

define_class!(
    /// Non-activating panel that can still become key: it receives keyboard
    /// input without the (unbundled, Accessory) host having to become the
    /// active app, like Spotlight/Alfred. Because the app is not active there
    /// is no menu bar, so the standard edit shortcuts are handled here.
    #[unsafe(super = NSPanel)]
    #[thread_kind = MainThreadOnly]
    #[name = "KhPanel"]
    pub struct KhPanel;

    impl KhPanel {
        #[unsafe(method(canBecomeKeyWindow))]
        fn can_become_key(&self) -> bool {
            true
        }

        #[unsafe(method(canBecomeMainWindow))]
        fn can_become_main(&self) -> bool {
            false
        }

        #[unsafe(method(performKeyEquivalent:))]
        fn perform_key_equivalent(&self, event: &NSEvent) -> Bool {
            let flags = event.modifierFlags() & NSEventModifierFlags::DeviceIndependentFlagsMask;
            if flags == NSEventModifierFlags::Command {
                let ch = event.charactersIgnoringModifiers().map(|s| s.to_string()).unwrap_or_default();
                let action = match ch.as_str() {
                    "c" => Some(sel!(copy:)),
                    "v" => Some(sel!(paste:)),
                    "x" => Some(sel!(cut:)),
                    "a" => Some(sel!(selectAll:)),
                    "z" => Some(sel!(undo:)),
                    _ => None,
                };
                if let Some(a) = action {
                    let app = NSApplication::sharedApplication(self.mtm());
                    let handled = unsafe { app.sendAction_to_from(a, None, None) };
                    if handled {
                        return Bool::YES;
                    }
                }
            } else if flags == (NSEventModifierFlags::Command | NSEventModifierFlags::Shift) {
                let ch = event.charactersIgnoringModifiers().map(|s| s.to_string()).unwrap_or_default();
                if ch.eq_ignore_ascii_case("z") {
                    let app = NSApplication::sharedApplication(self.mtm());
                    return Bool::new(unsafe { app.sendAction_to_from(sel!(redo:), None, None) });
                }
            }
            unsafe { msg_send![super(self), performKeyEquivalent: event] }
        }
    }
);

define_class!(
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[name = "KhWindowTarget"]
    #[ivars = WinState]
    pub struct Target;

    unsafe impl NSObjectProtocol for Target {}

    impl Target {
        #[unsafe(method(buttonClicked:))]
        fn button_clicked(&self, sender: &NSView) {
            if let Some(id) = ident(sender) {
                if !self.ivars().silent.get() {
                    self.ivars().emitter.click(&id);
                }
            }
        }

        #[unsafe(method(checkChanged:))]
        fn check_changed(&self, sender: &NSView) {
            if let Some(id) = ident(sender) {
                if !self.ivars().silent.get() {
                    let on = super::controls::button_checked(sender);
                    self.ivars().emitter.change_checked(&id, on);
                }
            }
        }

        #[unsafe(method(popupChanged:))]
        fn popup_changed(&self, sender: &NSView) {
            if let Some(id) = ident(sender) {
                if !self.ivars().silent.get() {
                    let idx = super::controls::popup_index(sender);
                    self.ivars().emitter.select(&id, idx);
                }
            }
        }
    }

    // Text fields (input / number): `controlTextDidChange:`.
    unsafe impl NSTextFieldDelegate for Target {
        #[unsafe(method(controlTextDidChange:))]
        fn control_text_did_change(&self, n: &NSNotification) {
            if self.ivars().silent.get() {
                return;
            }
            let Some(view) = notif_view(n) else { return };
            let Some(id) = ident(&view) else { return };
            let text = super::controls::field_string(&view);
            if super::controls::is_number_field(&view) {
                if let Ok(x) = text.trim().parse::<f64>() {
                    self.ivars().emitter.change_number(&id, x);
                }
            } else {
                self.ivars().emitter.change_text(&id, &text);
            }
        }
    }

    // Enter in a text field => `submit` (instead of target/action, which can
    // also fire when the field editor is torn down on hide/destroy).
    unsafe impl NSControlTextEditingDelegate for Target {
        #[unsafe(method(control:textView:doCommandBySelector:))]
        fn do_command(&self, control: &NSControl, _tv: &NSTextView, cmd: Sel) -> Bool {
            Bool::new(self.handle_command(control, cmd))
        }
    }
    unsafe impl NSTextViewDelegate for Target {}

    // Text area (NSTextView): `textDidChange:`.
    unsafe impl NSTextDelegate for Target {
        #[unsafe(method(textDidChange:))]
        fn text_did_change(&self, n: &NSNotification) {
            if self.ivars().silent.get() {
                return;
            }
            let Some(view) = notif_view(n) else { return };
            let Some(id) = ident(&view) else { return };
            let tv: &NSTextView = unsafe { &*(&*view as *const NSView as *const NSTextView) };
            let text = unsafe { tv.string() }.to_string();
            self.ivars().emitter.change_text(&id, &text);
        }
    }

    unsafe impl NSWindowDelegate for Target {
        #[unsafe(method(windowShouldClose:))]
        fn window_should_close(&self, sender: &NSWindow) -> bool {
            sender.orderOut(None);
            if let Some(mtm) = objc2_foundation::MainThreadMarker::new() {
                super::dialogs::refresh_policy(mtm);
            }
            self.ivars().emitter.close();
            false
        }

        #[unsafe(method(windowDidResize:))]
        fn window_did_resize(&self, n: &NSNotification) {
            if let Some(obj) = unsafe { n.object() } {
                if let Some(w) = obj.downcast_ref::<NSWindow>() {
                    let cs = w.contentLayoutRect().size;
                    super::window::relayout(self.ivars(), cs.width as f32, cs.height as f32);
                }
            }
        }
    }

    unsafe impl NSTableViewDataSource for Target {
        #[unsafe(method(numberOfRowsInTableView:))]
        fn number_of_rows(&self, table: &NSTableView) -> NSInteger {
            let id = ident_any(table);
            let lists = self.ivars().lists.borrow();
            id.and_then(|i| lists.get(&i).map(|v| v.len())).unwrap_or(0) as NSInteger
        }

        #[unsafe(method_id(tableView:objectValueForTableColumn:row:))]
        fn object_value(
            &self,
            table: &NSTableView,
            _col: Option<&AnyObject>,
            row: NSInteger,
        ) -> Option<Retained<AnyObject>> {
            self.cell_value(table, row)
        }
    }

    unsafe impl NSTableViewDelegate for Target {
        #[unsafe(method(tableViewSelectionDidChange:))]
        fn selection_changed(&self, n: &NSNotification) {
            if self.ivars().silent.get() {
                return;
            }
            let Some(view) = notif_view(n) else { return };
            let Some(id) = ident(&view) else { return };
            let tv: &NSTableView = unsafe { &*(&*view as *const NSView as *const NSTableView) };
            let row = unsafe { tv.selectedRow() };
            self.ivars().emitter.select(&id, row as i64);
        }
    }
);

impl Target {
    fn handle_command(&self, control: &NSControl, cmd: Sel) -> bool {
        if cmd != sel!(insertNewline:) || self.ivars().silent.get() {
            return false;
        }
        let v: &NSView = control;
        let Some(id) = ident(v) else { return false };
        if super::controls::is_number_field(v) {
            return false;
        }
        let text = super::controls::field_string(v);
        self.ivars().emitter.submit(&id, &text);
        true
    }

    fn cell_value(&self, table: &NSTableView, row: NSInteger) -> Option<Retained<AnyObject>> {
        let id = ident_any(table)?;
        let lists = self.ivars().lists.borrow();
        let s = lists.get(&id)?.get(row as usize)?;
        let ns = NSString::from_str(s);
        Some(unsafe { Retained::cast_unchecked(ns) })
    }

    pub fn new(mtm: MainThreadMarker, state: WinState) -> Retained<Target> {
        let this = mtm.alloc::<Target>().set_ivars(state);
        unsafe { msg_send![super(this), init] }
    }
}

impl FlippedView {
    pub fn new(mtm: MainThreadMarker) -> Retained<FlippedView> {
        let this = mtm.alloc::<FlippedView>().set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

pub fn ident(v: &NSView) -> Option<String> {
    unsafe { v.identifier() }.map(|s| s.to_string()).filter(|s| !s.is_empty())
}

fn ident_any(t: &NSTableView) -> Option<String> {
    let v: &NSView = t;
    ident(v)
}

fn notif_view(n: &NSNotification) -> Option<Retained<NSView>> {
    let obj = unsafe { n.object() }?;
    obj.downcast::<NSView>().ok()
}
