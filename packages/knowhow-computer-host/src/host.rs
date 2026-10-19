//! Shared host state + the kill-switch action.

use crate::chord::Chord;
use crate::hook::{self, HookCtx, HookEvent};
use crate::gui::GuiManager;
use crate::hotkeys::{HotkeyReg, Table, Tracker};
use crate::proto::{self, StatusInfo};
use crate::supervisor::{StartSpec, Supervisor, WorkerInfo};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

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
            }
        }));
        host
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

    pub async fn restart(self: &Arc<Self>, name: Option<&str>, id: Option<&str>) -> Result<WorkerInfo, String> {
        let spec: StartSpec = self
            .sup
            .spec_for(id, name)
            .ok_or_else(|| "no such worker".to_string())?;
        let live = self.sup.select(name, id, false);
        for p in &live {
            self.gui.destroy_all_for(&p.id());
        }
        self.sup.stop_many(live).await;
        let mut spec = spec;
        spec.single_instance = crate::supervisor::SingleInstance::Replace;
        self.sup.start(spec).await.map(|(i, _)| i)
    }

    // ---- kill switch ----

    /// Halt, stop every worker (250 ms then hard kill), release stuck input.
    pub async fn kill_switch_action(self: &Arc<Self>) {
        if self.halted.swap(true, Ordering::SeqCst) {
            return;
        }
        eprintln!("knowhow-computer-host: KILL SWITCH ({}) — stopping all automations", self.kill_switch);
        self.table.read().unwrap().halted.store(true, Ordering::SeqCst);
        self.emit(UiEvent::Halted(true));

        self.sup.stop_all().await;
        self.gui.destroy_all();
        self.release_stuck_input();

        // Let the tray show "stopped" briefly, then clear the halted flag.
        tokio::time::sleep(Duration::from_millis(1500)).await;
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
