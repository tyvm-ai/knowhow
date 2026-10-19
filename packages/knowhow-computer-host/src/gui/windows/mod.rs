//! Win32 `UiBackend` (E3). Runs on the tao event-loop thread: tao pumps this
//! thread's message queue, so our windows' WndProcs receive their messages.
//! Windows are plain top-level `WS_OVERLAPPEDWINDOW`s with native child
//! controls positioned by the shared layout engine (see `arrange`).
//!
//! * `state`: per-window state + thread-local HWND registry.
//! * `window`: class / WndProc / create / show / destroy.
//! * `events`: message handling → `GuiEmitter`.
//! * `controls`: control creation + keyboard subclass (Tab, Enter).
//! * `arrange`: layout → SetWindowPos, fonts, DPI.
//! * `patch`: `guiPatch` props.  `dialogs`, `tooltip`: the rest.
//!
//! Visual styles (comctl32 v6) need an application manifest: see `build.rs`.

mod arrange;
mod controls;
mod dialogs;
mod events;
mod patch;
mod state;
mod tooltip;
mod util;
mod window;

use super::{DialogReply, DialogRequest, GuiEmitter, Patch, TooltipRequest, UiBackend, WindowSpec};
use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::UI::Controls::{InitCommonControlsEx, ICC_PROGRESS_CLASS, ICC_STANDARD_CLASSES, INITCOMMONCONTROLSEX};
use std::collections::HashMap;

pub(crate) fn init_common_controls() {
    let icc = INITCOMMONCONTROLSEX {
        dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
        dwICC: ICC_PROGRESS_CLASS | ICC_STANDARD_CLASSES,
    };
    unsafe {
        let _ = InitCommonControlsEx(&icc);
    }
}

#[derive(Default)]
pub struct Win32Backend {
    windows: HashMap<(String, String), HWND>,
}

impl Win32Backend {
    pub fn new() -> Win32Backend {
        Win32Backend::default()
    }

    fn get(&self, owner: &str, id: &str) -> Result<(HWND, std::rc::Rc<state::WinState>), String> {
        let h = *self.windows.get(&(owner.to_string(), id.to_string())).ok_or_else(|| format!("unknown window '{id}'"))?;
        let st = state::lookup(h).ok_or_else(|| format!("window '{id}' is gone"))?;
        Ok((h, st))
    }
}

impl UiBackend for Win32Backend {
    fn create_window(&mut self, owner: &str, window_id: &str, spec: &WindowSpec, emitter: GuiEmitter) -> Result<(), String> {
        let h = window::create(spec, emitter)?;
        self.windows.insert((owner.to_string(), window_id.to_string()), h);
        Ok(())
    }

    fn apply_patch(&mut self, owner: &str, window_id: &str, patches: &[Patch]) -> Result<(), String> {
        let (_, st) = self.get(owner, window_id)?;
        patch::apply(&st, patches)
    }

    fn show(&mut self, owner: &str, window_id: &str) -> Result<(), String> {
        let (h, _) = self.get(owner, window_id)?;
        window::show(h);
        Ok(())
    }

    fn hide(&mut self, owner: &str, window_id: &str) -> Result<(), String> {
        let (h, _) = self.get(owner, window_id)?;
        unsafe {
            let _ = ::windows::Win32::UI::WindowsAndMessaging::ShowWindow(h, ::windows::Win32::UI::WindowsAndMessaging::SW_HIDE);
        }
        Ok(())
    }

    fn focus(&mut self, owner: &str, window_id: &str, control: Option<&str>) -> Result<(), String> {
        let (h, st) = self.get(owner, window_id)?;
        let target = match control {
            Some(id) => Some(st.ctl_by_id(id).ok_or_else(|| format!("unknown control id '{id}'"))?.1.hwnd),
            None => None,
        };
        window::focus_control(h, target);
        Ok(())
    }

    fn set_title(&mut self, owner: &str, window_id: &str, title: &str) -> Result<(), String> {
        let (h, _) = self.get(owner, window_id)?;
        util::set_text(h, title);
        Ok(())
    }

    fn destroy(&mut self, owner: &str, window_id: &str) -> Result<(), String> {
        let key = (owner.to_string(), window_id.to_string());
        if let Some(h) = self.windows.remove(&key) {
            window::destroy(h);
        }
        Ok(())
    }

    fn dialog(&mut self, _owner: &str, req: &DialogRequest, reply: DialogReply) {
        dialogs::dialog(req, reply);
    }

    fn tooltip(&mut self, owner: &str, req: &TooltipRequest) -> Result<(), String> {
        tooltip::show(owner, req)
    }

    fn clear_tooltip(&mut self, owner: &str) {
        tooltip::clear_for(owner);
    }
}
