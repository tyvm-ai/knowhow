//! Backends that are not native adapters: [`StubBackend`] (Linux / fallback)
//! and [`RecordingBackend`] (tests).

use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

pub const UNSUPPORTED: &str = "native GUI not supported on this platform";

/// Errors for create/dialog; everything else is a harmless no-op.
#[derive(Debug, Default, Clone, Copy)]
pub struct StubBackend;

impl UiBackend for StubBackend {
    fn create_window(&mut self, _: &str, _: &str, _: &WindowSpec, _: GuiEmitter) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    fn apply_patch(&mut self, _: &str, _: &str, _: &[Patch]) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    fn show(&mut self, _: &str, _: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    fn hide(&mut self, _: &str, _: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    fn focus(&mut self, _: &str, _: &str, _: Option<&str>) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    fn set_title(&mut self, _: &str, _: &str, _: &str) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    fn destroy(&mut self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn dialog(&mut self, _: &str, _: &DialogRequest, reply: DialogReply) {
        reply(Err(UNSUPPORTED.into()));
    }
    fn tooltip(&mut self, _: &str, _: &TooltipRequest) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }
    fn clear_tooltip(&mut self, _: &str) {}
}

/// One recorded backend call.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Create { owner: String, window_id: String, spec: Box<WindowSpec> },
    Patch { owner: String, window_id: String, patches: Vec<Patch> },
    Show { owner: String, window_id: String },
    Hide { owner: String, window_id: String },
    Focus { owner: String, window_id: String, control: Option<String> },
    SetTitle { owner: String, window_id: String, title: String },
    Destroy { owner: String, window_id: String },
    Dialog { owner: String, req: DialogRequest },
    Tooltip { owner: String, req: TooltipRequest },
    ClearTooltip { owner: String },
}

/// Shared view of what a [`RecordingBackend`] saw (keep it after moving the
/// backend into a manager).
#[derive(Clone, Default)]
pub struct RecordingHandle {
    ops: Arc<Mutex<Vec<Op>>>,
    emitters: Arc<Mutex<HashMap<(String, String), GuiEmitter>>>,
}

impl RecordingHandle {
    pub fn ops(&self) -> Vec<Op> {
        self.ops.lock().unwrap().clone()
    }
    pub fn clear(&self) {
        self.ops.lock().unwrap().clear();
    }
    /// The emitter given to `create_window`; use it to simulate user input.
    pub fn emitter(&self, owner: &str, window_id: &str) -> Option<GuiEmitter> {
        self.emitters.lock().unwrap().get(&(owner.to_string(), window_id.to_string())).cloned()
    }
}

/// Records every call; windows are tracked so unknown ids error like a real
/// backend. Dialogs answer immediately: alert → ok, confirm → yes,
/// prompt → ok with the default text.
#[derive(Default)]
pub struct RecordingBackend {
    handle: RecordingHandle,
    windows: HashSet<(String, String)>,
    /// Fail `create_window` with this error when set.
    pub fail_create: Option<String>,
}

impl RecordingBackend {
    pub fn new() -> (RecordingBackend, RecordingHandle) {
        let b = RecordingBackend::default();
        let h = b.handle.clone();
        (b, h)
    }
    fn rec(&self, op: Op) {
        self.handle.ops.lock().unwrap().push(op);
    }
    fn check(&self, owner: &str, wid: &str) -> Result<(), String> {
        if self.windows.contains(&(owner.to_string(), wid.to_string())) {
            Ok(())
        } else {
            Err(format!("unknown window '{wid}'"))
        }
    }
}

fn s(x: &str) -> String {
    x.to_string()
}

impl UiBackend for RecordingBackend {
    fn create_window(&mut self, owner: &str, wid: &str, spec: &WindowSpec, em: GuiEmitter) -> Result<(), String> {
        self.rec(Op::Create { owner: s(owner), window_id: s(wid), spec: Box::new(spec.clone()) });
        if let Some(e) = &self.fail_create {
            return Err(e.clone());
        }
        self.windows.insert((s(owner), s(wid)));
        self.handle.emitters.lock().unwrap().insert((s(owner), s(wid)), em);
        Ok(())
    }
    fn apply_patch(&mut self, owner: &str, wid: &str, patches: &[Patch]) -> Result<(), String> {
        self.rec(Op::Patch { owner: s(owner), window_id: s(wid), patches: patches.to_vec() });
        self.check(owner, wid)
    }
    fn show(&mut self, owner: &str, wid: &str) -> Result<(), String> {
        self.rec(Op::Show { owner: s(owner), window_id: s(wid) });
        self.check(owner, wid)
    }
    fn hide(&mut self, owner: &str, wid: &str) -> Result<(), String> {
        self.rec(Op::Hide { owner: s(owner), window_id: s(wid) });
        self.check(owner, wid)
    }
    fn focus(&mut self, owner: &str, wid: &str, control: Option<&str>) -> Result<(), String> {
        self.rec(Op::Focus { owner: s(owner), window_id: s(wid), control: control.map(s) });
        self.check(owner, wid)
    }
    fn set_title(&mut self, owner: &str, wid: &str, title: &str) -> Result<(), String> {
        self.rec(Op::SetTitle { owner: s(owner), window_id: s(wid), title: s(title) });
        self.check(owner, wid)
    }
    fn destroy(&mut self, owner: &str, wid: &str) -> Result<(), String> {
        self.rec(Op::Destroy { owner: s(owner), window_id: s(wid) });
        self.handle.emitters.lock().unwrap().remove(&(s(owner), s(wid)));
        if self.windows.remove(&(s(owner), s(wid))) {
            Ok(())
        } else {
            Err(format!("unknown window '{wid}'"))
        }
    }
    fn dialog(&mut self, owner: &str, req: &DialogRequest, reply: DialogReply) {
        self.rec(Op::Dialog { owner: s(owner), req: req.clone() });
        let r = match req.kind {
            DialogKind::Alert => DialogResult { button: s("ok"), value: None },
            DialogKind::Confirm => DialogResult { button: s("yes"), value: None },
            DialogKind::Prompt => DialogResult { button: s("ok"), value: Some(req.default.clone()) },
        };
        reply(Ok(r));
    }
    fn tooltip(&mut self, owner: &str, req: &TooltipRequest) -> Result<(), String> {
        self.rec(Op::Tooltip { owner: s(owner), req: req.clone() });
        Ok(())
    }
    fn clear_tooltip(&mut self, owner: &str) {
        self.rec(Op::ClearTooltip { owner: s(owner) });
    }
}
