//! Pure hotkey matching logic shared by every OS hook. No OS calls in here, so
//! it is unit-tested directly.
//!
//! * `Table` – the hotkey registrations; shared (RwLock) between IPC (writer)
//!   and the hook callback (`try_read`, never blocks).
//! * `Tracker` – per-hook state: which keys / modifiers are down, which
//!   downs were consumed (so the matching up is consumed too).

use crate::chord::{Chord, Key, Mods};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub type WorkerId = String;

#[derive(Clone, Debug)]
pub struct HotkeyReg {
    pub owner: WorkerId,
    pub id: String,
    pub chord: Chord,
    pub any_modifiers: bool,
    pub consume: bool,
    pub no_repeat: bool,
    pub drop_while_busy: bool,
    /// Set by the hook when it fires; cleared by the worker's `hotkeyDone`.
    pub busy: Arc<AtomicBool>,
}

impl HotkeyReg {
    pub fn new(owner: &str, id: &str, chord: Chord) -> Self {
        HotkeyReg {
            owner: owner.to_string(),
            id: id.to_string(),
            chord,
            any_modifiers: false,
            consume: false,
            no_repeat: false,
            drop_while_busy: false,
            busy: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Default)]
pub struct Table {
    pub regs: Vec<HotkeyReg>,
    /// Owners whose hotkeys are suspended (tray "Suspend hotkeys", pause).
    pub suspended: HashSet<WorkerId>,
    /// Kill switch fired and not yet cleared: no hotkeys fire.
    pub halted: AtomicBool,
}

impl Table {
    /// Add or replace (same owner + id) a registration.
    pub fn register(&mut self, reg: HotkeyReg) {
        self.regs.retain(|r| !(r.owner == reg.owner && r.id == reg.id));
        self.regs.push(reg);
    }

    pub fn unregister(&mut self, owner: &str, id: &str) {
        self.regs.retain(|r| !(r.owner == owner && r.id == id));
    }

    pub fn remove_owner(&mut self, owner: &str) {
        self.regs.retain(|r| r.owner != owner);
        self.suspended.remove(owner);
    }

    /// Worker acked completion of a hotkey handler.
    pub fn done(&self, owner: &str, id: &str) {
        for r in &self.regs {
            if r.owner == owner && r.id == id {
                r.busy.store(false, Ordering::SeqCst);
            }
        }
    }

    pub fn count_for(&self, owner: &str) -> usize {
        self.regs.iter().filter(|r| r.owner == owner).count()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Key(Key),
    /// A modifier key; payload is one of `chord::{CTRL,ALT,SHIFT,META}`.
    Mod(u8),
    /// Anything we can't name (caps lock, media keys, ...): tracked, never matched.
    Other,
}

#[derive(Clone, Copy, Debug)]
pub struct KeyEvent {
    /// Native key code (mac virtual keycode / Windows vkCode).
    pub code: u32,
    pub down: bool,
    pub kind: Kind,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Decision {
    pub consume: bool,
    pub fire: Option<(WorkerId, String)>,
    pub kill: bool,
}

pub struct Tracker {
    kill: Chord,
    mod_codes: HashSet<(u8, u32)>,
    keys_down: HashSet<Key>,
    native_down: HashSet<u32>,
    consumed: HashSet<Key>,
}

impl Tracker {
    pub fn new(kill: Chord) -> Self {
        Tracker {
            kill,
            mod_codes: HashSet::new(),
            keys_down: HashSet::new(),
            native_down: HashSet::new(),
            consumed: HashSet::new(),
        }
    }

    pub fn set_kill(&mut self, kill: Chord) {
        self.kill = kill;
    }

    pub fn mods(&self) -> Mods {
        let mut m = Mods::default();
        for (bit, _) in &self.mod_codes {
            m.insert(*bit);
        }
        m
    }

    /// Native codes currently believed to be down (for stuck-key release).
    pub fn held_native(&self) -> Vec<u32> {
        self.native_down.iter().copied().collect()
    }

    /// Forget everything (after a kill-switch release).
    pub fn clear(&mut self) {
        self.mod_codes.clear();
        self.keys_down.clear();
        self.native_down.clear();
        self.consumed.clear();
    }


    /// Process one raw key event. `table == None` means the table was
    /// contended: pass through (the kill switch still works, it lives here).
    pub fn on_event(&mut self, ev: KeyEvent, table: Option<&Table>) -> Decision {
        // Track native state first.
        if ev.down {
            self.native_down.insert(ev.code);
        } else {
            self.native_down.remove(&ev.code);
        }

        match ev.kind {
            Kind::Other => Decision::default(),
            Kind::Mod(bit) => {
                if ev.down {
                    self.mod_codes.insert((bit, ev.code));
                } else {
                    self.mod_codes.remove(&(bit, ev.code));
                }
                Decision::default()
            }
            Kind::Key(key) if !ev.down => {
                self.keys_down.remove(&key);
                Decision {
                    consume: self.consumed.remove(&key),
                    ..Default::default()
                }
            }
            Kind::Key(key) => self.key_down(key, table),
        }
    }

    fn key_down(&mut self, key: Key, table: Option<&Table>) -> Decision {
        let is_repeat = !self.keys_down.insert(key);
        let mods = self.mods();

        // 1. Kill switch: always matched first, always consumed.
        if key == self.kill.key && mods.contains(self.kill.mods) {
            self.consumed.insert(key);
            return Decision {
                consume: true,
                fire: None,
                kill: !is_repeat,
            };
        }

        // 2. Hotkey table.
        let table = match table {
            Some(t) => t,
            None => return Decision::default(),
        };
        if table.halted.load(Ordering::Relaxed) {
            return Decision::default();
        }
        for reg in &table.regs {
            if reg.chord.key != key || table.suspended.contains(&reg.owner) {
                continue;
            }
            let mods_ok = if reg.any_modifiers {
                mods.contains(reg.chord.mods)
            } else {
                mods == reg.chord.mods
            };
            if !mods_ok {
                continue;
            }
            if reg.consume {
                self.consumed.insert(key);
            }
            let mut fire = None;
            if !(is_repeat && reg.no_repeat) {
                if reg.drop_while_busy {
                    // swap == true means a handler is still running: drop.
                    if !reg.busy.swap(true, Ordering::SeqCst) {
                        fire = Some((reg.owner.clone(), reg.id.clone()));
                    }
                } else {
                    fire = Some((reg.owner.clone(), reg.id.clone()));
                }
            }
            return Decision {
                consume: reg.consume,
                fire,
                kill: false,
            };
        }
        Decision::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chord::{ALT, CTRL, SHIFT};

    fn kill() -> Chord {
        Chord::parse_for("ctrl+alt+esc", false).unwrap()
    }
    fn md(bit: u8, code: u32, down: bool) -> KeyEvent {
        KeyEvent { code, down, kind: Kind::Mod(bit) }
    }
    fn kd(k: Key, code: u32, down: bool) -> KeyEvent {
        KeyEvent { code, down, kind: Kind::Key(k) }
    }
    fn reg(id: &str, chord: &str) -> HotkeyReg {
        HotkeyReg::new("w1", id, Chord::parse_for(chord, false).unwrap())
    }

    #[test]
    fn kill_switch_always_consumed_and_fires_once() {
        let mut t = Tracker::new(kill());
        let table = Table::default();
        t.on_event(md(CTRL, 1, true), Some(&table));
        t.on_event(md(ALT, 2, true), Some(&table));
        let d = t.on_event(kd(Key::Esc, 27, true), Some(&table));
        assert!(d.consume && d.kill);
        // auto-repeat: consumed, no second kill
        let d = t.on_event(kd(Key::Esc, 27, true), Some(&table));
        assert!(d.consume && !d.kill);
        // key-up consumed too
        let d = t.on_event(kd(Key::Esc, 27, false), Some(&table));
        assert!(d.consume && !d.kill);
    }

    #[test]
    fn kill_switch_works_without_table_and_beats_hotkeys() {
        let mut t = Tracker::new(kill());
        t.on_event(md(CTRL, 1, true), None);
        t.on_event(md(ALT, 2, true), None);
        let d = t.on_event(kd(Key::Esc, 27, true), None);
        assert!(d.kill && d.consume);

        // A worker trying to claim the same chord never wins.
        let mut t = Tracker::new(kill());
        let mut table = Table::default();
        let mut r = reg("evil", "ctrl+alt+esc");
        r.consume = false;
        table.register(r);
        t.on_event(md(CTRL, 1, true), Some(&table));
        t.on_event(md(ALT, 2, true), Some(&table));
        let d = t.on_event(kd(Key::Esc, 27, true), Some(&table));
        assert!(d.kill && d.consume && d.fire.is_none());
    }

    #[test]
    fn plain_hotkey_fires_and_consume_flag() {
        let mut table = Table::default();
        let mut r = reg("f6", "f6");
        r.consume = true;
        table.register(r);
        table.register(reg("f7", "f7"));
        let mut t = Tracker::new(kill());
        let d = t.on_event(kd(Key::F(6), 117, true), Some(&table));
        assert_eq!(d.fire, Some(("w1".into(), "f6".into())));
        assert!(d.consume && !d.kill);
        assert!(t.on_event(kd(Key::F(6), 117, false), Some(&table)).consume);
        let d = t.on_event(kd(Key::F(7), 118, true), Some(&table));
        assert_eq!(d.fire, Some(("w1".into(), "f7".into())));
        assert!(!d.consume);
        assert!(!t.on_event(kd(Key::F(7), 118, false), Some(&table)).consume);
    }

    #[test]
    fn modifiers_exact_unless_any() {
        let mut table = Table::default();
        table.register(reg("a", "ctrl+a"));
        let mut any = reg("b", "b");
        any.any_modifiers = true;
        table.register(any);
        let mut t = Tracker::new(kill());
        t.on_event(md(CTRL, 1, true), Some(&table));
        t.on_event(md(SHIFT, 3, true), Some(&table));
        // ctrl+shift+a must not match exact ctrl+a
        assert!(t.on_event(kd(Key::Char('a'), 0, true), Some(&table)).fire.is_none());
        // any_modifiers b matches with ctrl+shift held
        assert!(t.on_event(kd(Key::Char('b'), 1, true), Some(&table)).fire.is_some());
        t.on_event(md(SHIFT, 3, false), Some(&table));
        t.on_event(kd(Key::Char('a'), 0, false), Some(&table));
        assert!(t.on_event(kd(Key::Char('a'), 0, true), Some(&table)).fire.is_some());
    }

    #[test]
    fn no_repeat_fires_once_until_keyup() {
        let mut table = Table::default();
        let mut r = reg("x", "f6");
        r.no_repeat = true;
        r.consume = true;
        table.register(r);
        let mut t = Tracker::new(kill());
        let d1 = t.on_event(kd(Key::F(6), 1, true), Some(&table));
        let d2 = t.on_event(kd(Key::F(6), 1, true), Some(&table));
        assert!(d1.fire.is_some());
        assert!(d2.fire.is_none() && d2.consume, "repeat swallowed but not fired");
        t.on_event(kd(Key::F(6), 1, false), Some(&table));
        assert!(t.on_event(kd(Key::F(6), 1, true), Some(&table)).fire.is_some());
    }

    #[test]
    fn repeat_fires_without_no_repeat() {
        let mut table = Table::default();
        table.register(reg("x", "f6"));
        let mut t = Tracker::new(kill());
        assert!(t.on_event(kd(Key::F(6), 1, true), Some(&table)).fire.is_some());
        assert!(t.on_event(kd(Key::F(6), 1, true), Some(&table)).fire.is_some());
    }

    #[test]
    fn drop_while_busy_until_done() {
        let mut table = Table::default();
        let mut r = reg("x", "f6");
        r.drop_while_busy = true;
        r.consume = true;
        table.register(r);
        let mut t = Tracker::new(kill());
        assert!(t.on_event(kd(Key::F(6), 1, true), Some(&table)).fire.is_some());
        t.on_event(kd(Key::F(6), 1, false), Some(&table));
        let d = t.on_event(kd(Key::F(6), 1, true), Some(&table));
        assert!(d.fire.is_none() && d.consume, "busy: swallowed, not fired");
        t.on_event(kd(Key::F(6), 1, false), Some(&table));
        table.done("w1", "x");
        assert!(t.on_event(kd(Key::F(6), 1, true), Some(&table)).fire.is_some());
    }

    #[test]
    fn suspended_halted_and_contention_pass_through() {
        let mut table = Table::default();
        let mut r = reg("x", "f6");
        r.consume = true;
        table.register(r);
        let mut t = Tracker::new(kill());

        table.suspended.insert("w1".into());
        let d = t.on_event(kd(Key::F(6), 1, true), Some(&table));
        assert!(d.fire.is_none() && !d.consume);
        t.on_event(kd(Key::F(6), 1, false), Some(&table));
        table.suspended.clear();

        table.halted.store(true, Ordering::Relaxed);
        let d = t.on_event(kd(Key::F(6), 1, true), Some(&table));
        assert!(d.fire.is_none() && !d.consume);
        t.on_event(kd(Key::F(6), 1, false), Some(&table));
        table.halted.store(false, Ordering::Relaxed);

        let d = t.on_event(kd(Key::F(6), 1, true), None);
        assert_eq!(d, Decision::default());
    }

    #[test]
    fn register_replaces_and_remove_owner() {
        let mut table = Table::default();
        table.register(reg("x", "f6"));
        table.register(reg("x", "f7"));
        assert_eq!(table.regs.len(), 1);
        table.register(HotkeyReg::new("w2", "x", Chord::parse("f8").unwrap()));
        assert_eq!(table.regs.len(), 2);
        table.remove_owner("w1");
        assert_eq!(table.count_for("w1"), 0);
        table.unregister("w2", "x");
        assert!(table.regs.is_empty());
    }

    #[test]
    fn tracks_held_native_codes() {
        let mut t = Tracker::new(kill());
        t.on_event(md(CTRL, 59, true), None);
        t.on_event(kd(Key::Char('a'), 0, true), None);
        let mut h = t.held_native();
        h.sort();
        assert_eq!(h, vec![0, 59]);
        assert!(t.mods().has(CTRL));
        t.on_event(md(CTRL, 59, false), None);
        assert!(t.mods().is_empty());
        t.clear();
        assert!(t.held_native().is_empty());
    }
}
