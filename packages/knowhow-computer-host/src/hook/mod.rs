//! Keyboard hook: one system-wide hook per OS feeding the pure matcher in
//! `crate::hotkeys`. The per-OS modules provide `start`, `release_input`,
//! `classify`, `code_for_key` and `mod_code`.

use crate::chord::{self, Chord, Key};
use crate::hotkeys::{Kind, KeyEvent, Table, Tracker, WorkerId};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::mpsc::UnboundedSender;

/// Tag put on input we inject ourselves (`dwExtraInfo` on Windows,
/// `kCGEventSourceUserData` on macOS). The hook ignores tagged events.
pub const INJECT_MARKER: u32 = 0x4B4E_4F57; // "KNOW"

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as os;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use self::windows as os;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod stub;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use stub as os;

pub use os::{classify, release_input};

#[derive(Debug)]
pub enum HookEvent {
    Kill,
    Fire { owner: WorkerId, id: String },
    /// Normalized key text, only emitted when `print_keys` is set.
    Key(String),
}

/// Everything the OS callback needs. Cheap to share by reference.
pub struct HookCtx {
    pub tracker: Arc<Mutex<Tracker>>,
    pub table: Arc<RwLock<Table>>,
    pub tx: UnboundedSender<HookEvent>,
    pub print_keys: bool,
}

impl HookCtx {
    /// Called from the OS hook callback. Returns true to consume the event.
    /// Never blocks: lock contention means "pass through".
    pub fn handle(&self, ev: KeyEvent) -> bool {
        let mut tracker = match self.tracker.try_lock() {
            Ok(t) => t,
            Err(_) => return false,
        };
        let table = self.table.try_read().ok();
        let d = tracker.on_event(ev, table.as_deref());
        if self.print_keys && ev.down {
            let _ = self.tx.send(HookEvent::Key(describe(&tracker, ev)));
        }
        drop(table);
        drop(tracker);
        if d.kill {
            let _ = self.tx.send(HookEvent::Kill);
        }
        if let Some((owner, id)) = d.fire {
            let _ = self.tx.send(HookEvent::Fire { owner, id });
        }
        d.consume
    }
}

fn mod_name(bit: u8) -> &'static str {
    match bit {
        chord::CTRL => "ctrl",
        chord::ALT => "alt",
        chord::SHIFT => "shift",
        _ => "meta",
    }
}

/// Text for `--print-keys`, e.g. `ctrl+alt+k`, `f6`, `shift`.
pub fn describe(t: &Tracker, ev: KeyEvent) -> String {
    match ev.kind {
        Kind::Key(key) => Chord { mods: t.mods(), key }.to_string(),
        Kind::Mod(bit) => mod_name(bit).to_string(),
        Kind::Other => format!("key:{}", ev.code),
    }
}

/// Native code for a key/modifier name (for releasing worker-reported keys).
pub fn code_for_name(name: &str) -> Option<u32> {
    let n = name.trim().to_ascii_lowercase();
    if let Some(bit) = chord::parse_modifier(&n, cfg!(target_os = "macos")) {
        if n != "mod" {
            return Some(os::mod_code(bit));
        }
    }
    match n.as_str() {
        "lctrl" | "rctrl" => return Some(os::mod_code(chord::CTRL)),
        "lalt" | "ralt" => return Some(os::mod_code(chord::ALT)),
        "lshift" | "rshift" => return Some(os::mod_code(chord::SHIFT)),
        _ => {}
    }
    Key::parse(&n).and_then(os::code_for_key)
}

/// Start the hook thread. Returns Err with a human-readable reason if the
/// hook could not be armed (no permission, unsupported OS).
pub fn start(ctx: HookCtx) -> Result<(), String> {
    os::start(ctx)
}
