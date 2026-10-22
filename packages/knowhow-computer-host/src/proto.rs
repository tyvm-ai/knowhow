//! IPC wire messages (newline-delimited JSON). See PROTOCOL.md.

use crate::gui::spec::{Patch, WindowSpec};
use crate::gui::{DialogKind, DialogRequest, GuiRequest, TooltipRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Structured run arguments the host turns into fixed runner flags.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunArgs {
    /// JSON object exposed as `sdk.params`.
    pub params: Option<Value>,
    pub max_duration_ms: Option<u64>,
    pub dry_run: Option<bool>,
}

/// Every message a client (control or worker) can send. `reqId` is not part
/// of the enum; it is read separately from the raw JSON object.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientMsg {
    Hello {
        role: String,
        worker_id: Option<String>,
        name: Option<String>,
        /// control: contents of host.token; worker: env KNOWHOW_CU_WORKER_TOKEN.
        token: Option<String>,
    },

    // ---- control requests ----
    List,
    Status,
    Shutdown,
    /// Start an APPROVED automation. The host builds the argv itself.
    Start {
        automation_path: String,
        name: Option<String>,
        args: Option<RunArgs>,
        cwd: Option<String>,
        single_instance: Option<String>,
    },
    /// Persistently approve (native dialog if the path is new) without starting.
    Approve {
        automation_path: String,
    },
    /// List approved paths (approvedAt, lastRunAt).
    Approvals,
    /// Tail of the append-only audit log.
    Audit {
        limit: Option<usize>,
    },
    Revoke {
        automation_path: Option<String>,
        all: Option<bool>,
    },
    /// Clear the kill-switch latch (native confirmation).
    Rearm,
    Stop {
        name: Option<String>,
        id: Option<String>,
        all: Option<bool>,
    },
    Pause {
        name: Option<String>,
        id: Option<String>,
        all: Option<bool>,
    },
    Resume {
        name: Option<String>,
        id: Option<String>,
        all: Option<bool>,
    },
    SuspendHotkeys {
        name: Option<String>,
        id: Option<String>,
        all: Option<bool>,
        /// default: toggle
        suspended: Option<bool>,
    },
    Restart {
        name: Option<String>,
        id: Option<String>,
    },
    Logs {
        name: Option<String>,
        id: Option<String>,
        tail: Option<usize>,
    },

    // ---- worker messages ----
    RegisterHotkey {
        id: String,
        chord: String,
        any_modifiers: Option<bool>,
        consume: Option<bool>,
        no_repeat: Option<bool>,
        /// "drop" => ignore presses while the previous handler is running.
        concurrency: Option<String>,
    },
    UnregisterHotkey {
        id: String,
    },
    HotkeyDone {
        id: String,
    },
    HeldKeys {
        keys: Vec<String>,
    },
    TrayStatus {
        text: String,
    },
    TrayMenuItem {
        id: String,
        label: String,
    },
    Log {
        level: Option<String>,
        message: Option<String>,
    },

    // ---- native GUI (worker messages, see PROTOCOL.md "GUI") ----
    GuiCreate {
        window_id: String,
        spec: Box<WindowSpec>,
        show: Option<bool>,
    },
    GuiPatch {
        window_id: String,
        patches: Vec<Patch>,
    },
    GuiShow {
        window_id: String,
    },
    GuiHide {
        window_id: String,
    },
    GuiFocus {
        window_id: String,
        control_id: Option<String>,
    },
    GuiSetTitle {
        window_id: String,
        title: String,
    },
    GuiDestroy {
        window_id: String,
    },
    Dialog {
        kind: String,
        title: Option<String>,
        message: Option<String>,
        default: Option<String>,
    },
    Tooltip {
        text: String,
        ms: Option<u64>,
        x: Option<f64>,
        y: Option<f64>,
    },
}

impl ClientMsg {
    pub fn is_gui(&self) -> bool {
        matches!(
            self,
            ClientMsg::GuiCreate { .. }
                | ClientMsg::GuiPatch { .. }
                | ClientMsg::GuiShow { .. }
                | ClientMsg::GuiHide { .. }
                | ClientMsg::GuiFocus { .. }
                | ClientMsg::GuiSetTitle { .. }
                | ClientMsg::GuiDestroy { .. }
                | ClientMsg::Dialog { .. }
                | ClientMsg::Tooltip { .. }
        )
    }

    /// Convert a GUI worker message into a [`GuiRequest`]; `None` if it isn't one.
    pub fn into_gui_request(self) -> Option<Result<GuiRequest, String>> {
        Some(Ok(match self {
            ClientMsg::GuiCreate { window_id, spec, show } => {
                GuiRequest::Create { window_id, spec, show: show.unwrap_or(false) }
            }
            ClientMsg::GuiPatch { window_id, patches } => GuiRequest::Patch { window_id, patches },
            ClientMsg::GuiShow { window_id } => GuiRequest::Show { window_id },
            ClientMsg::GuiHide { window_id } => GuiRequest::Hide { window_id },
            ClientMsg::GuiFocus { window_id, control_id } => GuiRequest::Focus { window_id, control_id },
            ClientMsg::GuiSetTitle { window_id, title } => GuiRequest::SetTitle { window_id, title },
            ClientMsg::GuiDestroy { window_id } => GuiRequest::Destroy { window_id },
            ClientMsg::Dialog { kind, title, message, default } => {
                let Some(k) = DialogKind::parse(&kind) else {
                    return Some(Err(format!("unknown dialog kind '{kind}'")));
                };
                GuiRequest::Dialog(DialogRequest {
                    kind: k,
                    title: title.unwrap_or_default(),
                    message: message.unwrap_or_default(),
                    default: default.unwrap_or_default(),
                })
            }
            ClientMsg::Tooltip { text, ms, x, y } => GuiRequest::Tooltip(TooltipRequest {
                text,
                ms: ms.unwrap_or(0),
                at: match (x, y) {
                    (Some(x), Some(y)) => Some((x, y)),
                    _ => None,
                },
            }),
            _ => return None,
        }))
    }
}

/// Host → worker events.
pub fn ev_hotkey(id: &str) -> String {
    json!({"type": "hotkey", "id": id}).to_string()
}
pub fn ev_simple(kind: &str) -> String {
    json!({ "type": kind }).to_string()
}
pub fn ev_tray_menu(id: &str) -> String {
    json!({"type": "trayMenu", "id": id}).to_string()
}

pub fn response_ok(req_id: &Value, result: Value) -> String {
    json!({"reqId": req_id, "ok": true, "result": result}).to_string()
}
pub fn response_err(req_id: &Value, error: &str) -> String {
    json!({"reqId": req_id, "ok": false, "error": error}).to_string()
}

/// Parse one line into (reqId, message).
pub fn parse_line(line: &str) -> Result<(Value, ClientMsg), String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("invalid json: {e}"))?;
    let req_id = v.get("reqId").cloned().unwrap_or(Value::Null);
    if v.get("type").and_then(Value::as_str) == Some("start") && (v.get("argv").is_some() || v.get("env").is_some()) {
        return Err("start no longer accepts argv/env: use {automationPath, args?}".into());
    }
    let msg: ClientMsg = serde_json::from_value(v).map_err(|e| format!("bad message: {e}"))?;
    Ok((req_id, msg))
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    pub version: String,
    pub pid: u32,
    pub kill_switch: String,
    pub kill_switch_armed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_error: Option<String>,
    pub platform: String,
    /// Kill switch tripped: new starts are blocked until `rearm`.
    pub halted: bool,
    /// True when the host was launched with `--node` and `--runner`.
    pub runner_configured: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_control_requests() {
        let (id, m) = parse_line(r#"{"reqId":7,"type":"list"}"#).unwrap();
        assert_eq!(id, json!(7));
        assert_eq!(m, ClientMsg::List);

        let (_, m) = parse_line(
            r#"{"reqId":"a","type":"start","automationPath":"/a/x.ts","name":"x","args":{"maxDurationMs":5,"dryRun":true},"singleInstance":"replace"}"#,
        )
        .unwrap();
        match m {
            ClientMsg::Start { automation_path, name, args, single_instance, cwd } => {
                assert_eq!(automation_path, "/a/x.ts");
                assert_eq!(name.as_deref(), Some("x"));
                assert_eq!(args.unwrap().max_duration_ms, Some(5));
                assert_eq!(single_instance.as_deref(), Some("replace"));
                assert!(cwd.is_none());
            }
            other => panic!("{other:?}"),
        }
        // the old arbitrary-command start is refused outright
        assert!(parse_line(r#"{"type":"start","name":"x","argv":["sh"],"automationPath":"/x"}"#).is_err());
        assert!(parse_line(r#"{"type":"start","automationPath":"/x","env":{"A":"b"}}"#).is_err());

        let (_, m) = parse_line(r#"{"reqId":1,"type":"stop","all":true}"#).unwrap();
        assert_eq!(m, ClientMsg::Stop { name: None, id: None, all: Some(true) });
        let (_, m) = parse_line(r#"{"reqId":1,"type":"suspendHotkeys","name":"p"}"#).unwrap();
        assert!(matches!(m, ClientMsg::SuspendHotkeys { .. }));
    }

    #[test]
    fn parses_hello_and_worker_messages() {
        let (_, m) = parse_line(r#"{"type":"hello","role":"worker","workerId":"w1","name":"a"}"#).unwrap();
        assert_eq!(
            m,
            ClientMsg::Hello {
                role: "worker".into(),
                worker_id: Some("w1".into()),
                name: Some("a".into()),
                token: None
            }
        );
        let (_, m) = parse_line(
            r#"{"type":"registerHotkey","id":"h","chord":"f6","anyModifiers":true,"consume":true,"noRepeat":true,"concurrency":"drop"}"#,
        )
        .unwrap();
        assert!(matches!(m, ClientMsg::RegisterHotkey { any_modifiers: Some(true), .. }));
        let (_, m) = parse_line(r#"{"type":"heldKeys","keys":["a","ctrl"]}"#).unwrap();
        assert_eq!(m, ClientMsg::HeldKeys { keys: vec!["a".into(), "ctrl".into()] });
        let (_, m) = parse_line(r#"{"type":"hotkeyDone","id":"h"}"#).unwrap();
        assert_eq!(m, ClientMsg::HotkeyDone { id: "h".into() });
    }

    #[test]
    fn parses_gui_messages() {
        let (id, m) = parse_line(
            r#"{"type":"guiCreate","windowId":"w1","show":true,"reqId":5,"spec":{"title":"T","layout":{"type":"spacer"}}}"#,
        )
        .unwrap();
        assert_eq!(id, json!(5));
        match m.into_gui_request().unwrap().unwrap() {
            GuiRequest::Create { window_id, show, spec } => {
                assert_eq!(window_id, "w1");
                assert!(show);
                assert_eq!(spec.title, "T");
            }
            o => panic!("{o:?}"),
        }
        let (_, m) = parse_line(
            r#"{"type":"guiPatch","windowId":"w1","patches":[{"id":"s","props":{"text":"x"}}]}"#,
        )
        .unwrap();
        assert!(matches!(m.into_gui_request(), Some(Ok(GuiRequest::Patch { .. }))));
        let (_, m) = parse_line(r#"{"type":"guiFocus","windowId":"w1"}"#).unwrap();
        assert!(matches!(
            m.into_gui_request(),
            Some(Ok(GuiRequest::Focus { control_id: None, .. }))
        ));
        let (_, m) = parse_line(r#"{"type":"dialog","kind":"prompt","title":"t","message":"m","default":"d","reqId":9}"#)
            .unwrap();
        assert!(matches!(m.into_gui_request(), Some(Ok(GuiRequest::Dialog(_)))));
        let (_, m) = parse_line(r#"{"type":"dialog","kind":"weird"}"#).unwrap();
        assert!(m.into_gui_request().unwrap().is_err());
        let (_, m) = parse_line(r#"{"type":"tooltip","text":"hi","ms":1300,"x":null,"y":null}"#).unwrap();
        match m.into_gui_request().unwrap().unwrap() {
            GuiRequest::Tooltip(t) => assert_eq!((t.ms, t.at), (1300, None)),
            o => panic!("{o:?}"),
        }
        let (_, m) = parse_line(r#"{"type":"tooltip","text":"hi","x":10,"y":20}"#).unwrap();
        assert!(matches!(m.into_gui_request(), Some(Ok(GuiRequest::Tooltip(TooltipRequest { at: Some((x, _)), .. }))) if x == 10.0));
        assert!(ClientMsg::List.into_gui_request().is_none());
        assert!(parse_line(r#"{"type":"guiCreate","windowId":"w","spec":{"layout":{"type":"nope"}}}"#).is_err());
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_line("nope").is_err());
        assert!(parse_line(r#"{"type":"bogus"}"#).is_err());
        assert!(parse_line(r#"{"type":"start"}"#).is_err());
        assert!(parse_line(r#"{"type":"rearm"}"#).is_ok());
        assert!(parse_line(r#"{"type":"audit"}"#).is_ok());
        assert!(parse_line(r#"{"type":"audit","limit":5}"#).is_ok());
    }

    #[test]
    fn response_shapes() {
        let ok: Value = serde_json::from_str(&response_ok(&json!(3), json!({"a": 1}))).unwrap();
        assert_eq!(ok["reqId"], 3);
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["result"]["a"], 1);
        let e: Value = serde_json::from_str(&response_err(&json!("x"), "boom")).unwrap();
        assert_eq!(e["ok"], false);
        assert_eq!(e["error"], "boom");
        assert_eq!(serde_json::from_str::<Value>(&ev_hotkey("h")).unwrap()["type"], "hotkey");
    }

    #[test]
    fn status_serializes_camel_case() {
        let s = StatusInfo {
            version: "0.0.1".into(),
            pid: 1,
            kill_switch: "ctrl+alt+esc".into(),
            kill_switch_armed: true,
            hook_error: None,
            platform: "macos".into(),
            halted: false,
            runner_configured: true,
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["killSwitchArmed"], true);
        assert!(v.get("hookError").is_none());
    }
}
