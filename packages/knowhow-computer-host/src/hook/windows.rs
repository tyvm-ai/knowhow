//! Windows hook: `WH_KEYBOARD_LL` on a dedicated thread with a `GetMessageW`
//! loop. The callback does no allocation beyond a channel send.

use super::{HookCtx, INJECT_MARKER};
use crate::chord::{self, Key};
use crate::hotkeys::{KeyEvent, Kind};
use ::windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
    HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
};
use std::sync::OnceLock;

static CTX: OnceLock<HookCtx> = OnceLock::new();

const LLKHF_INJECTED: u32 = 0x10;
const WM_KEYDOWN: usize = 0x0100;
const WM_KEYUP: usize = 0x0101;
const WM_SYSKEYDOWN: usize = 0x0104;
const WM_SYSKEYUP: usize = 0x0105;

/// (modifier bit, left vk, right vk)
const MODS: &[(u8, u32, u32)] = &[
    (chord::CTRL, 0xA2, 0xA3),
    (chord::ALT, 0xA4, 0xA5),
    (chord::SHIFT, 0xA0, 0xA1),
    (chord::META, 0x5B, 0x5C),
];

pub fn classify(vk: u32) -> Kind {
    for (bit, l, r) in MODS {
        if vk == *l || vk == *r {
            return Kind::Mod(*bit);
        }
    }
    // generic (non-sided) modifier codes, just in case
    match vk {
        0x11 => return Kind::Mod(chord::CTRL),
        0x12 => return Kind::Mod(chord::ALT),
        0x10 => return Kind::Mod(chord::SHIFT),
        _ => {}
    }
    let key = match vk {
        0x41..=0x5A => Key::Char((b'a' + (vk - 0x41) as u8) as char),
        0x30..=0x39 => Key::Char((b'0' + (vk - 0x30) as u8) as char),
        0x70..=0x87 => Key::F((vk - 0x70 + 1) as u8),
        0x1B => Key::Esc,
        0x0D => Key::Enter,
        0x20 => Key::Space,
        0x09 => Key::Tab,
        0x08 => Key::Backspace,
        0x2E => Key::Delete,
        0x2D => Key::Insert,
        0x25 => Key::Left,
        0x26 => Key::Up,
        0x27 => Key::Right,
        0x28 => Key::Down,
        0x24 => Key::Home,
        0x23 => Key::End,
        0x21 => Key::PageUp,
        0x22 => Key::PageDown,
        _ => return Kind::Other,
    };
    Kind::Key(key)
}

pub fn code_for_key(key: Key) -> Option<u32> {
    Some(match key {
        Key::Char(c) if c.is_ascii_lowercase() => 0x41 + (c as u32 - 'a' as u32),
        Key::Char(c) if c.is_ascii_digit() => 0x30 + (c as u32 - '0' as u32),
        Key::Char(_) => return None,
        Key::F(n) => 0x70 + (n as u32 - 1),
        Key::Esc => 0x1B,
        Key::Enter => 0x0D,
        Key::Space => 0x20,
        Key::Tab => 0x09,
        Key::Backspace => 0x08,
        Key::Delete => 0x2E,
        Key::Insert => 0x2D,
        Key::Left => 0x25,
        Key::Up => 0x26,
        Key::Right => 0x27,
        Key::Down => 0x28,
        Key::Home => 0x24,
        Key::End => 0x23,
        Key::PageUp => 0x21,
        Key::PageDown => 0x22,
    })
}

pub fn mod_code(bit: u8) -> u32 {
    MODS.iter().find(|m| m.0 == bit).map(|m| m.1).unwrap_or(0)
}

fn is_extended(vk: u32) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2D | 0x2E | 0x5B | 0x5C | 0xA3 | 0xA5)
}

unsafe extern "system" fn ll_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == 0 {
        // HC_ACTION
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let injected = kb.flags.0 & LLKHF_INJECTED != 0;
        // Our own injected input: never track or match it.
        if !(injected && kb.dwExtraInfo == INJECT_MARKER as usize) {
            if let Some(ctx) = CTX.get() {
                let down = match wparam.0 {
                    WM_KEYDOWN | WM_SYSKEYDOWN => Some(true),
                    WM_KEYUP | WM_SYSKEYUP => Some(false),
                    _ => None,
                };
                if let Some(down) = down {
                    let vk = kb.vkCode;
                    let ev = KeyEvent { code: vk, down, kind: classify(vk) };
                    if ctx.handle(ev) {
                        return LRESULT(1); // consume
                    }
                }
            }
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

pub fn start(ctx: HookCtx) -> Result<(), String> {
    CTX.set(ctx).map_err(|_| "hook already started".to_string())?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("kh-hook".into())
        .spawn(move || unsafe {
            match SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_proc), None, 0) {
                Ok(_) => {
                    let _ = tx.send(Ok(()));
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("SetWindowsHookExW(WH_KEYBOARD_LL) failed: {e}")));
                    return;
                }
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .map_err(|e| format!("spawn hook thread: {e}"))?;
    rx.recv().map_err(|_| "hook thread died during startup".to_string())?
}

fn key_up(vk: u32) -> INPUT {
    let mut flags = KEYEVENTF_KEYUP;
    if is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk as u16),
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: INJECT_MARKER as usize,
            },
        },
    }
}

fn mouse_up(flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: INJECT_MARKER as usize,
            },
        },
    }
}

/// Inject key-up for `codes` + all modifiers, and mouse-up for any button
/// still physically/logically down. Tagged with INJECT_MARKER.
pub fn release_input(codes: &[u32]) {
    let mut all: Vec<u32> = codes.to_vec();
    for (_, l, r) in MODS {
        all.push(*l);
        all.push(*r);
    }
    all.sort_unstable();
    all.dedup();
    let mut inputs: Vec<INPUT> = all.into_iter().filter(|c| *c != 0).map(key_up).collect();
    for (vk, flag) in [
        (0x01i32, MOUSEEVENTF_LEFTUP),
        (0x02, MOUSEEVENTF_RIGHTUP),
        (0x04, MOUSEEVENTF_MIDDLEUP),
    ] {
        if unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000 != 0 {
            inputs.push(mouse_up(flag));
        }
    }
    if !inputs.is_empty() {
        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
}

#[allow(dead_code)]
fn _unused(_: KEYBD_EVENT_FLAGS) {}
