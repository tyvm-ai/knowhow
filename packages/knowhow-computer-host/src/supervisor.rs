//! Worker process supervisor: spawn, capture logs, track status, stop
//! (IPC `stop` → SIGTERM → hard kill after 250 ms), pause/resume.

use crate::config;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::sync::{mpsc::UnboundedSender, watch, Notify};

pub const STOP_GRACE_MS: u64 = 250;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SingleInstance {
    Replace,
    Ignore,
    Allow,
}

impl SingleInstance {
    pub fn parse(s: Option<&str>) -> Result<Self, String> {
        match s {
            None | Some("replace") => Ok(Self::Replace),
            Some("ignore") => Ok(Self::Ignore),
            Some("allow") => Ok(Self::Allow),
            Some(o) => Err(format!("singleInstance must be replace|ignore|allow, got '{o}'")),
        }
    }
}

#[derive(Clone, Debug)]
pub struct StartSpec {
    pub name: String,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
    pub single_instance: SingleInstance,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerInfo {
    pub id: String,
    pub name: String,
    pub pid: Option<u32>,
    /// "running" | "paused" | "exited"
    pub status: String,
    pub exit_code: Option<i32>,
    pub started_at: u64,
    pub log_path: String,
    pub connected: bool,
    pub hotkeys_suspended: bool,
    pub hotkey_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tray_status: Option<String>,
}

pub struct Proc {
    pub info: Mutex<WorkerInfo>,
    pub spec: StartSpec,
    exit_rx: watch::Receiver<bool>,
    kill: Arc<Notify>,
}

impl Proc {
    pub fn snapshot(&self) -> WorkerInfo {
        self.info.lock().unwrap().clone()
    }
    pub fn is_exited(&self) -> bool {
        *self.exit_rx.borrow()
    }
    pub fn id(&self) -> String {
        self.info.lock().unwrap().id.clone()
    }
    pub fn name(&self) -> String {
        self.info.lock().unwrap().name.clone()
    }
    #[allow(dead_code)]
    fn pid(&self) -> Option<u32> {
        self.info.lock().unwrap().pid
    }
}

#[derive(Default)]
pub struct Supervisor {
    procs: Mutex<Vec<Arc<Proc>>>,
    conns: Mutex<HashMap<String, UnboundedSender<String>>>,
    counter: AtomicU64,
    on_change: RwLock<Option<Arc<dyn Fn() + Send + Sync>>>,
    on_exit: RwLock<Option<Arc<dyn Fn(&str) + Send + Sync>>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Supervisor {
    pub fn new() -> Arc<Self> {
        Arc::new(Supervisor::default())
    }

    pub fn set_on_change(&self, f: Arc<dyn Fn() + Send + Sync>) {
        *self.on_change.write().unwrap() = Some(f);
    }

    /// Called with the worker id when its process has exited (stop / crash / kill).
    pub fn set_on_exit(&self, f: Arc<dyn Fn(&str) + Send + Sync>) {
        *self.on_exit.write().unwrap() = Some(f);
    }

    pub fn notify_changed(&self) {
        if let Some(f) = self.on_change.read().unwrap().clone() {
            f();
        }
    }

    // ---- IPC connection registry (workers that said hello) ----

    pub fn set_conn(&self, id: &str, tx: UnboundedSender<String>) {
        self.conns.lock().unwrap().insert(id.to_string(), tx);
        self.notify_changed();
    }

    pub fn remove_conn(&self, id: &str) {
        self.conns.lock().unwrap().remove(id);
    }

    pub fn is_connected(&self, id: &str) -> bool {
        self.conns.lock().unwrap().contains_key(id)
    }

    /// Send a JSON line to a connected worker. False if not connected.
    pub fn send(&self, id: &str, line: &str) -> bool {
        match self.conns.lock().unwrap().get(id) {
            Some(tx) => tx.send(line.to_string()).is_ok(),
            None => false,
        }
    }

    // ---- queries ----

    pub fn list(&self) -> Vec<WorkerInfo> {
        let procs = self.procs.lock().unwrap().clone();
        procs
            .iter()
            .map(|p| {
                let mut i = p.snapshot();
                i.connected = self.is_connected(&i.id);
                i
            })
            .collect()
    }

    pub fn find_by_id(&self, id: &str) -> Option<Arc<Proc>> {
        self.procs.lock().unwrap().iter().find(|p| p.id() == id).cloned()
    }

    /// Start spec of the most recent worker matching id/name (any status).
    pub fn spec_for(&self, id: Option<&str>, name: Option<&str>) -> Option<StartSpec> {
        let procs = self.procs.lock().unwrap();
        procs
            .iter()
            .rev()
            .find(|p| id.map_or(false, |i| p.id() == i) || name.map_or(false, |n| p.name() == n))
            .map(|p| p.spec.clone())
    }

    /// Select live procs by id, name or all.
    pub fn select(&self, name: Option<&str>, id: Option<&str>, all: bool) -> Vec<Arc<Proc>> {
        self.procs
            .lock()
            .unwrap()
            .iter()
            .filter(|p| !p.is_exited())
            .filter(|p| {
                all || id.map_or(false, |i| p.id() == i) || name.map_or(false, |n| p.name() == n)
            })
            .cloned()
            .collect()
    }

    pub fn set_tray_status(&self, id: &str, text: Option<String>) {
        if let Some(p) = self.find_by_id(id) {
            p.info.lock().unwrap().tray_status = text;
        }
        self.notify_changed();
    }

    pub fn log_path_for(&self, id: Option<&str>, name: Option<&str>) -> Option<PathBuf> {
        let procs = self.procs.lock().unwrap();
        procs
            .iter()
            .rev()
            .find(|p| id.map_or(false, |i| p.id() == i) || name.map_or(false, |n| p.name() == n))
            .map(|p| PathBuf::from(p.snapshot().log_path))
    }
}


// ---- lifecycle ----

impl Supervisor {
    /// Start a worker. Returns (info, started). `started == false` means
    /// `singleInstance: ignore` refused it and `info` is the existing worker.
    pub async fn start(self: &Arc<Self>, spec: StartSpec) -> Result<(WorkerInfo, bool), String> {
        if spec.argv.is_empty() {
            return Err("argv must not be empty".into());
        }
        if spec.name.is_empty() {
            return Err("name must not be empty".into());
        }
        let existing = self.select(Some(&spec.name), None, false);
        match spec.single_instance {
            SingleInstance::Ignore if !existing.is_empty() => {
                return Ok((existing[0].snapshot(), false));
            }
            SingleInstance::Replace => self.stop_many(existing).await,
            _ => {}
        }
        self.prune_exited(&spec.name);

        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        let id = format!("{:x}{:02x}", now_ms() & 0xffff_ffff, n & 0xff);
        let log_dir = config::logs_dir();
        std::fs::create_dir_all(&log_dir).map_err(|e| format!("create log dir: {e}"))?;
        let safe_name: String = spec
            .name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let log_path = log_dir.join(format!("{safe_name}-{id}.log"));
        let log = std::fs::File::create(&log_path).map_err(|e| format!("create log: {e}"))?;

        let mut cmd = Command::new(&spec.argv[0]);
        cmd.args(&spec.argv[1..]);
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        cmd.envs(&spec.env);
        cmd.env("KNOWHOW_HOST_WORKER_ID", &id);
        cmd.env("KNOWHOW_HOST_NAME", &spec.name);
        #[cfg(unix)]
        cmd.env("KNOWHOW_HOST_ENDPOINT", config::socket_path());
        #[cfg(windows)]
        cmd.env("KNOWHOW_HOST_ENDPOINT", config::pipe_name());
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        cmd.process_group(0); // own group: hard kill reaps grandchildren too
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn().map_err(|e| format!("spawn '{}': {e}", spec.argv[0]))?;
        let pid = child.id();
        #[cfg(windows)]
        if let Some(h) = child.raw_handle() {
            job::assign(h as isize);
        }

        if let (Some(mut out), Ok(f)) = (child.stdout.take(), log.try_clone()) {
            let mut f = tokio::fs::File::from_std(f);
            tokio::spawn(async move {
                let _ = tokio::io::copy(&mut out, &mut f).await;
            });
        }
        if let (Some(mut err), Ok(f)) = (child.stderr.take(), log.try_clone()) {
            let mut f = tokio::fs::File::from_std(f);
            tokio::spawn(async move {
                let _ = tokio::io::copy(&mut err, &mut f).await;
            });
        }

        let (exit_tx, exit_rx) = watch::channel(false);
        let kill = Arc::new(Notify::new());
        let info = WorkerInfo {
            id: id.clone(),
            name: spec.name.clone(),
            pid,
            status: "running".into(),
            exit_code: None,
            started_at: now_ms(),
            log_path: log_path.to_string_lossy().into_owned(),
            connected: false,
            hotkeys_suspended: false,
            hotkey_count: 0,
            tray_status: None,
        };
        let proc = Arc::new(Proc {
            info: Mutex::new(info.clone()),
            spec,
            exit_rx,
            kill: kill.clone(),
        });
        self.procs.lock().unwrap().push(proc.clone());
        self.notify_changed();

        let sup = self.clone();
        let p2 = proc.clone();
        tokio::spawn(async move {
            let status = tokio::select! {
                s = child.wait() => s.ok(),
                _ = kill.notified() => {
                    let _ = child.start_kill();
                    child.wait().await.ok()
                }
            };
            let code = status.and_then(|s| {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    s.code().or_else(|| s.signal().map(|sig| -sig))
                }
                #[cfg(not(unix))]
                {
                    s.code()
                }
            });
            {
                let mut i = p2.info.lock().unwrap();
                i.status = "exited".into();
                i.exit_code = code;
                i.pid = None;
            }
            let id = p2.id();
            let _ = exit_tx.send(true);
            sup.remove_conn(&id);
            if let Some(f) = sup.on_exit.read().unwrap().clone() {
                f(&id);
            }
            sup.notify_changed();
        });
        Ok((info, true))
    }

    fn prune_exited(&self, name: &str) {
        let mut procs = self.procs.lock().unwrap();
        procs.retain(|p| !(p.is_exited() && p.name() == name));
        while procs.len() > 100 {
            match procs.iter().position(|p| p.is_exited()) {
                Some(i) => {
                    procs.remove(i);
                }
                None => break,
            }
        }
    }

    pub fn hard_kill(&self, p: &Proc) {
        #[cfg(unix)]
        if let Some(pid) = p.pid() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
        p.kill.notify_one();
    }

    /// IPC `stop` → SIGTERM → hard kill after `STOP_GRACE_MS`.
    pub async fn stop_proc(&self, p: &Arc<Proc>) {
        if p.is_exited() {
            return;
        }
        self.send(&p.id(), &crate::proto::ev_simple("stop"));
        #[cfg(unix)]
        if let Some(pid) = p.pid() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        if !self.wait_exit(p, Duration::from_millis(STOP_GRACE_MS)).await {
            self.hard_kill(p);
            self.wait_exit(p, Duration::from_secs(2)).await;
        }
    }

    async fn wait_exit(&self, p: &Proc, dur: Duration) -> bool {
        let mut rx = p.exit_rx.clone();
        if *rx.borrow() {
            return true;
        }
        let fut = async {
            while rx.changed().await.is_ok() {
                if *rx.borrow() {
                    return;
                }
            }
        };
        tokio::time::timeout(dur, fut).await.is_ok() || p.is_exited()
    }

    /// Stop several workers concurrently.
    pub async fn stop_many(self: &Arc<Self>, procs: Vec<Arc<Proc>>) {
        let handles: Vec<_> = procs
            .into_iter()
            .map(|p| {
                let sup = self.clone();
                tokio::spawn(async move { sup.stop_proc(&p).await })
            })
            .collect();
        for h in handles {
            let _ = h.await;
        }
        self.notify_changed();
    }

    pub async fn stop_all(self: &Arc<Self>) {
        let all = self.select(None, None, true);
        self.stop_many(all).await;
    }

    /// Cooperative pause/resume via IPC. Errors if the worker isn't connected.
    pub fn set_paused(&self, p: &Proc, paused: bool) -> Result<(), String> {
        let id = p.id();
        let msg = crate::proto::ev_simple(if paused { "pause" } else { "resume" });
        if !self.send(&id, &msg) {
            return Err(format!("worker {id} is not connected over IPC"));
        }
        {
            let mut i = p.info.lock().unwrap();
            if i.status != "exited" {
                i.status = if paused { "paused".into() } else { "running".into() };
            }
        }
        self.notify_changed();
        Ok(())
    }
}

#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::*;

    static JOB: OnceLock<isize> = OnceLock::new();

    fn job() -> isize {
        *JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(None, None).unwrap_or_default();
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let _ = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            h.0
        })
    }

    /// Children assigned to the job die when the host exits.
    pub fn assign(process_handle: isize) {
        unsafe {
            let _ = AssignProcessToJobObject(HANDLE(job()), HANDLE(process_handle));
        }
    }
}
