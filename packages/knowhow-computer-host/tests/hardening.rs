//! Kill-switch latch + approval flow at the library level (mock dialog).
#![cfg(unix)]

use knowhow_computer_host::approval::{Decision, Kind, Prompter};
use knowhow_computer_host::chord::Chord;
use knowhow_computer_host::host::{Host, Runner};
use knowhow_computer_host::supervisor::SingleInstance;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

struct Mock {
    answer: AtomicBool,
    calls: AtomicUsize,
}
impl Prompter for Mock {
    fn confirm(&self, _t: &str, _m: &str) -> bool {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.answer.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn kill_switch_blocks_starts_until_explicitly_rearmed() {
    let home = std::path::PathBuf::from(format!("/tmp/khhard-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home); // logs dir etc. (this file has a single test)

    let script = home.join("a.ts");
    std::fs::write(&script, "sdk.keepAlive();").unwrap();
    std::fs::write(home.join("runner.sh"), "exec sleep 30\n").unwrap();

    let host = Host::new(Chord::parse("ctrl+alt+esc").unwrap(), "ctrl+alt+esc".into());
    host.set_runner(Runner { node: "/bin/sh".into(), script: home.join("runner.sh") });
    host.set_approvals_path(home.join("approvals.json"));
    let mock = Arc::new(Mock { answer: AtomicBool::new(true), calls: AtomicUsize::new(0) });
    host.set_prompter(mock.clone());
    let p = script.to_str().unwrap();

    // first start prompts (mock approves) and runs
    let (w, started) = host.launch(p, None, None, None, SingleInstance::Replace).await.unwrap();
    assert!(started);
    assert_eq!(w.name, "a");
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
    // unchanged: no second prompt
    host.launch(p, None, None, None, SingleInstance::Replace).await.unwrap();
    assert_eq!(mock.calls.load(Ordering::SeqCst), 1);

    // kill switch: stops everything and LATCHES
    host.kill_switch_action().await;
    assert!(host.status().halted);
    assert!(host.sup.select(None, None, true).is_empty(), "workers stopped");

    // the old behaviour auto-cleared after 1.5 s; it must not any more
    tokio::time::sleep(Duration::from_millis(2000)).await;
    assert!(host.status().halted, "latch must persist");
    let e = host.launch(p, None, None, None, SingleInstance::Replace).await.unwrap_err();
    assert!(e.contains("kill switch tripped"), "{e}");
    assert!(host.restart(Some("a"), None).await.is_err());

    // re-arm needs a human: declined => still blocked
    mock.answer.store(false, Ordering::SeqCst);
    assert_eq!(host.rearm().await.unwrap(), false);
    assert!(host.status().halted);
    assert!(host.launch(p, None, None, None, SingleInstance::Replace).await.is_err());

    // confirmed => starts work again
    mock.answer.store(true, Ordering::SeqCst);
    assert_eq!(host.rearm().await.unwrap(), true);
    assert!(!host.status().halted);
    let (_, started) = host.launch(p, None, None, None, SingleInstance::Replace).await.unwrap();
    assert!(started);

    // approval is path-based: edited content runs without a new prompt
    std::fs::write(&script, "sdk.keepAlive(); // changed").unwrap();
    mock.answer.store(false, Ordering::SeqCst);
    let before = mock.calls.load(Ordering::SeqCst);
    let (_, started) = host.launch(p, None, None, None, SingleInstance::Replace).await.unwrap();
    assert!(started);
    assert_eq!(mock.calls.load(Ordering::SeqCst), before);

    // revoked => prompts again; declined => refused
    let removed = host.revoke(Some(p)).await.unwrap();
    assert_eq!(removed.len(), 1);
    let e = host.launch(p, None, None, None, SingleInstance::Replace).await.unwrap_err();
    assert!(e.contains("not approved"), "{e}");
    assert_eq!(mock.calls.load(Ordering::SeqCst), before + 1);

    // audit trail recorded halt / rearm / approve / start / revoke / deny / exit
    let events: Vec<String> = host.audit_tail(1000).into_iter().map(|e| e.event).collect();
    for want in ["approve", "start", "halt", "rearm", "revoke", "deny", "exit"] {
        assert!(events.iter().any(|e| e == want), "missing {want} in {events:?}");
    }

    host.sup.stop_all().await;
    let _ = std::fs::remove_dir_all(&home);
}

/// Prompter that blocks inside the dialog until released.
struct Blocking {
    entered: std::sync::Mutex<std::sync::mpsc::Sender<()>>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}
impl Prompter for Blocking {
    fn confirm(&self, _t: &str, _m: &str) -> bool {
        false
    }
    fn decide(&self, _t: &str, _m: &str) -> Decision {
        let _ = self.entered.lock().unwrap().send(());
        let _ = self.release.lock().unwrap().recv();
        Decision::Always
    }
}

/// A revoke that lands while another path's dialog is open must not be
/// undone when that dialog commits (the old code wrote back a stale copy of
/// the whole approvals map).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoke_during_a_dialog_is_not_undone_by_a_stale_approve() {
    let dir = std::path::PathBuf::from(format!("/tmp/khstale-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let (a, b) = (dir.join("a.ts"), dir.join("b.ts"));
    std::fs::write(&a, "x").unwrap();
    std::fs::write(&b, "x").unwrap();
    let host = Host::new(Chord::parse("ctrl+alt+esc").unwrap(), "ctrl+alt+esc".into());
    host.set_approvals_path(dir.join("approvals.json"));

    // A is approved (plain yes => "always")
    host.set_prompter(Arc::new(Mock { answer: AtomicBool::new(true), calls: AtomicUsize::new(0) }));
    host.approve_path(a.to_str().unwrap(), true).await.unwrap();
    assert_eq!(host.approvals().await.len(), 1);

    // B's dialog opens and blocks
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    host.set_prompter(Arc::new(Blocking {
        entered: std::sync::Mutex::new(entered_tx),
        release: std::sync::Mutex::new(release_rx),
    }));
    let h = host.clone();
    let bp = b.to_str().unwrap().to_string();
    let task = tokio::spawn(async move { h.approve_path(&bp, true).await });
    tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(5)).unwrap())
        .await
        .unwrap();

    // revoke A while the dialog is open: must not wait for the dialog
    let removed = tokio::time::timeout(Duration::from_secs(2), host.revoke(Some(a.to_str().unwrap())))
        .await
        .expect("revoke must not be blocked by an open dialog")
        .unwrap();
    assert_eq!(removed.len(), 1);

    // user clicks "Always allow" for B
    release_tx.send(()).unwrap();
    let ok = task.await.unwrap().unwrap();
    assert_eq!(ok.kind, Kind::Always);

    // A stays revoked; only B was written
    let all = host.approvals().await;
    assert_eq!(all.len(), 1, "{all:?}");
    assert!(all[0].0.ends_with("b.ts"), "{all:?}");
    let _ = std::fs::remove_dir_all(&dir);
}
