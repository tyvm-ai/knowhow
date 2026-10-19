//! macOS AppKit [`UiBackend`]. Lives on the main (tao event loop) thread.
#![allow(unused_unsafe)]

mod controls;
mod dialogs;
mod measure;
mod state;
mod target;
mod tooltip;
mod window;

use super::{DialogReply, DialogRequest, GuiEmitter, Patch, TooltipRequest, UiBackend, WindowSpec};
use objc2_foundation::MainThreadMarker;
use std::collections::HashMap;
use objc2::DefinedClass;
use window::Win;

pub struct AppKitBackend {
    mtm: MainThreadMarker,
    windows: HashMap<(String, String), Win>,
    tips: HashMap<String, tooltip::Tip>,
}

impl AppKitBackend {
    /// Must be called on the main thread.
    pub fn new() -> Result<AppKitBackend, String> {
        let mtm = MainThreadMarker::new().ok_or("AppKit backend must be created on the main thread")?;
        Ok(AppKitBackend { mtm, windows: HashMap::new(), tips: HashMap::new() })
    }

    fn win(&self, owner: &str, id: &str) -> Result<&Win, String> {
        self.windows
            .get(&(owner.to_string(), id.to_string()))
            .ok_or_else(|| format!("unknown window '{id}'"))
    }
}

impl UiBackend for AppKitBackend {
    fn create_window(
        &mut self,
        owner: &str,
        window_id: &str,
        spec: &WindowSpec,
        emitter: GuiEmitter,
    ) -> Result<(), String> {
        let w = window::create(self.mtm, spec, emitter)?;
        self.windows.insert((owner.to_string(), window_id.to_string()), w);
        Ok(())
    }

    fn apply_patch(&mut self, owner: &str, window_id: &str, patches: &[Patch]) -> Result<(), String> {
        window::apply_patches(self.win(owner, window_id)?, patches)
    }

    fn show(&mut self, owner: &str, window_id: &str) -> Result<(), String> {
        let w = self.win(owner, window_id)?;
        // Windows are non-activating panels (see target::KhPanel): they become
        // key (keyboard input) without activating the Accessory host app.
        w.window.makeKeyAndOrderFront(None);
        w.window.orderFrontRegardless();
        Ok(())
    }

    fn hide(&mut self, owner: &str, window_id: &str) -> Result<(), String> {
        self.win(owner, window_id)?.window.orderOut(None);
        dialogs::refresh_policy(self.mtm);
        Ok(())
    }

    fn focus(&mut self, owner: &str, window_id: &str, control: Option<&str>) -> Result<(), String> {
        let w = self.win(owner, window_id)?;
        match control {
            Some(c) => window::focus_control(w, c),
            None => {
                w.window.makeKeyAndOrderFront(None);
                Ok(())
            }
        }
    }

    fn set_title(&mut self, owner: &str, window_id: &str, title: &str) -> Result<(), String> {
        self.win(owner, window_id)?.window.setTitle(&objc2_foundation::NSString::from_str(title));
        Ok(())
    }

    fn destroy(&mut self, owner: &str, window_id: &str) -> Result<(), String> {
        let w = self
            .windows
            .remove(&(owner.to_string(), window_id.to_string()))
            .ok_or_else(|| format!("unknown window '{window_id}'"))?;
        w.target.ivars().silent.set(true);
        w.window.setDelegate(None);
        w.window.orderOut(None);
        w.window.close();
        dialogs::refresh_policy(self.mtm);
        Ok(())
    }

    fn dialog(&mut self, _owner: &str, req: &DialogRequest, reply: DialogReply) {
        dialogs::run(self.mtm, req, reply);
    }

    fn tooltip(&mut self, owner: &str, req: &TooltipRequest) -> Result<(), String> {
        let slot = self.tips.remove(owner);
        let mut slot = slot;
        tooltip::show(self.mtm, &mut slot, req);
        if let Some(t) = slot {
            self.tips.insert(owner.to_string(), t);
        }
        Ok(())
    }

    fn clear_tooltip(&mut self, owner: &str) {
        if let Some(t) = self.tips.remove(owner) {
            t.hide();
        }
    }
}
