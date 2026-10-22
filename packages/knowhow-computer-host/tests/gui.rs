//! GUI protocol end-to-end (in-process): a worker connection over an in-memory
//! duplex stream talks to `ipc::serve_conn`, with the recording backend
//! (or the default stub) behind `Host::gui`.

use knowhow_computer_host::chord::Chord;
use knowhow_computer_host::gui::{Op, RecordingBackend, RecordingHandle};
use knowhow_computer_host::host::Host;
use knowhow_computer_host::ipc;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

struct Conn {
    r: tokio::io::Lines<BufReader<ReadHalf<DuplexStream>>>,
    w: WriteHalf<DuplexStream>,
}

impl Conn {
    async fn send(&mut self, v: Value) {
        self.w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
    }
    async fn next(&mut self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.r.next_line())
            .await
            .expect("timed out waiting for a line")
            .unwrap()
            .expect("connection closed");
        serde_json::from_str(&line).unwrap()
    }
    /// Read lines until the reply with this reqId (events are skipped).
    async fn reply(&mut self, id: u64) -> Value {
        loop {
            let v = self.next().await;
            if v["reqId"] == json!(id) {
                return v;
            }
        }
    }
}

fn host() -> Arc<Host> {
    Host::new(Chord::parse("ctrl+alt+esc").unwrap(), "ctrl+alt+esc".into())
}

async fn worker(host: &Arc<Host>, id: &str) -> Conn {
    host.sup.allow_worker_token_for_tests(id, "test-token");
    let (client, server) = tokio::io::duplex(64 * 1024);
    tokio::spawn(ipc::serve_conn(host.clone(), server));
    let (rd, wr) = tokio::io::split(client);
    let mut c = Conn { r: BufReader::new(rd).lines(), w: wr };
    c.send(json!({"type": "hello", "role": "worker", "workerId": id, "token": "test-token", "reqId": 1})).await;
    let r = c.reply(1).await;
    assert_eq!(r["ok"], true, "{r}");
    c
}

fn spec() -> Value {
    json!({"title": "T", "layout": {"type": "column", "children": [
        {"type": "button", "id": "saveBtn", "text": "Save"},
        {"type": "input", "id": "primaryInput", "label": "P"}]}})
}

fn recording_host() -> (Arc<Host>, RecordingHandle) {
    let h = host();
    let (b, rec) = RecordingBackend::new();
    h.gui.set_inline_backend(Box::new(b));
    (h, rec)
}

async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..100 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn stub_backend_answers_create_with_matching_reqid() {
    let h = host(); // default: stub backend
    let mut c = worker(&h, "w-stub").await;
    c.send(json!({"type": "guiCreate", "windowId": "w1", "spec": spec(), "reqId": 42})).await;
    let r = c.reply(42).await;
    assert_eq!(r["ok"], false, "{r}");
    assert!(r["error"].as_str().unwrap().contains("not supported"), "{r}");
    assert_eq!(h.gui.window_count(), 0);

    c.send(json!({"type": "dialog", "kind": "alert", "message": "hi", "reqId": 43})).await;
    let r = c.reply(43).await;
    assert_eq!(r["ok"], false);
    c.send(json!({"type": "tooltip", "text": "x", "ms": 100, "x": null, "y": null, "reqId": 44})).await;
    assert_eq!(c.reply(44).await["ok"], false);
}

#[tokio::test]
async fn bad_gui_messages_fail_with_their_reqid() {
    let h = host();
    let mut c = worker(&h, "w-bad").await;
    // unknown control type: parse error still carries the reqId
    c.send(json!({"type": "guiCreate", "windowId": "w", "reqId": 7,
                  "spec": {"title": "x", "layout": {"type": "nope"}}}))
        .await;
    let r = c.reply(7).await;
    assert_eq!(r["ok"], false);
    c.send(json!({"type": "dialog", "kind": "bogus", "reqId": 8})).await;
    assert_eq!(c.reply(8).await["ok"], false);
    c.send(json!({"type": "guiShow", "windowId": "never", "reqId": 9})).await;
    assert!(c.reply(9).await["error"].as_str().unwrap().contains("unknown window"));
}

#[tokio::test]
async fn create_patch_events_dialog_roundtrip() {
    let (h, rec) = recording_host();
    let mut c = worker(&h, "w-rec").await;
    c.send(json!({"type": "guiCreate", "windowId": "w1", "spec": spec(), "show": true, "reqId": 2})).await;
    let r = c.reply(2).await;
    assert_eq!(r, json!({"reqId": 2, "ok": true, "result": {"windowId": "w1"}}));
    // fire-and-forget (no reqId): no reply, but applied in order
    c.send(json!({"type": "guiPatch", "windowId": "w1",
                  "patches": [{"id": "saveBtn", "props": {"text": "Stop"}}]}))
        .await;
    c.send(json!({"type": "guiSetTitle", "windowId": "w1", "title": "New"})).await;
    c.send(json!({"type": "guiFocus", "windowId": "w1", "controlId": "primaryInput"})).await;
    c.send(json!({"type": "dialog", "kind": "prompt", "title": "t", "message": "m", "default": "dflt", "reqId": 3}))
        .await;
    let r = c.reply(3).await;
    assert_eq!(r["result"], json!({"button": "ok", "value": "dflt"}));
    let ops = rec.ops();
    assert!(matches!(ops[0], Op::Create { .. }));
    assert!(matches!(ops[1], Op::Show { .. }));
    assert!(matches!(&ops[2], Op::Patch { patches, .. } if patches[0].props.text.as_deref() == Some("Stop")));
    assert!(matches!(&ops[3], Op::SetTitle { title, .. } if title == "New"));
    assert!(matches!(&ops[4], Op::Focus { control: Some(c), .. } if c == "primaryInput"));

    // backend events are routed to this worker's connection as guiEvent
    let em = rec.emitter("w-rec", "w1").expect("emitter");
    em.click("saveBtn");
    em.change_text("primaryInput", "abc");
    em.close();
    assert_eq!(
        c.next().await,
        json!({"type": "guiEvent", "windowId": "w1", "controlId": "saveBtn", "event": "click"})
    );
    assert_eq!(
        c.next().await,
        json!({"type": "guiEvent", "windowId": "w1", "controlId": "primaryInput", "event": "change", "value": "abc"})
    );
    assert_eq!(
        c.next().await,
        json!({"type": "guiEvent", "windowId": "w1", "controlId": null, "event": "close"})
    );
}

#[tokio::test]
async fn disconnect_destroys_that_workers_windows_only() {
    let (h, rec) = recording_host();
    let mut a = worker(&h, "wa").await;
    let mut b = worker(&h, "wb").await;
    for (c, n) in [(&mut a, 10u64), (&mut b, 11u64)] {
        c.send(json!({"type": "guiCreate", "windowId": "w1", "spec": spec(), "reqId": n})).await;
        assert_eq!(c.reply(n).await["ok"], true);
    }
    a.send(json!({"type": "tooltip", "text": "tip", "ms": 0, "reqId": 12})).await;
    assert_eq!(a.reply(12).await["ok"], true);
    assert_eq!(h.gui.window_count(), 2);

    drop(a); // worker "wa" disconnects
    wait_for("cleanup of wa", || h.gui.windows_of("wa").is_empty()).await;
    wait_for("destroy op", || {
        rec.ops().iter().any(|o| matches!(o, Op::Destroy { owner, window_id } if owner == "wa" && window_id == "w1"))
    })
    .await;
    assert!(rec.ops().contains(&Op::ClearTooltip { owner: "wa".into() }));
    assert_eq!(h.gui.windows_of("wb"), vec!["w1".to_string()]);
    assert!(!rec.ops().iter().any(|o| matches!(o, Op::Destroy { owner, .. } if owner == "wb")));

    // the kill switch / shutdown path tears everything down (destroy_all)
    h.gui.destroy_all();
    assert_eq!(h.gui.window_count(), 0);
    wait_for("destroy of wb", || {
        rec.ops().iter().any(|o| matches!(o, Op::Destroy { owner, .. } if owner == "wb"))
    })
    .await;
    drop(b);
}
