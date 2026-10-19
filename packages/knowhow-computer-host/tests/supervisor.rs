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

impl TestHost {
    fn start() -> TestHost {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let home = PathBuf::from(format!("/tmp/khh-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_knowhow-computer-host"))
            .args(["--no-tray", "--foreground"])
            .env("HOME", &home)
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

    fn connect(&self, hello: Value) -> Client {
        let s = UnixStream::connect(self.sock()).expect("connect");
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut c = Client { r: BufReader::new(s.try_clone().unwrap()), w: s, next: 1 };
        let resp = c.req(hello);
        assert_eq!(resp["ok"], true, "hello failed: {resp}");
        c
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
    let mut c = host.connect(json!({"type": "hello", "role": "control"}));

    let st = c.req(json!({"type": "status"}));
    assert_eq!(st["result"]["killSwitch"], "ctrl+alt+esc");
    assert_eq!(st["result"]["pid"], host.child.id());

    let r = c.req(json!({"type": "start", "name": "sleeper", "argv": ["sleep", "30"]}));
    assert_eq!(r["ok"], true, "{r}");
    let pid = r["result"]["worker"]["pid"].as_u64().unwrap() as i32;
    assert_eq!(r["result"]["started"], true);

    let l = workers(&mut c);
    assert_eq!(l.len(), 1);
    assert_eq!(l[0]["name"], "sleeper");
    assert_eq!(l[0]["status"], "running");

    // singleInstance: ignore refuses a second one
    let r = c.req(json!({"type": "start", "name": "sleeper", "argv": ["sleep", "30"], "singleInstance": "ignore"}));
    assert_eq!(r["result"]["started"], false);

    let t0 = Instant::now();
    let r = c.req(json!({"type": "stop", "all": true}));
    assert_eq!(r["ok"], true, "{r}");
    assert!(t0.elapsed() < Duration::from_secs(1), "stop took {:?}", t0.elapsed());
    assert!(workers(&mut c).iter().all(|w| !alive(w)), "worker still listed alive");
    // the OS process is really gone
    let gone = unsafe { libc::kill(pid, 0) } != 0;
    assert!(gone, "process {pid} still exists");

    // a log file was written under ~/.knowhow/run/logs
    let logs: Vec<_> = std::fs::read_dir(host.home.join(".knowhow/run/logs")).unwrap().collect();
    assert_eq!(logs.len(), 1);
}

#[test]
fn replace_restart_and_output_capture() {
    let host = TestHost::start();
    let mut c = host.connect(json!({"type": "hello", "role": "control"}));
    let r = c.req(json!({"type": "start", "name": "echoer", "argv": ["sh", "-c", "echo hello-from-worker; sleep 30"]}));
    let id1 = r["result"]["worker"]["id"].as_str().unwrap().to_string();
    std::thread::sleep(Duration::from_millis(300));
    let logs = c.req(json!({"type": "logs", "id": id1}));
    assert!(logs["result"]["tail"].as_str().unwrap().contains("hello-from-worker"), "{logs}");

    // default singleInstance = replace: old one is stopped
    let r = c.req(json!({"type": "start", "name": "echoer", "argv": ["sleep", "30"]}));
    assert_eq!(r["result"]["started"], true);
    let live: Vec<_> = workers(&mut c).into_iter().filter(alive).collect();
    assert_eq!(live.len(), 1);
    assert_ne!(live[0]["id"], json!(id1));

    let r = c.req(json!({"type": "restart", "name": "echoer"}));
    assert_eq!(r["ok"], true, "{r}");
    let live: Vec<_> = workers(&mut c).into_iter().filter(alive).collect();
    assert_eq!(live.len(), 1);
    assert_ne!(live[0]["id"], r["result"]["worker"]["id"].clone().to_string());

    let r = c.req(json!({"type": "stop", "name": "nope"}));
    assert_eq!(r["ok"], false);
}

#[test]
fn worker_role_hotkeys_and_second_host_exits() {
    let host = TestHost::start();
    let mut ctl = host.connect(json!({"type": "hello", "role": "control"}));
    let r = ctl.req(json!({"type": "start", "name": "w", "argv": ["sleep", "30"]}));
    let id = r["result"]["worker"]["id"].as_str().unwrap().to_string();

    let mut w = host.connect(json!({"type": "hello", "role": "worker", "workerId": id, "name": "w"}));
    let ok = w.req(json!({"type": "registerHotkey", "id": "h", "chord": "f6", "consume": true}));
    assert_eq!(ok["ok"], true, "{ok}");
    let bad = w.req(json!({"type": "registerHotkey", "id": "k", "chord": "ctrl+alt+esc"}));
    assert_eq!(bad["ok"], false);
    let bad = w.req(json!({"type": "registerHotkey", "id": "k", "chord": "bogus"}));
    assert_eq!(bad["ok"], false);

    let l = workers(&mut ctl);
    assert_eq!(l[0]["hotkeyCount"], 1);
    assert_eq!(l[0]["connected"], true);

    // pause is delivered to the worker as an event
    let r = ctl.req(json!({"type": "pause", "name": "w"}));
    assert_eq!(r["ok"], true, "{r}");
    let mut line = String::new();
    w.r.read_line(&mut line).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["type"], "pause");
    assert_eq!(workers(&mut ctl)[0]["status"], "paused");

    // stop sends {"type":"stop"} to the worker then kills it
    let r = ctl.req(json!({"type": "stop", "id": id}));
    assert_eq!(r["ok"], true);
    assert!(workers(&mut ctl).iter().all(|w| !alive(w)));

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
