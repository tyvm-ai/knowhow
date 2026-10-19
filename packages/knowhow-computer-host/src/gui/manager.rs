//! Thread-safe front door for GUI requests: per-worker window tracking +
//! dispatch to the thread that owns the [`UiBackend`].

use super::*;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, RwLock};

/// Sends a command to the backend's thread (tao `UserEvent::Gui` in the tray
/// loop) or runs it inline ([`inline_dispatch`]).
pub type Dispatch = Arc<dyn Fn(GuiCommand) + Send + Sync>;

/// Run commands immediately on the calling thread against `backend`
/// (stub backend on Linux, [`RecordingBackend`] in tests).
pub fn inline_dispatch(backend: Box<dyn UiBackend + Send>) -> Dispatch {
    let b = Arc::new(Mutex::new(backend));
    Arc::new(move |cmd: GuiCommand| {
        let mut g = b.lock().unwrap();
        cmd.execute(&mut **g);
    })
}

#[derive(Default)]
struct State {
    /// owner (worker id) -> window ids
    windows: HashMap<String, HashSet<String>>,
    /// owners that may have a tooltip showing
    tooltips: HashSet<String>,
}

pub struct GuiManager {
    state: Arc<Mutex<State>>,
    dispatch: RwLock<Dispatch>,
    sink: RwLock<EventSink>,
}

impl GuiManager {
    /// Starts with an inline [`StubBackend`] and a no-op event sink.
    pub fn new() -> Arc<GuiManager> {
        Arc::new(GuiManager {
            state: Arc::new(Mutex::new(State::default())),
            dispatch: RwLock::new(inline_dispatch(Box::new(StubBackend))),
            sink: RwLock::new(Arc::new(|_| {})),
        })
    }

    /// Where backend commands run (the tao loop installs its proxy here).
    pub fn set_dispatcher(&self, d: Dispatch) {
        *self.dispatch.write().unwrap() = d;
    }

    /// Run commands inline against `backend` (tests, non-GUI platforms).
    pub fn set_inline_backend(&self, backend: Box<dyn UiBackend + Send>) {
        self.set_dispatcher(inline_dispatch(backend));
    }

    /// Where [`GuiEvent`]s go (the host routes them to the worker connection).
    pub fn set_event_sink(&self, s: EventSink) {
        *self.sink.write().unwrap() = s;
    }

    pub fn windows_of(&self, owner: &str) -> Vec<String> {
        let st = self.state.lock().unwrap();
        let mut v: Vec<String> = st.windows.get(owner).map(|s| s.iter().cloned().collect()).unwrap_or_default();
        v.sort();
        v
    }

    pub fn window_count(&self) -> usize {
        self.state.lock().unwrap().windows.values().map(|s| s.len()).sum()
    }

    /// Validate/track `req` for worker `owner`, then run it on the backend
    /// thread. `reply` is always called exactly once (possibly on another
    /// thread, possibly later for dialogs).
    pub fn handle(&self, owner: &str, req: GuiRequest, reply: Reply) {
        let mut reply = reply;
        {
            let mut st = self.state.lock().unwrap();
            match &req {
                GuiRequest::Create { window_id, spec, .. } => {
                    if window_id.is_empty() {
                        return reply(Err("windowId required".into()));
                    }
                    if let Err(e) = spec::validate(spec) {
                        return reply(Err(e));
                    }
                    if !st.windows.entry(owner.to_string()).or_default().insert(window_id.clone()) {
                        return reply(Err(format!("window '{window_id}' already exists")));
                    }
                    // roll the bookkeeping back if the backend refuses
                    let state = self.state.clone();
                    let (o, w) = (owner.to_string(), window_id.clone());
                    let inner = reply;
                    reply = Box::new(move |r| {
                        if r.is_err() {
                            if let Some(s) = state.lock().unwrap().windows.get_mut(&o) {
                                s.remove(&w);
                            }
                        }
                        inner(r)
                    });
                }
                GuiRequest::Patch { window_id, .. }
                | GuiRequest::Show { window_id }
                | GuiRequest::Hide { window_id }
                | GuiRequest::Focus { window_id, .. }
                | GuiRequest::SetTitle { window_id, .. } => {
                    if !st.windows.get(owner).map_or(false, |s| s.contains(window_id)) {
                        return reply(Err(format!("unknown window '{window_id}'")));
                    }
                }
                GuiRequest::Destroy { window_id } => {
                    let known = st.windows.get_mut(owner).map_or(false, |s| s.remove(window_id));
                    if !known {
                        return reply(Err(format!("unknown window '{window_id}'")));
                    }
                }
                GuiRequest::Tooltip(t) => {
                    if t.text.is_empty() {
                        st.tooltips.remove(owner);
                    } else {
                        st.tooltips.insert(owner.to_string());
                    }
                }
                GuiRequest::Dialog(_) => {}
            }
        }
        let cmd = GuiCommand::Request {
            owner: owner.to_string(),
            req,
            reply,
            sink: self.sink.read().unwrap().clone(),
        };
        let d = self.dispatch.read().unwrap().clone();
        d(cmd);
    }

    /// Destroy every window + the tooltip of `owner`. Call on worker
    /// disconnect, stop, restart and kill switch. Cheap when there is nothing.
    pub fn destroy_all_for(&self, owner: &str) {
        let (windows, tip) = {
            let mut st = self.state.lock().unwrap();
            let w: Vec<String> = st.windows.remove(owner).map(|s| s.into_iter().collect()).unwrap_or_default();
            (w, st.tooltips.remove(owner))
        };
        if windows.is_empty() && !tip {
            return;
        }
        let d = self.dispatch.read().unwrap().clone();
        d(GuiCommand::Cleanup { owner: owner.to_string(), windows });
    }

    /// Destroy everything for every worker (host shutdown).
    pub fn destroy_all(&self) {
        let owners: Vec<String> = {
            let st = self.state.lock().unwrap();
            st.windows.keys().chain(st.tooltips.iter()).cloned().collect()
        };
        for o in owners {
            self.destroy_all_for(&o);
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::gui::backends::{Op, RecordingHandle};
    use serde_json::json;

    fn spec(v: Value) -> Box<WindowSpec> {
        Box::new(serde_json::from_value(v).unwrap())
    }

    fn simple() -> Box<WindowSpec> {
        spec(json!({"title": "T", "layout": {"type": "column", "children": [
            {"type": "button", "id": "b", "text": "go"}]}}))
    }

    fn setup() -> (Arc<GuiManager>, RecordingHandle, Arc<Mutex<Vec<GuiEvent>>>) {
        let m = GuiManager::new();
        let (b, h) = RecordingBackend::new();
        m.set_inline_backend(Box::new(b));
        let events = Arc::new(Mutex::new(Vec::new()));
        let e2 = events.clone();
        m.set_event_sink(Arc::new(move |e| e2.lock().unwrap().push(e)));
        (m, h, events)
    }

    fn call(m: &GuiManager, owner: &str, req: GuiRequest) -> Result<Value, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        m.handle(owner, req, Box::new(move |r| tx.send(r).unwrap()));
        rx.recv_timeout(std::time::Duration::from_secs(2)).expect("reply")
    }

    fn create(id: &str, show: bool) -> GuiRequest {
        GuiRequest::Create { window_id: id.into(), spec: simple(), show }
    }

    #[test]
    fn create_show_patch_destroy_roundtrip() {
        let (m, h, _) = setup();
        assert_eq!(call(&m, "wk", create("w1", true)).unwrap(), json!({"windowId": "w1"}));
        assert_eq!(m.windows_of("wk"), vec!["w1".to_string()]);
        let patches = vec![Patch {
            id: "b".into(),
            props: spec::PropsPatch { text: Some("stop".into()), ..Default::default() },
        }];
        call(&m, "wk", GuiRequest::Patch { window_id: "w1".into(), patches }).unwrap();
        call(&m, "wk", GuiRequest::Focus { window_id: "w1".into(), control_id: Some("b".into()) }).unwrap();
        call(&m, "wk", GuiRequest::Destroy { window_id: "w1".into() }).unwrap();
        assert!(m.windows_of("wk").is_empty());
        let ops = h.ops();
        assert!(matches!(ops[0], Op::Create { .. }));
        assert!(matches!(ops[1], Op::Show { .. }));
        assert!(matches!(ops[2], Op::Patch { .. }));
        assert!(matches!(&ops[3], Op::Focus { control: Some(c), .. } if c == "b"));
        assert!(matches!(ops[4], Op::Destroy { .. }));
    }

    #[test]
    fn duplicate_and_unknown_windows_error_without_touching_backend() {
        let (m, h, _) = setup();
        call(&m, "wk", create("w1", false)).unwrap();
        assert!(call(&m, "wk", create("w1", false)).unwrap_err().contains("already exists"));
        // same id for another worker is fine (namespaced by owner)
        call(&m, "other", create("w1", false)).unwrap();
        assert!(call(&m, "wk", GuiRequest::Show { window_id: "nope".into() }).unwrap_err().contains("unknown window"));
        assert!(call(&m, "wk", GuiRequest::Destroy { window_id: "nope".into() }).is_err());
        assert_eq!(h.ops().len(), 2);
    }

    #[test]
    fn failed_create_is_rolled_back() {
        let m = GuiManager::new();
        let (mut b, _h) = RecordingBackend::new();
        b.fail_create = Some("boom".into());
        m.set_inline_backend(Box::new(b));
        assert_eq!(call(&m, "wk", create("w1", false)).unwrap_err(), "boom");
        assert!(m.windows_of("wk").is_empty());
    }

    #[test]
    fn invalid_spec_is_rejected() {
        let (m, h, _) = setup();
        let bad = spec(json!({"title": "x", "layout": {"type": "row", "children": [
            {"type": "label", "id": "a", "text": ""}, {"type": "label", "id": "a", "text": ""}]}}));
        let r = call(&m, "wk", GuiRequest::Create { window_id: "w".into(), spec: bad, show: false });
        assert!(r.unwrap_err().contains("duplicate"));
        assert!(h.ops().is_empty());
    }

    #[test]
    fn destroy_all_for_cleans_only_that_worker() {
        let (m, h, _) = setup();
        call(&m, "a", create("w1", false)).unwrap();
        call(&m, "a", create("w2", false)).unwrap();
        call(&m, "b", create("w1", false)).unwrap();
        call(
            &m,
            "a",
            GuiRequest::Tooltip(TooltipRequest { text: "hi".into(), ms: 0, at: None }),
        )
        .unwrap();
        h.clear();
        m.destroy_all_for("a");
        assert!(m.windows_of("a").is_empty());
        assert_eq!(m.windows_of("b"), vec!["w1".to_string()]);
        let ops = h.ops();
        assert_eq!(ops.iter().filter(|o| matches!(o, Op::Destroy { owner, .. } if owner == "a")).count(), 2);
        assert!(ops.contains(&Op::ClearTooltip { owner: "a".into() }));
        // nothing left for "a": no-op, backend not woken
        h.clear();
        m.destroy_all_for("a");
        assert!(h.ops().is_empty());
        m.destroy_all();
        assert_eq!(m.window_count(), 0);
    }

    #[test]
    fn dialogs_reply_through_the_backend() {
        let (m, _, _) = setup();
        let req = |kind, default: &str| {
            GuiRequest::Dialog(DialogRequest {
                kind,
                title: "t".into(),
                message: "m".into(),
                default: default.into(),
            })
        };
        assert_eq!(call(&m, "w", req(DialogKind::Alert, "")).unwrap(), json!({"button": "ok"}));
        assert_eq!(call(&m, "w", req(DialogKind::Confirm, "")).unwrap(), json!({"button": "yes"}));
        assert_eq!(
            call(&m, "w", req(DialogKind::Prompt, "dflt")).unwrap(),
            json!({"button": "ok", "value": "dflt"})
        );
    }

    #[test]
    fn events_flow_through_the_sink_with_owner() {
        let (m, h, events) = setup();
        call(&m, "wk", create("w1", false)).unwrap();
        let em = h.emitter("wk", "w1").unwrap();
        em.click("b");
        em.change_text("i", "abc");
        em.select("d", 2);
        em.change_checked("c", true);
        em.close();
        let ev = events.lock().unwrap().clone();
        assert_eq!(ev.len(), 5);
        assert!(ev.iter().all(|e| e.owner == "wk" && e.window_id == "w1"));
        let w: Value = serde_json::from_str(&ev[1].to_wire()).unwrap();
        assert_eq!(w, json!({"type": "guiEvent", "windowId": "w1", "controlId": "i", "event": "change", "value": "abc"}));
        let w: Value = serde_json::from_str(&ev[2].to_wire()).unwrap();
        assert_eq!(w["selected"], 2);
        let w: Value = serde_json::from_str(&ev[3].to_wire()).unwrap();
        assert_eq!(w["checked"], true);
        let w: Value = serde_json::from_str(&ev[4].to_wire()).unwrap();
        assert_eq!(w["controlId"], Value::Null);
        assert_eq!(w["event"], "close");
    }

    #[test]
    fn default_manager_uses_stub_and_errors() {
        let m = GuiManager::new();
        assert_eq!(call(&m, "wk", create("w1", false)).unwrap_err(), UNSUPPORTED);
        assert!(m.windows_of("wk").is_empty());
        let d = GuiRequest::Dialog(DialogRequest {
            kind: DialogKind::Alert,
            title: "".into(),
            message: "".into(),
            default: "".into(),
        });
        assert_eq!(call(&m, "wk", d).unwrap_err(), UNSUPPORTED);
    }
}
