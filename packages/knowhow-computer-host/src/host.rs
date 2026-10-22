//! Shared host state + the kill-switch action.

use crate::approval::{self, Approved, Kind, Prompter};
use crate::audit::{self, Entry};
use crate::chord::Chord;
use crate::hook::{self, HookCtx, HookEvent};
use crate::gui::GuiManager;
use crate::hotkeys::{HotkeyReg, Table, Tracker};
use crate::proto::{self, RunArgs, StatusInfo};
use crate::supervisor::{SingleInstance, StartSpec, Supervisor, WorkerInfo, HALTED_MSG};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

/// Interpreter + runner script the host spawns for every automation. Fixed at
/// host start (`--node`, `--runner`); clients can never change them.
#[derive(Clone, Debug)]
pub struct Runner {
    pub node: PathBuf,
    pub script: PathBuf,
}

/// Default automation name: file name without a script extension.
pub fn automation_name(path: &str) -> String {
    let base = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    for ext in [".ts", ".js", ".mts", ".cts", ".khs"] {
        if let Some(stem) = base.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    base
}

#[derive(Debug, Clone)]
pub enum UiEvent {
    /// Workers / menu items changed: rebuild the tray menu.
    StateChanged,
    /// Kill switch fired (true) / finished (false).
    Halted(bool),
    Quit,
}

type UiFn = Arc<dyn Fn(UiEvent) + Send + Sync>;

pub struct Host {
    pub kill_switch: String,
    pub table: Arc<RwLock<Table>>,
    pub tracker: Arc<Mutex<Tracker>>,
    pub sup: Arc<Supervisor>,
    pub armed: AtomicBool,
    pub hook_error: Mutex<Option<String>>,
    pub halted: AtomicBool,
    /// Keys each worker reported as held (IPC `heldKeys`).
    pub held_reported: Mutex<HashMap<String, Vec<String>>>,
    /// Custom tray items per worker: (id, label).
    pub tray_items: Mutex<HashMap<String, Vec<(String, String)>>>,
    pub shutdown: tokio::sync::Notify,
    /// Native GUI front door (windows per worker, dispatch to the main thread).
    pub gui: Arc<GuiManager>,
    runner: RwLock<Option<Runner>>,
    /// Random per-start secret that control clients read from `host.token`.
    control_token: RwLock<String>,
    prompter: RwLock<Arc<dyn Prompter>>,
    approvals_path: RwLock<PathBuf>,
    /// Serializes native dialogs so a client cannot stack prompts. Held for the
    /// whole (up to 120 s) dialog — so it must NOT guard the store.
    dialog_lock: tokio::sync::Mutex<()>,
    /// Guards every read-modify-write of `approvals.json` (approve commit,
    /// revoke, lastRunAt). Only ever held briefly, never across a dialog.
    approval_lock: tokio::sync::Mutex<()>,
    ui: Mutex<Option<UiFn>>,
}

impl Host {
    pub fn new(kill: Chord, kill_switch: String) -> Arc<Host> {
        let host = Arc::new(Host {
            kill_switch,
            table: Arc::new(RwLock::new(Table::default())),
            tracker: Arc::new(Mutex::new(Tracker::new(kill))),
            sup: Supervisor::new(),
            armed: AtomicBool::new(false),
            hook_error: Mutex::new(None),
            halted: AtomicBool::new(false),
            held_reported: Mutex::new(HashMap::new()),
            tray_items: Mutex::new(HashMap::new()),
            shutdown: tokio::sync::Notify::new(),
            gui: GuiManager::new(),
            runner: RwLock::new(None),
            control_token: RwLock::new(String::new()),
            prompter: RwLock::new(Arc::new(approval::NativePrompter::default())),
            approvals_path: RwLock::new(crate::config::approvals_path()),
            dialog_lock: tokio::sync::Mutex::new(()),
            approval_lock: tokio::sync::Mutex::new(()),
            ui: Mutex::new(None),
        });
        let weak = Arc::downgrade(&host);
        host.sup.set_on_change(Arc::new(move || {
            if let Some(h) = weak.upgrade() {
                h.emit(UiEvent::StateChanged);
            }
        }));
        // GUI events -> the owning worker's connection as `guiEvent`.
        let weak = Arc::downgrade(&host);
        host.gui.set_event_sink(Arc::new(move |ev| {
            if let Some(h) = weak.upgrade() {
                h.sup.send(&ev.owner, &ev.to_wire());
            }
        }));
        // Worker process exited (stop / restart / crash / kill): drop its windows.
        let weak = Arc::downgrade(&host);
        host.sup.set_on_exit(Arc::new(move |id| {
            if let Some(h) = weak.upgrade() {
                h.gui.destroy_all_for(id);
                if let Some(p) = h.sup.find_by_id(id) {
                    let info = p.snapshot();
                    let mut e = Entry::new("exit").worker(id, None).code(info.exit_code);
                    if let Some(a) = &p.spec.automation {
                        e = e.path(a.clone());
                    }
                    h.audit(e);
                }
            }
        }));
        host
    }

    pub fn set_runner(&self, r: Runner) {
        *self.runner.write().unwrap() = Some(r);
    }

    pub fn set_prompter(&self, p: Arc<dyn Prompter>) {
        *self.prompter.write().unwrap() = p;
    }

    pub fn set_approvals_path(&self, p: PathBuf) {
        *self.approvals_path.write().unwrap() = p;
    }

    pub fn approvals_path(&self) -> PathBuf {
        self.approvals_path.read().unwrap().clone()
    }

    /// The audit log lives next to the approvals file.
    pub fn audit_path(&self) -> PathBuf {
        self.approvals_path().with_file_name("audit.log")
    }

    /// Append to the audit log (best effort).
    pub fn audit(&self, e: Entry) {
        audit::record(&self.audit_path(), e);
    }

    /// Most recent `limit` audit entries, oldest first.
    pub fn audit_tail(&self, limit: usize) -> Vec<Entry> {
        audit::read_tail(&self.audit_path(), limit)
    }

    /// Generate a fresh control token (rotated on every host start) and
    /// persist it owner-only. Failure is fatal for the caller.
    pub fn init_control_token(&self) -> std::io::Result<String> {
        let t = crate::security::random_token()?;
        crate::security::write_private_atomic(&crate::config::token_path(), t.as_bytes())?;
        *self.control_token.write().unwrap() = t.clone();
        Ok(t)
    }

    pub fn set_control_token(&self, t: &str) {
        *self.control_token.write().unwrap() = t.to_string();
    }

    pub fn verify_control_token(&self, presented: &str) -> bool {
        let t = self.control_token.read().unwrap();
        !t.is_empty() && crate::security::ct_eq(&t, presented)
    }

    pub fn set_ui(&self, f: UiFn) {
        *self.ui.lock().unwrap() = Some(f);
    }

    pub fn emit(&self, ev: UiEvent) {
        let f = self.ui.lock().unwrap().clone();
        if let Some(f) = f {
            f(ev);
        }
    }

    pub fn status(&self) -> StatusInfo {
        StatusInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
            kill_switch: self.kill_switch.clone(),
            kill_switch_armed: self.armed.load(Ordering::SeqCst),
            hook_error: self.hook_error.lock().unwrap().clone(),
            platform: std::env::consts::OS.to_string(),
            halted: self.halted.load(Ordering::SeqCst),
            runner_configured: self.runner.read().unwrap().is_some(),
        }
    }

    /// Arm the keyboard hook and route its events. Must run inside tokio.
    pub fn start_hook(self: &Arc<Self>, print_keys: bool) {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<HookEvent>();
        let ctx = HookCtx {
            tracker: self.tracker.clone(),
            table: self.table.clone(),
            tx,
            print_keys,
        };
        match hook::start(ctx) {
            Ok(()) => self.armed.store(true, Ordering::SeqCst),
            Err(e) => {
                eprintln!("knowhow-computer-host: kill switch NOT armed: {e}");
                *self.hook_error.lock().unwrap() = Some(e);
                return;
            }
        }
        let host = self.clone();
        tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                match ev {
                    HookEvent::Kill => {
                        let h = host.clone();
                        tokio::spawn(async move { h.kill_switch_action().await });
                    }
                    HookEvent::Fire { owner, id } => {
                        if !host.sup.send(&owner, &proto::ev_hotkey(&id)) {
                            // worker gone: don't leave the hotkey stuck busy
                            host.table.read().unwrap().done(&owner, &id);
                        }
                    }
                    HookEvent::Key(text) => println!("{text}"),
                }
            }
        });
    }

    // ---- hotkey registry ----

    pub fn register_hotkey(&self, reg: HotkeyReg) {
        self.table.write().unwrap().register(reg);
        self.sup.notify_changed();
    }

    pub fn unregister_hotkey(&self, owner: &str, id: &str) {
        self.table.write().unwrap().unregister(owner, id);
        self.sup.notify_changed();
    }

    pub fn set_suspended(&self, owner: &str, suspended: bool) {
        let mut t = self.table.write().unwrap();
        if suspended {
            t.suspended.insert(owner.to_string());
        } else {
            t.suspended.remove(owner);
        }
        drop(t);
        self.sup.notify_changed();
    }

    pub fn is_suspended(&self, owner: &str) -> bool {
        self.table.read().unwrap().suspended.contains(owner)
    }

    /// A worker's IPC connection closed (or it exited): drop its hotkeys and
    /// release anything it still reported as held.
    pub fn worker_gone(&self, id: &str) {
        self.table.write().unwrap().remove_owner(id);
        self.tray_items.lock().unwrap().remove(id);
        self.gui.destroy_all_for(id);
        let held = self.held_reported.lock().unwrap().remove(id).unwrap_or_default();
        if !held.is_empty() {
            self.release_names(&held);
        }
        self.sup.notify_changed();
    }

    fn release_names(&self, names: &[String]) {
        let codes: Vec<u32> = names.iter().filter_map(|n| hook::code_for_name(n)).collect();
        hook::release_input(&codes);
    }

    pub fn list(&self) -> Vec<WorkerInfo> {
        let table = self.table.read().unwrap();
        self.sup
            .list()
            .into_iter()
            .map(|mut w| {
                w.hotkeys_suspended = table.suspended.contains(&w.id);
                w.hotkey_count = table.count_for(&w.id);
                w
            })
            .collect()
    }

    /// Approve (if needed) and start an automation. The ONLY way a worker is
    /// spawned: blocked while the kill switch is latched, requires a path
    /// approval (once / always), and the argv is built here from the
    /// host-configured runner (never client-supplied).
    pub async fn launch(
        self: &Arc<Self>,
        automation_path: &str,
        name: Option<String>,
        args: Option<RunArgs>,
        cwd: Option<String>,
        single_instance: SingleInstance,
    ) -> Result<(WorkerInfo, bool), String> {
        if self.halted.load(Ordering::SeqCst) {
            return Err(HALTED_MSG.into());
        }
        let runner = self
            .runner
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| "host has no runner configured (start it with --node <node> --runner <worker.js>)".to_string())?;
        if let Some(c) = &cwd {
            if !std::path::Path::new(c).is_dir() {
                return Err(format!("cwd '{c}' is not a directory"));
            }
        }
        let args = args.unwrap_or_default();
        if let Some(p) = &args.params {
            if !p.is_object() {
                return Err("args.params must be a JSON object".into());
            }
        }
        let approved = self.approve_path(automation_path, true).await?;
        if self.halted.load(Ordering::SeqCst) {
            return Err("kill switch tripped while waiting for approval".into());
        }
        // Informational only (audit log). Approval is path-based; the file is
        // deliberately not re-verified against any hash.
        let sha256 = approval::file_sha256(&approved.real_path).ok();
        let real = approved.real_path.to_string_lossy().into_owned();
        let mut argv = vec![
            runner.node.to_string_lossy().into_owned(),
            runner.script.to_string_lossy().into_owned(),
            "--name".into(),
            real.clone(),
        ];
        if let Some(c) = &cwd {
            argv.extend(["--cwd".into(), c.clone()]);
        }
        if let Some(p) = &args.params {
            argv.extend(["--params".into(), p.to_string()]);
        }
        if let Some(ms) = args.max_duration_ms {
            argv.extend(["--max-duration".into(), ms.to_string()]);
        }
        if args.dry_run == Some(true) {
            argv.push("--dry-run".into());
        }
        let spec = StartSpec {
            name: name.unwrap_or_else(|| automation_name(&real)),
            argv,
            cwd,
            single_instance,
            automation: Some(real.clone()),
            run_args: Some(args),
        };
        // `Supervisor::start` re-checks the kill-switch latch under the lock
        // the kill switch takes, immediately before spawning (the stop of a
        // replaced worker above can take 250 ms, long enough for a kill).
        let (info, started) = self.sup.start(spec).await?;
        if started {
            let mut e = Entry::new("start").path(real.clone()).worker(info.id.clone(), info.pid).kind(approved.kind.as_str());
            if let Some(h) = sha256 {
                e = e.sha256(h);
            }
            self.audit(e);
            if approved.kind == Kind::Always {
                let _g = self.approval_lock.lock().await;
                if let Err(e) = approval::touch_last_run(&self.approvals_path(), &real) {
                    eprintln!("knowhow-computer-host: cannot record lastRunAt: {e}");
                }
            }
        }
        Ok((info, started))
    }

    /// Approval for `path` (already stored, or via the native dialog).
    ///
    /// Locking: `dialog_lock` serializes dialogs for their whole duration;
    /// `approval_lock` is taken only around the store snapshot and again
    /// around the commit, which re-reads the store and writes only this one
    /// entry (compare-and-set). A revoke that lands while the dialog is open
    /// therefore can never be undone by a stale write-back.
    ///
    /// `allow_once == false` (the IPC `approve` request) refuses an
    /// "Allow once" answer: nothing would be recorded and nothing started.
    pub async fn approve_path(self: &Arc<Self>, path: &str, allow_once: bool) -> Result<Approved, String> {
        let _dialog = self.dialog_lock.lock().await;
        let store = self.approvals_path();
        let prepared = {
            let _g = self.approval_lock.lock().await;
            approval::prepare(&store, path)?
        };
        if prepared.existing.is_some() {
            return Ok(Approved { real_path: prepared.real_path, kind: Kind::Always, prompted: false });
        }
        let prompter = self.prompter.read().unwrap().clone();
        let p2 = prepared.clone();
        let decision = tokio::task::spawn_blocking(move || approval::ask(&p2, &*prompter))
            .await
            .map_err(|e| e.to_string())?;
        let _g = self.approval_lock.lock().await;
        match approval::settle(&store, &prepared, decision, allow_once) {
            Ok(kind) => {
                self.audit(Entry::new("approve").path(prepared.key.clone()).kind(kind.as_str()));
                Ok(Approved { real_path: prepared.real_path, kind, prompted: true })
            }
            Err(e) => {
                self.audit(Entry::new("deny").path(prepared.key.clone()).detail(e.clone()));
                Err(e)
            }
        }
    }

    /// Revoke one stored approval (or all). Takes `approval_lock`.
    pub async fn revoke(&self, path: Option<&str>) -> Result<Vec<String>, String> {
        let _g = self.approval_lock.lock().await;
        let removed = approval::revoke(&self.approvals_path(), path)?;
        for k in &removed {
            self.audit(Entry::new("revoke").path(k.clone()));
        }
        Ok(removed)
    }

    /// Stored approvals (path, approvedAt, lastRunAt), sorted by path.
    pub async fn approvals(&self) -> Vec<(String, approval::Approval)> {
        let _g = self.approval_lock.lock().await;
        approval::load(&self.approvals_path()).into_iter().collect()
    }

    pub async fn restart(self: &Arc<Self>, name: Option<&str>, id: Option<&str>) -> Result<WorkerInfo, String> {
        let spec: StartSpec = self
            .sup
            .spec_for(id, name)
            .ok_or_else(|| "no such worker".to_string())?;
        let automation = spec.automation.clone().ok_or_else(|| "worker has no approved automation to restart".to_string())?;
        let live = self.sup.select(name, id, false);
        for p in &live {
            self.gui.destroy_all_for(&p.id());
        }
        self.sup.stop_many(live).await;
        // Re-runs the (path-based) approval check: a path approved only "once" asks again.
        self.launch(&automation, Some(spec.name), spec.run_args, spec.cwd, SingleInstance::Replace)
            .await
            .map(|(i, _)| i)
    }

    // ---- kill switch ----

    /// Halt, stop every worker (250 ms then hard kill), release stuck input.
    /// The latch STAYS set: new starts and hotkeys are blocked until an
    /// explicit [`Host::rearm`] (there is no auto-clear timer).
    pub async fn kill_switch_action(self: &Arc<Self>) {
        if self.halted.swap(true, Ordering::SeqCst) {
            return;
        }
        // Takes the supervisor's spawn lock: after this returns no start can
        // spawn, and any start that already spawned is registered and will be
        // seen (and killed) by `stop_all` below.
        self.sup.set_halted(true);
        self.audit(Entry::new("halt"));
        eprintln!("knowhow-computer-host: KILL SWITCH ({}) — stopping all automations; starts blocked until re-armed", self.kill_switch);
        self.table.read().unwrap().halted.store(true, Ordering::SeqCst);
        self.emit(UiEvent::Halted(true));

        self.sup.stop_all().await;
        self.gui.destroy_all();
        self.release_stuck_input();
        self.sup.notify_changed();
    }

    /// Clear the kill-switch latch after a native human confirmation.
    /// Returns Ok(false) when the user declined / no UI (stays halted).
    pub async fn rearm(self: &Arc<Self>) -> Result<bool, String> {
        if !self.halted.load(Ordering::SeqCst) {
            return Ok(true);
        }
        let _guard = self.dialog_lock.lock().await;
        let prompter = self.prompter.read().unwrap().clone();
        let ok = tokio::task::spawn_blocking(move || {
            prompter.confirm(
                "knowhow computer host — re-arm",
                "The kill switch stopped all automations.\n\nAllow automations to start again?",
            )
        })
        .await
        .map_err(|e| e.to_string())?;
        if ok {
            self.clear_halt();
        }
        Ok(ok)
    }

    fn clear_halt(&self) {
        self.audit(Entry::new("rearm"));
        self.sup.set_halted(false);
        self.table.read().unwrap().halted.store(false, Ordering::SeqCst);
        self.halted.store(false, Ordering::SeqCst);
        self.emit(UiEvent::Halted(false));
        self.sup.notify_changed();
    }

    /// Key-up / mouse-up for everything the hook saw down, all modifiers and
    /// mouse buttons, plus keys workers reported as held.
    pub fn release_stuck_input(&self) {
        let mut codes = {
            let mut t = self.tracker.lock().unwrap();
            let c = t.held_native();
            t.clear();
            c
        };
        let reported: Vec<String> = {
            let mut m = self.held_reported.lock().unwrap();
            let v = m.values().flatten().cloned().collect();
            m.clear();
            v
        };
        codes.extend(reported.iter().filter_map(|n| hook::code_for_name(n)));
        hook::release_input(&codes);
    }
}
