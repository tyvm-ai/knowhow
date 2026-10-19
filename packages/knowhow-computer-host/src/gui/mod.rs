//! Native GUI (forms, dialogs, tooltips) — platform-independent core.
//!
//! * [`spec`]: serde types for the E0 form spec and patches.
//! * [`layout`]: layout engine (frames from the node tree).
//! * [`UiBackend`]: what a platform adapter (macOS AppKit = E2, Win32 = E3)
//!   implements. It is **not** `Send`; it lives on the main (tao event loop) thread.
//! * [`GuiManager`] (in [`manager`]): thread-safe front door used by IPC. It
//!   tracks windows per worker and forwards [`GuiCommand`]s to the thread that
//!   owns the backend (the tao loop in `tray.rs`, or inline for stub/tests).
//! * [`GuiEmitter`] / [`GuiEvent`]: how backends report user interaction;
//!   the host routes them to the owning worker as `guiEvent`.

pub mod backends;
pub mod demo;
pub mod layout;
pub mod manager;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;
pub mod spec;

pub use backends::{Op, RecordingBackend, RecordingHandle, StubBackend, UNSUPPORTED};
pub use manager::{inline_dispatch, Dispatch, GuiManager};
pub use spec::{Patch, WindowSpec};

use serde_json::{json, Value};
use std::sync::Arc;

/// Reply channel for a GUI request: called exactly once with the `result`
/// payload or an error string. Callable from any thread.
pub type Reply = Box<dyn FnOnce(Result<Value, String>) + Send>;

/// Where events from backends go (thread-safe).
pub type EventSink = Arc<dyn Fn(GuiEvent) + Send + Sync>;

/// A user interaction in a native window. `owner` = worker id.
#[derive(Debug, Clone, PartialEq)]
pub struct GuiEvent {
    pub owner: String,
    pub window_id: String,
    /// `None` for window-level events (`close`).
    pub control_id: Option<String>,
    /// `click` | `change` | `select` | `submit` | `close`
    pub event: String,
    /// text for input/textarea change/submit; number for `number` change.
    pub value: Option<Value>,
    pub selected: Option<i64>,
    pub checked: Option<bool>,
}

/// Alias used in the task brief.
pub type UiEvent = GuiEvent;

impl GuiEvent {
    /// The `guiEvent` NDJSON line sent to the worker.
    pub fn to_wire(&self) -> String {
        let mut v = json!({
            "type": "guiEvent",
            "windowId": self.window_id,
            "controlId": self.control_id,
            "event": self.event,
        });
        if let Some(x) = &self.value {
            v["value"] = x.clone();
        }
        if let Some(x) = self.selected {
            v["selected"] = json!(x);
        }
        if let Some(x) = self.checked {
            v["checked"] = json!(x);
        }
        v.to_string()
    }
}

/// Per-window emitter handed to the backend in `create_window`. Cheap to
/// clone; `Send + Sync`, so native callbacks / other threads may use it.
#[derive(Clone)]
pub struct GuiEmitter {
    owner: String,
    window_id: String,
    sink: EventSink,
}

impl GuiEmitter {
    pub fn new(owner: &str, window_id: &str, sink: EventSink) -> GuiEmitter {
        GuiEmitter { owner: owner.to_string(), window_id: window_id.to_string(), sink }
    }
    pub fn owner(&self) -> &str {
        &self.owner
    }
    pub fn window_id(&self) -> &str {
        &self.window_id
    }
    fn base(&self, control: Option<&str>, event: &str) -> GuiEvent {
        GuiEvent {
            owner: self.owner.clone(),
            window_id: self.window_id.clone(),
            control_id: control.map(|s| s.to_string()),
            event: event.to_string(),
            value: None,
            selected: None,
            checked: None,
        }
    }
    pub fn emit(&self, ev: GuiEvent) {
        (self.sink)(ev);
    }
    pub fn click(&self, control: &str) {
        self.emit(self.base(Some(control), "click"));
    }
    /// Text change (input/textarea).
    pub fn change_text(&self, control: &str, value: &str) {
        let mut e = self.base(Some(control), "change");
        e.value = Some(json!(value));
        self.emit(e);
    }
    /// Numeric change (`number` control).
    pub fn change_number(&self, control: &str, value: f64) {
        let mut e = self.base(Some(control), "change");
        e.value = Some(json!(value));
        self.emit(e);
    }
    pub fn change_checked(&self, control: &str, checked: bool) {
        let mut e = self.base(Some(control), "change");
        e.checked = Some(checked);
        self.emit(e);
    }
    /// Dropdown / listbox selection (`-1` = none).
    pub fn select(&self, control: &str, index: i64) {
        let mut e = self.base(Some(control), "select");
        e.selected = Some(index);
        self.emit(e);
    }
    /// Enter pressed in an input.
    pub fn submit(&self, control: &str, value: &str) {
        let mut e = self.base(Some(control), "submit");
        e.value = Some(json!(value));
        self.emit(e);
    }
    /// The window's close button was pressed. The backend must already have
    /// hidden the window (never destroy it on its own).
    pub fn close(&self) {
        self.emit(self.base(None, "close"));
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogKind {
    Alert,
    Confirm,
    Prompt,
}

impl DialogKind {
    pub fn parse(s: &str) -> Option<DialogKind> {
        match s {
            "alert" => Some(DialogKind::Alert),
            "confirm" => Some(DialogKind::Confirm),
            "prompt" => Some(DialogKind::Prompt),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DialogRequest {
    pub kind: DialogKind,
    pub title: String,
    pub message: String,
    /// initial text for `prompt`
    pub default: String,
}

/// `button`: `ok` | `cancel` | `yes` | `no`. alert → ok; confirm → yes/no;
/// prompt → ok (+`value`) / cancel.
#[derive(Debug, Clone, PartialEq)]
pub struct DialogResult {
    pub button: String,
    pub value: Option<String>,
}

impl DialogResult {
    pub fn to_json(&self) -> Value {
        match &self.value {
            Some(v) => json!({"button": self.button, "value": v}),
            None => json!({"button": self.button}),
        }
    }
}

pub type DialogReply = Box<dyn FnOnce(Result<DialogResult, String>) + Send>;

#[derive(Debug, Clone, PartialEq)]
pub struct TooltipRequest {
    /// "" hides.
    pub text: String,
    /// 0 = until replaced.
    pub ms: u64,
    /// `None` = near the mouse cursor (offset +16,+16). Screen coordinates (points/px).
    pub at: Option<(f64, f64)>,
}

/// Platform adapter. All methods are called on the thread that owns the
/// backend (main thread for real adapters); `owner` is the worker id and
/// `(owner, window_id)` is the window's unique key.
pub trait UiBackend {
    /// Create (hidden) a window from `spec`. Use [`layout::layout_window`] +
    /// [`layout::effective_size`] for frames. Report interaction via `emitter`.
    fn create_window(
        &mut self,
        owner: &str,
        window_id: &str,
        spec: &WindowSpec,
        emitter: GuiEmitter,
    ) -> Result<(), String>;
    /// Apply prop patches silently (no change/select events). Unknown control ids → error.
    fn apply_patch(&mut self, owner: &str, window_id: &str, patches: &[Patch]) -> Result<(), String>;
    /// Show and bring to front / activate.
    fn show(&mut self, owner: &str, window_id: &str) -> Result<(), String>;
    fn hide(&mut self, owner: &str, window_id: &str) -> Result<(), String>;
    /// Focus a control (or just the window when `control` is `None`).
    fn focus(&mut self, owner: &str, window_id: &str, control: Option<&str>) -> Result<(), String>;
    fn set_title(&mut self, owner: &str, window_id: &str, title: &str) -> Result<(), String>;
    fn destroy(&mut self, owner: &str, window_id: &str) -> Result<(), String>;
    /// Show a modal dialog. `reply` must be invoked exactly once, possibly
    /// later (after a nested run loop / from a native callback). Must not block
    /// other workers' IPC (the tokio runtime is on other threads).
    fn dialog(&mut self, owner: &str, req: &DialogRequest, reply: DialogReply);
    fn tooltip(&mut self, owner: &str, req: &TooltipRequest) -> Result<(), String>;
    /// Hide this worker's tooltip (cleanup).
    fn clear_tooltip(&mut self, owner: &str);
}

/// A unit of work for the backend thread.
pub enum GuiCommand {
    Request { owner: String, req: GuiRequest, reply: Reply, sink: EventSink },
    /// Destroy these windows and the tooltip of `owner` (disconnect / stop / kill).
    Cleanup { owner: String, windows: Vec<String> },
}

#[derive(Debug, Clone, PartialEq)]
pub enum GuiRequest {
    Create { window_id: String, spec: Box<WindowSpec>, show: bool },
    Patch { window_id: String, patches: Vec<Patch> },
    Show { window_id: String },
    Hide { window_id: String },
    Focus { window_id: String, control_id: Option<String> },
    SetTitle { window_id: String, title: String },
    Destroy { window_id: String },
    Dialog(DialogRequest),
    Tooltip(TooltipRequest),
}

impl GuiCommand {
    /// Answer the command with an error without running it (backend thread gone).
    pub fn fail(self, msg: &str) {
        if let GuiCommand::Request { reply, .. } = self {
            reply(Err(msg.to_string()));
        }
    }

    /// Run against `backend` (on the backend's thread). Always answers `reply`.
    pub fn execute(self, backend: &mut dyn UiBackend) {
        match self {
            GuiCommand::Cleanup { owner, windows } => {
                for w in windows {
                    let _ = backend.destroy(&owner, &w);
                }
                backend.clear_tooltip(&owner);
            }
            GuiCommand::Request { owner, req, reply, sink } => {
                let o = owner.as_str();
                let unit = |r: Result<(), String>| r.map(|_| json!({}));
                let res = match req {
                    GuiRequest::Create { window_id, spec, show } => {
                        let em = GuiEmitter::new(o, &window_id, sink);
                        backend
                            .create_window(o, &window_id, &spec, em)
                            .and_then(|_| if show { backend.show(o, &window_id) } else { Ok(()) })
                            .map(|_| json!({ "windowId": window_id }))
                    }
                    GuiRequest::Patch { window_id, patches } => unit(backend.apply_patch(o, &window_id, &patches)),
                    GuiRequest::Show { window_id } => unit(backend.show(o, &window_id)),
                    GuiRequest::Hide { window_id } => unit(backend.hide(o, &window_id)),
                    GuiRequest::Focus { window_id, control_id } => {
                        unit(backend.focus(o, &window_id, control_id.as_deref()))
                    }
                    GuiRequest::SetTitle { window_id, title } => unit(backend.set_title(o, &window_id, &title)),
                    GuiRequest::Destroy { window_id } => unit(backend.destroy(o, &window_id)),
                    GuiRequest::Tooltip(t) => unit(backend.tooltip(o, &t)),
                    GuiRequest::Dialog(d) => {
                        // the backend answers (possibly later)
                        backend.dialog(o, &d, Box::new(move |r| reply(r.map(|x| x.to_json()))));
                        return;
                    }
                };
                reply(res);
            }
        }
    }
}

/// The platform backend for the main thread. **E2 (macOS) and E3 (Windows)
/// replace the cfg branches here.** Called once, on the main thread.
pub fn platform_backend() -> Box<dyn UiBackend> {
    #[cfg(target_os = "macos")]
    {
        match macos::AppKitBackend::new() {
            Ok(b) => Box::new(b),
            Err(e) => {
                log::warn!("AppKit GUI backend unavailable: {e}");
                Box::new(StubBackend::default())
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::Win32Backend::new())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Box::new(StubBackend::default())
    }
}
