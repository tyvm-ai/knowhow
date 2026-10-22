//! End-to-end: spawn the host binary with a temp HOME, talk to it over the
//! unix socket (control + worker roles), supervise a `sleep` worker.

#![cfg(unix)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct TestHost {
    home: PathBuf,
    child: Child,
}

const RUNNER: &str = "echo \"$KNOWHOW_CU_WORKER_TOKEN\" > \"$HOME/worker.token\"\necho hello-from-worker\nexec sleep 30\n";

impl TestHost {
    fn start() -> TestHost {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let home = PathBuf::from(format!("/tmp/khh-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("auto")).unwrap();
        std::fs::write(home.join("runner.sh"), RUNNER).unwrap();
        TestHost::spawn(home)
    }

    fn spawn(home: PathBuf) -> TestHost {
        let child = Command::new(env!("CARGO_BIN_EXE_knowhow-computer-host"))
            .args(["--no-tray", "--foreground", "--node", "/bin/sh", "--runner"])
            .arg(home.join("runner.sh"))
            .env("HOME", &home)
            .env("KNOWHOW_CU_NO_UI", "1") // never pop a native dialog in tests (denies)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn host");
        let host = TestHost { home, child };
        let sock = host.sock();
        let t0 = Instant::now();
        while !sock.exists() {
            assert!(t0.elapsed() < Duration::from_secs(10), "host socket never appeared");
            std::thread::sleep(Duration::from_millis(50));
        }
        host
    }

    fn sock(&self) -> PathBuf {
        self.home.join(".knowhow/run/host.sock")
    }

    fn token_path(&self) -> PathBuf {
        self.home.join(".knowhow/computer-use/host.token")
    }

    fn token(&self) -> String {
        std::fs::read_to_string(self.token_path()).unwrap().trim().to_string()
    }

    /// Write an automation and record it in the approval store, exactly as the
    /// host would after the user clicked "Approve" (the store is host-owned;
    /// tests stand in for the host's dialog).
    fn approved(&self, name: &str, body: &str) -> String {
        let f = self.home.join("auto").join(format!("{name}.ts"));
        std::fs::write(&f, body).unwrap();
        self.approve_existing(&f)
    }

    fn approve_existing(&self, f: &std::path::Path) -> String {
        use knowhow_computer_host::approval::canonical;
        use std::os::unix::fs::PermissionsExt;
        let real = canonical(f.to_str().unwrap()).unwrap();
        let store = self.home.join(".knowhow/computer-use/approvals.json");
        let mut all: Value = std::fs::read_to_string(&store)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(json!({"approvals": {}}));
        all["approvals"][real.to_str().unwrap()] = json!({"approvedAt": 1});
        std::fs::create_dir_all(store.parent().unwrap()).unwrap();
        std::fs::write(&store, all.to_string()).unwrap();
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o600)).unwrap();
        f.to_str().unwrap().to_string()
    }

    fn control_hello(&self) -> Value {
        json!({"type": "hello", "role": "control", "token": self.token()})
    }

    fn connect(&self, hello: Value) -> Client {
        let s = UnixStream::connect(self.sock()).expect("connect");
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut c = Client { r: BufReader::new(s.try_clone().unwrap()), w: s, next: 1 };
        let resp = c.req(hello);
        assert_eq!(resp["ok"], true, "hello failed: {resp}");
        c
    }

    /// Hello that is expected to be refused; returns the response.
    fn connect_refused(&self, hello: Value) -> Value {
        let s = UnixStream::connect(self.sock()).expect("connect");
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut c = Client { r: BufReader::new(s.try_clone().unwrap()), w: s, next: 1 };
        let resp = c.req(hello);
        assert_eq!(resp["ok"], false, "hello unexpectedly accepted: {resp}");
        // and the host hangs up on a failed hello
        let mut line = String::new();
        assert_eq!(c.r.read_line(&mut line).unwrap_or(0), 0, "connection should be closed");
        resp
    }
}

impl Drop for TestHost {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

struct Client {
    r: BufReader<UnixStream>,
    w: UnixStream,
    next: u64,
}

impl Client {
    /// Send a request (adds reqId) and wait for the response with that id.
    fn req(&mut self, mut msg: Value) -> Value {
        let id = self.next;
        self.next += 1;
        msg["reqId"] = json!(id);
        writeln!(self.w, "{msg}").unwrap();
        loop {
            let mut line = String::new();
            let n = self.r.read_line(&mut line).expect("read");
            assert!(n > 0, "connection closed");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["reqId"] == json!(id) {
                return v;
            }
        }
    }
}

fn workers(c: &mut Client) -> Vec<Value> {
    let r = c.req(json!({"type": "list"}));
    assert_eq!(r["ok"], true);
    r["result"]["workers"].as_array().unwrap().clone()
}

fn alive(w: &Value) -> bool {
    w["status"] != "exited"
}

#[test]
fn start_list_stop_all_within_one_second() {
    let host = TestHost::start();
    let auto = host.approved("sleeper", "sdk.keepAlive();");
    let mut c = host.connect(host.control_hello());

    let st = c.req(json!({"type": "status"}));
    assert_eq!(st["result"]["killSwitch"], "ctrl+alt+esc");
    assert_eq!(st["result"]["pid"], host.child.id());
    assert_eq!(st["result"]["halted"], false);
    assert_eq!(st["result"]["runnerConfigured"], true);

    let r = c.req(json!({"type": "start", "automationPath": auto}));
    assert_eq!(r["ok"], true, "{r}");
    let pid = r["result"]["worker"]["pid"].as_u64().unwrap() as i32;
    assert_eq!(r["result"]["started"], true);
    assert_eq!(r["result"]["worker"]["name"], "sleeper");

    let l = workers(&mut c);
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["status"], "running");

    // singleInstance: ignore refuses a second one
    let r = c.req(json!({"type": "start", "automationPath": auto, "singleInstance": "ignore"}));
    assert_eq!(r["result"]["started"], false);

    let t0 = Instant::now();
    let r = c.req(json!({"type": "stop", "all": true}));
    assert_eq!(r["ok"], true, "{r}");
    assert!(t0.elapsed() < Duration::from_secs(1), "stop took {:?}", t0.elapsed());
    assert!(workers(&mut c).iter().all(|w| !alive(w)), "worker still listed alive");
    let gone = unsafe { libc::kill(pid, 0) } != 0;
    assert!(gone, "process {pid} still exists");

    let logs: Vec<_> = std::fs::read_dir(host.home.join(".knowhow/run/logs")).unwrap().collect();
    assert_eq!(logs.len(), 1);
}

#[test]
fn replace_restart_and_output_capture() {
    let host = TestHost::start();
    let auto = host.approved("echoer", "x");
    let mut c = host.connect(host.control_hello());
    let r = c.req(json!({"type": "start", "automationPath": auto}));
    assert_eq!(r["ok"], true, "{r}");
    let id1 = r["result"]["worker"]["id"].as_str().unwrap().to_string();
    std::thread::sleep(Duration::from_millis(400));
    let logs = c.req(json!({"type": "logs", "id": id1}));
    assert!(logs["result"]["tail"].as_str().unwrap().contains("hello-from-worker"), "{logs}");

    // default singleInstance = replace: old one is stopped
    let r = c.req(json!({"type": "start", "automationPath": auto}));
    assert_eq!(r["result"]["started"], true);
    let live: Vec<_> = workers(&mut c).into_iter().filter(alive).collect();
    assert_eq!(live.len(), 1);
    assert_ne!(live[0]["id"], json!(id1));

    let r = c.req(json!({"type": "restart", "name": "echoer"}));
    assert_eq!(r["ok"], true, "{r}");
    let live: Vec<_> = workers(&mut c).into_iter().filter(alive).collect();
    assert_eq!(live.len(), 1);

    // approval is path-based: an edited script restarts without re-approval
    std::fs::write(&auto, "x // edited").unwrap();
    let r = c.req(json!({"type": "restart", "name": "echoer"}));
    assert_eq!(r["ok"], true, "{r}");

    // ... but a revoked path is NOT restarted (no UI => denied)
    let r = c.req(json!({"type": "revoke", "automationPath": auto}));
    assert_eq!(r["result"]["revoked"].as_array().unwrap().len(), 1, "{r}");
    let r = c.req(json!({"type": "restart", "name": "echoer"}));
    assert_eq!(r["ok"], false, "{r}");
    assert!(r["error"].as_str().unwrap().contains("not approved"), "{r}");

    let r = c.req(json!({"type": "stop", "name": "nope"}));
    assert_eq!(r["ok"], false);
}

#[test]
fn worker_role_needs_its_token_then_hotkeys_and_second_host_exits() {
    let host = TestHost::start();
    let auto = host.approved("w", "x");
    let mut ctl = host.connect(host.control_hello());
    let r = ctl.req(json!({"type": "start", "automationPath": auto}));
    let id = r["result"]["worker"]["id"].as_str().unwrap().to_string();

    // the spawned worker received its secret via env (the test runner script wrote it out)
    let t0 = Instant::now();
    let wtoken = loop {
        if let Ok(t) = std::fs::read_to_string(host.home.join("worker.token")) {
            if !t.trim().is_empty() {
                break t.trim().to_string();
            }
        }
        assert!(t0.elapsed() < Duration::from_secs(5), "worker token never written");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(wtoken.len(), 64);

    // missing / wrong / control-token-as-worker-token are all rejected
    host.connect_refused(json!({"type": "hello", "role": "worker", "workerId": id, "name": "w"}));
    host.connect_refused(json!({"type": "hello", "role": "worker", "workerId": id, "name": "w", "token": "nope"}));
    host.connect_refused(json!({"type": "hello", "role": "worker", "workerId": id, "name": "w", "token": host.token()}));
    host.connect_refused(json!({"type": "hello", "role": "worker", "workerId": "unknown", "name": "w", "token": wtoken}));

    let mut w = host.connect(json!({"type": "hello", "role": "worker", "workerId": id, "name": "w", "token": wtoken}));
    let ok = w.req(json!({"type": "registerHotkey", "id": "h", "chord": "f6", "consume": true}));
    assert_eq!(ok["ok"], true, "{ok}");
    let bad = w.req(json!({"type": "registerHotkey", "id": "k", "chord": "ctrl+alt+esc"}));
    assert_eq!(bad["ok"], false);

    let l = workers(&mut ctl);
    assert_eq!(l[0]["hotkeyCount"], 1);
    assert_eq!(l[0]["connected"], true);

    let r = ctl.req(json!({"type": "pause", "name": "w"}));
    assert_eq!(r["ok"], true, "{r}");
    let mut line = String::new();
    w.r.read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["type"], "pause");

    let r = ctl.req(json!({"type": "stop", "id": id}));
    assert_eq!(r["ok"], true);
    assert!(workers(&mut ctl).iter().all(|w| !alive(w)));
    // a stopped worker's token is dead
    host.connect_refused(json!({"type": "hello", "role": "worker", "workerId": id, "name": "w", "token": wtoken}));

    // a second host sees the first and exits 0 immediately
    let out = Command::new(env!("CARGO_BIN_EXE_knowhow-computer-host"))
        .args(["--no-tray", "--foreground"])
        .env("HOME", &host.home)
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("already running"));
}

#[test]
fn control_clients_need_the_host_token() {
    let host = TestHost::start();
    host.connect_refused(json!({"type": "hello", "role": "control"}));
    host.connect_refused(json!({"type": "hello", "role": "control", "token": ""}));
    host.connect_refused(json!({"type": "hello", "role": "control", "token": "0".repeat(64)}));
    host.connect_refused(json!({"type": "hello", "role": "control", "token": &host.token()[..63]}));
    host.connect(host.control_hello());
}

#[test]
fn control_token_rotates_on_each_host_start() {
    let home = {
        let h = TestHost::start();
        let t1 = h.token();
        let home = h.home.clone();
        // keep the dir: stop the host without removing HOME
        let mut h = h;
        let _ = h.child.kill();
        let _ = h.child.wait();
        let _ = std::fs::remove_file(h.sock()); // killed host leaves a stale socket
        std::mem::forget(h);
        (home, t1)
    };
    let h2 = TestHost::spawn(home.0.clone());
    assert_ne!(h2.token(), home.1, "token must be rotated on host start");
    // old token no longer works
    h2.connect_refused(json!({"type": "hello", "role": "control", "token": home.1}));
}

#[test]
fn start_only_runs_approved_automations() {
    let host = TestHost::start();
    let mut c = host.connect(host.control_hello());

    // the old arbitrary-command start is gone
    let r = c.req(json!({"type": "start", "name": "x", "argv": ["sleep", "30"]}));
    assert_eq!(r["ok"], false);
    let r = c.req(json!({"type": "start", "name": "x", "automationPath": "/bin/sleep", "argv": ["sleep", "30"], "env": {"A": "b"}}));
    assert_eq!(r["ok"], false);
    assert!(r["error"].as_str().unwrap().contains("automationPath"), "{r}");

    // not yet approved + no UI => denied; nothing spawned
    let f = host.home.join("auto/new.ts");
    std::fs::write(&f, "sdk.keepAlive();").unwrap();
    let r = c.req(json!({"type": "start", "automationPath": f}));
    assert_eq!(r["ok"], false, "{r}");
    assert!(r["error"].as_str().unwrap().contains("not approved"), "{r}");
    assert!(workers(&mut c).is_empty());
    let r = c.req(json!({"type": "approve", "automationPath": f}));
    assert_eq!(r["ok"], false, "{r}");

    // approved (as if the user clicked Approve) => runs
    host.approve_existing(&f);
    let r = c.req(json!({"type": "approvals"}));
    assert_eq!(r["result"]["approvals"].as_array().unwrap().len(), 1);
    let r = c.req(json!({"type": "start", "automationPath": f}));
    assert_eq!(r["ok"], true, "{r}");

    // approvals list: path + approvedAt + lastRunAt (stamped by the start above)
    let r = c.req(json!({"type": "approvals"}));
    let a = &r["result"]["approvals"][0];
    assert_eq!(a["approvedAt"], 1, "{r}");
    assert!(a["lastRunAt"].as_u64().unwrap() > 0, "{r}");
    assert!(a.get("sha256").is_none(), "{r}");

    // content changed => still runs (approval is path-based, no hash check)
    std::fs::write(&f, "sdk.keepAlive(); // changed").unwrap();
    let r = c.req(json!({"type": "start", "automationPath": f}));
    assert_eq!(r["ok"], true, "{r}");

    // revoke => denied
    let r = c.req(json!({"type": "revoke", "automationPath": f}));
    assert_eq!(r["result"]["revoked"].as_array().unwrap().len(), 1, "{r}");
    let r = c.req(json!({"type": "start", "automationPath": f}));
    assert_eq!(r["ok"], false, "{r}");
    let r = c.req(json!({"type": "revoke"}));
    assert_eq!(r["ok"], false);

    // missing file
    let r = c.req(json!({"type": "start", "automationPath": "/no/such/file.ts"}));
    assert_eq!(r["ok"], false);

    // rearm while not halted is a no-op success; no UI needed
    let r = c.req(json!({"type": "rearm"}));
    assert_eq!(r["result"]["rearmed"], true, "{r}");

    // audit trail: denies, starts (with sha256 + pid), exit, revoke
    let r = c.req(json!({"type": "audit", "limit": 100}));
    assert_eq!(r["ok"], true, "{r}");
    let entries = r["result"]["entries"].as_array().unwrap().clone();
    let ev = |name: &str| entries.iter().filter(|e| e["event"] == name).count();
    assert!(ev("deny") >= 2, "{entries:?}");
    assert_eq!(ev("start"), 2, "{entries:?}");
    assert_eq!(ev("revoke"), 1, "{entries:?}");
    assert!(ev("exit") >= 1, "{entries:?}"); // replaced workers exit
    let start = entries.iter().find(|e| e["event"] == "start").unwrap();
    assert_eq!(start["kind"], "always");
    assert_eq!(start["sha256"].as_str().unwrap().len(), 64);
    assert!(start["workerId"].is_string() && start["pid"].is_u64() && start["ts"].is_u64());
    assert!(start["path"].as_str().unwrap().ends_with("new.ts"));
    let r = c.req(json!({"type": "audit", "limit": 1}));
    assert_eq!(r["result"]["entries"].as_array().unwrap().len(), 1);
    use std::os::unix::fs::PermissionsExt;
    let log = host.home.join(".knowhow/computer-use/audit.log");
    assert_eq!(std::fs::metadata(&log).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn security_files_have_private_modes() {
    use std::os::unix::fs::PermissionsExt;
    let host = TestHost::start();
    let auto = host.approved("m", "x");
    let mut c = host.connect(host.control_hello());
    assert_eq!(c.req(json!({"type": "start", "automationPath": auto}))["ok"], true);
    std::thread::sleep(Duration::from_millis(200));
    let mode = |p: PathBuf| std::fs::metadata(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())).permissions().mode() & 0o777;
    let kh = host.home.join(".knowhow");
    assert_eq!(mode(host.sock()), 0o600, "socket");
    assert_eq!(mode(kh.join("run")), 0o700, "run dir");
    assert_eq!(mode(kh.join("run/logs")), 0o700, "logs dir");
    assert_eq!(mode(kh.join("computer-use")), 0o700, "computer-use dir");
    assert_eq!(mode(host.token_path()), 0o600, "token");
    assert_eq!(mode(kh.join("computer-use/approvals.json")), 0o600, "approvals");
    for e in std::fs::read_dir(kh.join("run/logs")).unwrap() {
        assert_eq!(mode(e.unwrap().path()), 0o600, "worker log");
    }
}

#[test]
fn rejects_requests_before_hello() {
    let host = TestHost::start();
    let s = UnixStream::connect(host.sock()).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut r = BufReader::new(s.try_clone().unwrap());
    let mut w = s;
    writeln!(w, "{}", json!({"type": "list", "reqId": 1})).unwrap();
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    let v: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["ok"], false);
}

// ---------------------------------------------------------------- kill-switch race

fn stubborn_spec(name: &str) -> knowhow_computer_host::supervisor::StartSpec {
    use knowhow_computer_host::supervisor::{SingleInstance, StartSpec};
    StartSpec {
        name: name.into(),
        // ignores SIGTERM: stopping it takes the full 250 ms grace + hard kill
        argv: vec!["/bin/sh".into(), "-c".into(), "trap '' TERM; sleep 30".into()],
        cwd: None,
        single_instance: SingleInstance::Replace,
        automation: None,
        run_args: None,
    }
}

/// The old race: `start` (replace) awaits stopping the previous worker, the
/// kill switch fires during that wait, then the new worker still spawned.
#[tokio::test]
async fn kill_switch_during_replace_stop_blocks_the_new_spawn() {
    use knowhow_computer_host::supervisor::{Supervisor, HALTED_MSG};
    let home = PathBuf::from(format!("/tmp/khrace-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);

    let sup = Supervisor::new();
    sup.start(stubborn_spec("stubborn")).await.unwrap();
    assert_eq!(sup.select(None, None, true).len(), 1);
    // let sh actually run `trap '' TERM` before anything signals it
    tokio::time::sleep(Duration::from_millis(300)).await;

    // replacement start: spends ~250 ms stopping the old worker first
    let s2 = sup.clone();
    let t = tokio::spawn(async move { s2.start(stubborn_spec("stubborn")).await });
    tokio::time::sleep(Duration::from_millis(60)).await;

    // kill switch fires in the middle of that wait
    sup.set_halted(true);
    sup.stop_all().await;

    let r = t.await.unwrap();
    assert_eq!(r.unwrap_err(), HALTED_MSG);
    assert!(sup.select(None, None, true).is_empty(), "nothing may be left running after the kill switch");
    // and it stays blocked until re-armed
    assert!(sup.start(stubborn_spec("again")).await.is_err());
    assert!(sup.select(None, None, true).is_empty());
    sup.set_halted(false);
    sup.start(stubborn_spec("again")).await.unwrap();
    sup.stop_all().await;
    let _ = std::fs::remove_dir_all(&home);
}
