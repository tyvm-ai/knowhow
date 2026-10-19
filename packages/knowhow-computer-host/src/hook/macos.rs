//! macOS hook: a default (non-listen-only) CGEventTap on the session, added to
//! a CFRunLoop on a dedicated thread. Raw FFI for tap creation so the callback
//! can return NULL (= consume), which the `core-graphics` wrapper can't do.

use super::{HookCtx, INJECT_MARKER};
use crate::chord::{self, Key};
use crate::hotkeys::{KeyEvent, Kind};
use core_foundation::base::TCFType;
use core_foundation::mach_port::{CFMachPort, CFMachPortRef};
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, Ordering};

const SESSION_TAP: u32 = 1; // kCGSessionEventTap
const HEAD_INSERT: u32 = 0; // kCGHeadInsertEventTap
const OPT_DEFAULT: u32 = 0; // active filter (not listen-only)
const KEY_DOWN: u32 = 10;
const KEY_UP: u32 = 11;
const FLAGS_CHANGED: u32 = 12;
const TAP_DISABLED_TIMEOUT: u32 = 0xFFFF_FFFE;
const TAP_DISABLED_USER: u32 = 0xFFFF_FFFF;
const F_KEYCODE: u32 = 9; // kCGKeyboardEventKeycode
const F_AUTOREPEAT: u32 = 8; // kCGKeyboardEventAutorepeat
const F_USER_DATA: u32 = 42; // kCGEventSourceUserData

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: u64,
        callback: extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetIntegerValueField(event: *mut c_void, field: u32) -> i64;
    fn CGEventGetFlags(event: *mut c_void) -> u64;
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
}

static TAP_PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

/// Non-character keys: (key, mac virtual keycode, ANSI layout).
const NAMED: &[(Key, u32)] = &[
    (Key::Esc, 0x35),
    (Key::Enter, 0x24),
    (Key::Space, 0x31),
    (Key::Tab, 0x30),
    (Key::Backspace, 0x33),
    (Key::Delete, 0x75),
    (Key::Insert, 0x72),
    (Key::Left, 0x7B),
    (Key::Right, 0x7C),
    (Key::Down, 0x7D),
    (Key::Up, 0x7E),
    (Key::Home, 0x73),
    (Key::End, 0x77),
    (Key::PageUp, 0x74),
    (Key::PageDown, 0x79),
    (Key::F(1), 0x7A),
    (Key::F(2), 0x78),
    (Key::F(3), 0x63),
    (Key::F(4), 0x76),
    (Key::F(5), 0x60),
    (Key::F(6), 0x61),
    (Key::F(7), 0x62),
    (Key::F(8), 0x64),
    (Key::F(9), 0x65),
    (Key::F(10), 0x6D),
    (Key::F(11), 0x67),
    (Key::F(12), 0x6F),
    (Key::F(13), 0x69),
    (Key::F(14), 0x6B),
    (Key::F(15), 0x71),
    (Key::F(16), 0x6A),
    (Key::F(17), 0x40),
    (Key::F(18), 0x4F),
    (Key::F(19), 0x50),
    (Key::F(20), 0x5A),
];

const CHARS: &[(char, u32)] = &[
    ('a', 0x00), ('s', 0x01), ('d', 0x02), ('f', 0x03), ('h', 0x04), ('g', 0x05),
    ('z', 0x06), ('x', 0x07), ('c', 0x08), ('v', 0x09), ('b', 0x0B), ('q', 0x0C),
    ('w', 0x0D), ('e', 0x0E), ('r', 0x0F), ('y', 0x10), ('t', 0x11), ('1', 0x12),
    ('2', 0x13), ('3', 0x14), ('4', 0x15), ('6', 0x16), ('5', 0x17), ('9', 0x19),
    ('7', 0x1A), ('8', 0x1C), ('0', 0x1D), ('o', 0x1F), ('u', 0x20), ('i', 0x22),
    ('p', 0x23), ('l', 0x25), ('j', 0x26), ('k', 0x28), ('n', 0x2D), ('m', 0x2E),
];

/// (modifier bit, left keycode, right keycode, CGEventFlags mask)
const MODS: &[(u8, u32, u32, u64)] = &[
    (chord::CTRL, 0x3B, 0x3E, 0x0004_0000),
    (chord::ALT, 0x3A, 0x3D, 0x0008_0000),
    (chord::SHIFT, 0x38, 0x3C, 0x0002_0000),
    (chord::META, 0x37, 0x36, 0x0010_0000),
];

pub fn classify(code: u32) -> Kind {
    for (bit, l, r, _) in MODS {
        if code == *l || code == *r {
            return Kind::Mod(*bit);
        }
    }
    for (k, c) in NAMED {
        if *c == code {
            return Kind::Key(*k);
        }
    }
    for (ch, c) in CHARS {
        if *c == code {
            return Kind::Key(Key::Char(*ch));
        }
    }
    Kind::Other
}

pub fn code_for_key(key: Key) -> Option<u32> {
    match key {
        Key::Char(ch) => CHARS.iter().find(|(c, _)| *c == ch).map(|(_, v)| *v),
        k => NAMED.iter().find(|(n, _)| *n == k).map(|(_, v)| *v),
    }
}

pub fn mod_code(bit: u8) -> u32 {
    MODS.iter().find(|m| m.0 == bit).map(|m| m.1).unwrap_or(0)
}

fn mod_mask(bit: u8) -> u64 {
    MODS.iter().find(|m| m.0 == bit).map(|m| m.3).unwrap_or(0)
}


extern "C" fn tap_callback(
    _proxy: *mut c_void,
    etype: u32,
    event: *mut c_void,
    user_info: *mut c_void,
) -> *mut c_void {
    if etype == TAP_DISABLED_TIMEOUT || etype == TAP_DISABLED_USER {
        // The system disabled the tap (callback too slow / user input): re-enable.
        let port = TAP_PORT.load(Ordering::SeqCst);
        if !port.is_null() {
            unsafe { CGEventTapEnable(port as CFMachPortRef, true) };
        }
        return event;
    }
    if etype != KEY_DOWN && etype != KEY_UP && etype != FLAGS_CHANGED {
        return event;
    }
    let ctx = unsafe { &*(user_info as *const HookCtx) };
    unsafe {
        // Our own injected input is tagged: never track or match it.
        if CGEventGetIntegerValueField(event, F_USER_DATA) == INJECT_MARKER as i64 {
            return event;
        }
        let code = CGEventGetIntegerValueField(event, F_KEYCODE) as u32;
        let kind = classify(code);
        let down = match etype {
            KEY_DOWN => true,
            KEY_UP => false,
            _ => match kind {
                Kind::Mod(bit) => CGEventGetFlags(event) & mod_mask(bit) != 0,
                // caps lock etc.: treat as a toggle, ignore for matching
                _ => return event,
            },
        };
        let _ = F_AUTOREPEAT; // repeat is detected by the tracker (key already down)
        if ctx.handle(KeyEvent { code, down, kind }) {
            std::ptr::null_mut() // consume
        } else {
            event
        }
    }
}

pub fn start(ctx: HookCtx) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("kh-hook".into())
        .spawn(move || {
            // The ctx lives for the life of the process.
            let ctx_ptr = Box::into_raw(Box::new(ctx)) as *mut c_void;
            let mask: u64 = (1 << KEY_DOWN) | (1 << KEY_UP) | (1 << FLAGS_CHANGED);
            let port_ref = unsafe {
                CGEventTapCreate(SESSION_TAP, HEAD_INSERT, OPT_DEFAULT, mask, tap_callback, ctx_ptr)
            };
            if port_ref.is_null() {
                let _ = tx.send(Err(
                    "CGEventTapCreate failed: grant Accessibility and Input Monitoring to this \
                     binary (or the terminal running it) in System Settings → Privacy & Security, \
                     then restart the host"
                        .into(),
                ));
                return;
            }
            let port = unsafe { CFMachPort::wrap_under_create_rule(port_ref) };
            TAP_PORT.store(port_ref as *mut c_void, Ordering::SeqCst);
            let source = match port.create_runloop_source(0) {
                Ok(s) => s,
                Err(()) => {
                    let _ = tx.send(Err("failed to create run loop source for event tap".into()));
                    return;
                }
            };
            let rl = CFRunLoop::get_current();
            rl.add_source(&source, unsafe { kCFRunLoopCommonModes });
            unsafe { CGEventTapEnable(port_ref, true) };
            let _ = tx.send(Ok(()));
            CFRunLoop::run_current();
        })
        .map_err(|e| format!("spawn hook thread: {e}"))?;
    rx.recv().map_err(|_| "hook thread died during startup".to_string())?
}

/// Inject key-up for every `codes` entry, all modifiers, and any mouse
/// button still down. Tagged with INJECT_MARKER so our hook ignores it.
pub fn release_input(codes: &[u32]) {
    let source = match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
        Ok(s) => s,
        Err(()) => return,
    };
    let mut all: Vec<u32> = codes.to_vec();
    for (_, l, r, _) in MODS {
        all.push(*l);
        all.push(*r);
    }
    all.sort_unstable();
    all.dedup();
    for code in all {
        if let Ok(ev) = CGEvent::new_keyboard_event(source.clone(), code as u16, false) {
            ev.set_flags(CGEventFlags::CGEventFlagNull);
            ev.set_integer_value_field(core_graphics::event::EventField::EVENT_SOURCE_USER_DATA, INJECT_MARKER as i64);
            ev.post(CGEventTapLocation::HID);
        }
    }
    let pos = CGEvent::new(source.clone()).map(|e| e.location()).ok();
    if let Some(pos) = pos {
        let buttons = [
            (0u32, CGEventType::LeftMouseUp, CGMouseButton::Left),
            (1, CGEventType::RightMouseUp, CGMouseButton::Right),
            (2, CGEventType::OtherMouseUp, CGMouseButton::Center),
        ];
        for (idx, up, btn) in buttons {
            if unsafe { CGEventSourceButtonState(1, idx) } {
                if let Ok(ev) = CGEvent::new_mouse_event(source.clone(), up, pos, btn) {
                    ev.set_integer_value_field(
                        core_graphics::event::EventField::EVENT_SOURCE_USER_DATA,
                        INJECT_MARKER as i64,
                    );
                    ev.post(CGEventTapLocation::HID);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keycode_roundtrip() {
        assert_eq!(classify(0x35), Kind::Key(Key::Esc));
        assert_eq!(classify(0x3B), Kind::Mod(chord::CTRL));
        assert_eq!(classify(0x3D), Kind::Mod(chord::ALT));
        assert_eq!(classify(0x00), Kind::Key(Key::Char('a')));
        for (k, c) in NAMED {
            assert_eq!(code_for_key(*k), Some(*c));
            assert_eq!(classify(*c), Kind::Key(*k));
        }
        for (ch, c) in CHARS {
            assert_eq!(classify(*c), Kind::Key(Key::Char(*ch)));
        }
        assert_eq!(super::super::code_for_name("ctrl"), Some(0x3B));
        assert_eq!(super::super::code_for_name("esc"), Some(0x35));
    }
}
