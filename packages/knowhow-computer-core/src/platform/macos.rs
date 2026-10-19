//! macOS backend: synthetic input via CoreGraphics `CGEvent`, screen capture via
//! `screencapture` CLI (ScreenCaptureKit-backed on macOS 14+/26). Requires the
//! host process to hold the Accessibility (input) and Screen Recording (capture)
//! TCC permissions; we report those in `permissions_status()`.

#![cfg(target_os = "macos")]

use core_graphics::display::{CGDisplay, CGPoint};
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton, EventField, ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use std::process::Command as StdCommand;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;

use napi::{Error, Result, Status};

extern "C" {
    /// Returns true if the current process already has Screen Recording permission
    /// in the TCC database — does NOT prompt and does NOT perform a capture.
    /// Available on macOS 10.15+.
    fn CGPreflightScreenCaptureAccess() -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    /// Copy info about on-screen windows. Returns a CFArray of CFDictionary, in
    /// front-to-back z-order when `kCGWindowListOptionOnScreenOnly` is used.
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    /// `stateID`: 0 = CombinedSessionState, 1 = HIDSystemState.
    fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
    /// Returns the CGEventFlags bitmask for the given source state.
    fn CGEventSourceFlagsState(state_id: i32) -> u64;
}

extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffersize: u32) -> i32;
}

// Helpers implemented in macos_native.m (AppKit).
extern "C" {
    fn kh_clipboard_get_text() -> *mut std::ffi::c_char;
    fn kh_clipboard_set_text(text: *const std::ffi::c_char) -> i32;
    fn kh_clipboard_change_count() -> i64;
    fn kh_beep();
    fn kh_bundle_id_for_pid(pid: i32) -> *mut std::ffi::c_char;
    fn kh_bundle_id_for_exe_path(path: *const std::ffi::c_char) -> *mut std::ffi::c_char;
    fn kh_free_string(p: *mut std::ffi::c_char);
}

const STATE_COMBINED_SESSION: i32 = 0;
const STATE_HID_SYSTEM: i32 = 1;
const FLAG_CAPS_LOCK: u64 = 0x0001_0000;
const FLAG_SHIFT: u64 = 0x0002_0000;
const FLAG_CONTROL: u64 = 0x0004_0000;
const FLAG_ALT: u64 = 0x0008_0000;
const FLAG_COMMAND: u64 = 0x0010_0000;

/// Marker written to kCGEventSourceUserData (field 42) on every injected event
/// ("KNOW"); the host's global hook ignores events carrying it. Mirrors the
/// Windows backend's `INJECT_TAG` (dwExtraInfo).
const INJECT_MARKER: i64 = 0x4B4E_4F57;

/// Process-wide modifier state (CGEventFlags bits) maintained by `key()` and
/// `hotkey()`. Applied explicitly to every injected event, because on macOS 26
/// the HIDSystemState source no longer propagates synthetic modifier-down
/// state onto subsequent events.
static MOD_FLAGS: AtomicU64 = AtomicU64::new(0);

/// CGEventFlags mask for a modifier key (0 for non-modifiers).
fn modifier_mask(key: Key) -> u64 {
    match key {
        Key::Shift => FLAG_SHIFT,
        Key::Control => FLAG_CONTROL,
        Key::Alt => FLAG_ALT,
        Key::Meta => FLAG_COMMAND,
        _ => 0,
    }
}

/// Pure bookkeeping: new modifier state after `key` goes down/up.
fn apply_modifier(state: u64, key: Key, down: bool) -> u64 {
    let m = modifier_mask(key);
    if down { state | m } else { state & !m }
}

/// Stamp an event with the explicit modifier flags and the injection marker.
fn stamp_with(evt: &CGEvent, flags: u64) {
    evt.set_flags(CGEventFlags::from_bits_truncate(flags));
    evt.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, INJECT_MARKER);
}

fn stamp(evt: &CGEvent) {
    stamp_with(evt, MOD_FLAGS.load(Ordering::SeqCst));
}

/// Full executable path for `pid` via proc_pidpath.
fn exe_path_for_pid(pid: i32) -> Option<String> {
    let mut buf = vec![0u8; 4096];
    let n = unsafe { proc_pidpath(pid, buf.as_mut_ptr() as *mut std::ffi::c_void, buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    Some(String::from_utf8_lossy(&buf).to_string())
}

/// Basename of an executable path.
fn exe_basename(path: &str) -> Option<String> {
    path.rsplit('/').next().map(|s| s.to_string()).filter(|s| !s.is_empty())
}

fn take_c_string(p: *mut std::ffi::c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    unsafe {
        let s = std::ffi::CStr::from_ptr(p).to_string_lossy().to_string();
        kh_free_string(p);
        Some(s)
    }
}

/// Bundle id via NSRunningApplication, falling back to the enclosing .app
/// bundle of the executable path.
fn bundle_id_for_pid(pid: i32, exe_path: Option<&str>) -> Option<String> {
    if let Some(id) = take_c_string(unsafe { kh_bundle_id_for_pid(pid) }) {
        return Some(id);
    }
    let path = std::ffi::CString::new(exe_path?).ok()?;
    take_c_string(unsafe { kh_bundle_id_for_exe_path(path.as_ptr()) })
}

// kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
const K_CG_NULL_WINDOW_ID: u32 = 0;

use crate::backend::Backend;
use crate::keys::Key;
use crate::types::*;

static CAPTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct MacBackend;

impl MacBackend {
    pub fn new() -> Self {
        MacBackend
    }

    fn source() -> Result<CGEventSource> {
        // HIDSystemState is required for Chrome's native select/date controls.
        // Modifier safety is provided by hotkey(): one shared source, reverse-order
        // releases, and a post-release delivery delay before the call returns.
        CGEventSource::new(CGEventSourceStateID::HIDSystemState)
            .map_err(|_| Error::new(Status::GenericFailure, "Failed to create CGEventSource"))
    }

    fn current_point() -> Result<CGPoint> {
        // Read the current cursor location via a null-move event's location.
        let source = Self::source()?;
        let evt = CGEvent::new(source)
            .map_err(|_| Error::new(Status::GenericFailure, "Failed to create CGEvent"))?;
        Ok(evt.location())
    }

    fn post(evt: CGEvent) {
        evt.post(CGEventTapLocation::HID);
    }

    fn post_keyboard(evt: CGEvent) {
        // Chrome's native controls ignore some Session-tap events. HID delivery is
        // required for select navigation and segmented date inputs.
        evt.post(CGEventTapLocation::HID);
    }

    fn mouse_event(&self, kind: CGEventType, point: CGPoint, button: CGMouseButton) -> Result<()> {
        let source = Self::source()?;
        let evt = CGEvent::new_mouse_event(source, kind, point, button)
            .map_err(|_| Error::new(Status::GenericFailure, "Failed to create mouse event"))?;
        stamp(&evt);
        Self::post(evt);
        Ok(())
    }
}

fn cg_button(b: Button) -> CGMouseButton {
    match b {
        Button::Left => CGMouseButton::Left,
        Button::Right => CGMouseButton::Right,
        Button::Middle => CGMouseButton::Center,
    }
}

fn down_kind(b: Button) -> CGEventType {
    match b {
        Button::Left => CGEventType::LeftMouseDown,
        Button::Right => CGEventType::RightMouseDown,
        Button::Middle => CGEventType::OtherMouseDown,
    }
}

fn up_kind(b: Button) -> CGEventType {
    match b {
        Button::Left => CGEventType::LeftMouseUp,
        Button::Right => CGEventType::RightMouseUp,
        Button::Middle => CGEventType::OtherMouseUp,
    }
}

impl Backend for MacBackend {
    fn capabilities(&self) -> Capabilities {
        let p = self.permissions_status();
        Capabilities {
            input: p.input_ok,
            capture: p.capture_ok,
            windows: true,
            clipboard: Some(true),
            key_state: Some(true),
            reason: p.fix.clone(),
        }
    }

    fn permissions_status(&self) -> PermissionsStatus {
        // Use CGPreflightScreenCaptureAccess() — a non-side-effectful TCC query that
        // does NOT perform a capture and does NOT trigger a permission prompt.
        // NOTE: CGDisplayCreateImage() can HANG on modern macOS when permission is
        // denied, so we must NOT call it here. The preflight is the safe check.
        let capture_ok = unsafe { CGPreflightScreenCaptureAccess() };
        // We can't cheaply probe Accessibility without side effects here; treat the
        // ability to build an event source as a best-effort input signal. A more
        // precise AXIsProcessTrusted probe can be added later.
        let input_ok = Self::source().is_ok();

        let mut fixes: Vec<&str> = Vec::new();
        if !input_ok {
            fixes.push("Grant Accessibility: System Settings > Privacy & Security > Accessibility");
        }
        if !capture_ok {
            fixes.push(
                "Grant Screen Recording: System Settings > Privacy & Security > Screen Recording",
            );
        }
        PermissionsStatus {
            platform: "macos".to_string(),
            input_ok,
            capture_ok,
            fix: if fixes.is_empty() {
                None
            } else {
                Some(fixes.join("; "))
            },
        }
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        list_windows_cg()
    }

    fn active_window(&self) -> Result<Option<WindowInfo>> {
        Ok(list_windows_cg()?.into_iter().find(|w| w.active))
    }

    fn key_state(&self, key: Key, physical: bool) -> Result<bool> {
        let state = if physical {
            STATE_HID_SYSTEM
        } else {
            STATE_COMBINED_SESSION
        };
        let flag = match key {
            Key::Shift => Some(FLAG_SHIFT),
            Key::Control => Some(FLAG_CONTROL),
            Key::Alt => Some(FLAG_ALT),
            Key::Meta => Some(FLAG_COMMAND),
            Key::CapsLock => Some(FLAG_CAPS_LOCK),
            _ => None,
        };
        if let Some(mask) = flag {
            // Modifier flags cover both left and right keys; KeyState only
            // reports the single keycode we map to.
            let flags = unsafe { CGEventSourceFlagsState(state) };
            if flags & mask != 0 {
                return Ok(true);
            }
        }
        let code = keycode(key).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("Unsupported key on macOS: {key:?}"),
            )
        })?;
        Ok(unsafe { CGEventSourceKeyState(state, code) })
    }

    fn clipboard_get_text(&self) -> Result<Option<String>> {
        unsafe {
            let p = kh_clipboard_get_text();
            if p.is_null() {
                return Ok(None);
            }
            let s = std::ffi::CStr::from_ptr(p).to_string_lossy().to_string();
            kh_free_string(p);
            Ok(Some(s))
        }
    }

    fn clipboard_set_text(&self, text: &str) -> Result<()> {
        let c = std::ffi::CString::new(text).map_err(|_| {
            Error::new(Status::InvalidArg, "clipboard text contains a NUL byte")
        })?;
        let ok = unsafe { kh_clipboard_set_text(c.as_ptr()) };
        if ok == 1 {
            Ok(())
        } else {
            Err(Error::new(
                Status::GenericFailure,
                "failed to write text to the clipboard",
            ))
        }
    }

    fn clipboard_change_count(&self) -> Result<i64> {
        Ok(unsafe { kh_clipboard_change_count() })
    }

    fn beep(&self, _freq: u32, _ms: u32) -> Result<()> {
        unsafe { kh_beep() };
        Ok(())
    }

    fn get_displays(&self) -> Result<Vec<Display>> {
        let ids = CGDisplay::active_displays()
            .map_err(|_| Error::new(Status::GenericFailure, "Failed to list displays"))?;
        let main_id = CGDisplay::main().id;
        let mut out = Vec::new();
        for id in ids {
            let d = CGDisplay::new(id);
            let b = d.bounds();
            let px_wide = d.pixels_wide() as f64;
            let logical_wide = b.size.width.max(1.0);
            let scale = (px_wide / logical_wide).max(1.0);
            out.push(Display {
                id: id as f64,
                x: b.origin.x,
                y: b.origin.y,
                width: b.size.width,
                height: b.size.height,
                scale_factor: scale,
                primary: id == main_id,
            });
        }
        Ok(out)
    }

    fn screen_size(&self) -> Result<Size> {
        let d = CGDisplay::main();
        let b = d.bounds();
        Ok(Size {
            width: b.size.width,
            height: b.size.height,
        })
    }

    fn screenshot(&self, opts: &ScreenshotOptions) -> Result<(u32, u32, Vec<u8>)> {
        // `screencapture` uses ScreenCaptureKit on current macOS and observes the
        // terminal's Screen Recording grant. Capture bounded regions at the source.
        let started = Instant::now();
        let sequence = CAPTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let tmp_path = format!("/tmp/knowhow_sc_{}_{}.png", std::process::id(), sequence);
        let mut args = vec!["-x".to_string(), "-t".to_string(), "png".to_string()];

        if let Some(region) = opts.region {
            if !region.x.is_finite()
                || !region.y.is_finite()
                || !region.width.is_finite()
                || !region.height.is_finite()
                || region.width <= 0.0
                || region.height <= 0.0
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    "capture region must be finite and non-empty",
                ));
            }
            args.push("-R".to_string());
            args.push(format!(
                "{},{},{},{}",
                region.x.round(),
                region.y.round(),
                region.width.round(),
                region.height.round()
            ));
        } else if let Some(display_id) = opts.display_id {
            let ids = CGDisplay::active_displays().unwrap_or_default();
            if let Some(pos) = ids.iter().position(|&id| id == display_id as u32) {
                args.push("-D".to_string());
                args.push((pos + 1).to_string());
            }
        }

        args.push(tmp_path.clone());
        let status = StdCommand::new("/usr/sbin/screencapture")
            .args(&args)
            .status()
            .map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("screencapture launch failed: {e}"),
                )
            })?;
        if !status.success() {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(Error::new(
        Status::GenericFailure,
        "screencapture failed — grant Screen Recording permission to your terminal (System Settings → Privacy & Security → Screen Recording)",
      ));
        }
        let captured_at = Instant::now();

        let png_bytes = std::fs::read(&tmp_path).map_err(|e| {
            Error::new(
                Status::GenericFailure,
                format!("failed to read screenshot file: {e}"),
            )
        })?;
        let _ = std::fs::remove_file(&tmp_path);
        let img = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
            .map_err(|e| {
                Error::new(
                    Status::GenericFailure,
                    format!("failed to decode screenshot PNG: {e}"),
                )
            })?;
        let mut rgba_img = img.into_rgba8();
        let decoded_at = Instant::now();

        let scale = opts.scale.unwrap_or(1.0);
        if !scale.is_finite() || scale <= 0.0 || scale > 1.0 {
            return Err(Error::new(
                Status::InvalidArg,
                "capture scale must be finite and in (0, 1]",
            ));
        }
        if scale < 1.0 {
            let width = ((rgba_img.width() as f64 * scale).round() as u32).max(1);
            let height = ((rgba_img.height() as f64 * scale).round() as u32).max(1);
            rgba_img = image::imageops::resize(
                &rgba_img,
                width,
                height,
                image::imageops::FilterType::Triangle,
            );
        }
        let width = rgba_img.width();
        let height = rgba_img.height();
        let rgba = rgba_img.into_raw();

        if std::env::var_os("KNOWHOW_COMPUTER_TIMING").is_some() {
            eprintln!(
        "computer.capture region={} capture={:.1}ms decode={:.1}ms resize={:.1}ms total={:.1}ms output={}x{}",
        opts.region.is_some(),
        captured_at.duration_since(started).as_secs_f64() * 1000.0,
        decoded_at.duration_since(captured_at).as_secs_f64() * 1000.0,
        decoded_at.elapsed().as_secs_f64() * 1000.0,
        started.elapsed().as_secs_f64() * 1000.0,
        width,
        height
      );
        }
        Ok((width, height, rgba))
    }

    fn pixel_color(&self, p: Point) -> Result<String> {
        let options = ScreenshotOptions::default();
        let (w, _h, data) = self.screenshot(&options)?;
        let d = CGDisplay::main();
        let logical_w = d.bounds().size.width.max(1.0);
        let physical_w = d.pixels_wide() as f64;
        let scale = (physical_w / logical_w).max(1.0);
        let x = (p.x.max(0.0) * scale).round() as usize;
        let y = (p.y.max(0.0) * scale).round() as usize;
        let idx = (y * w as usize + x) * 4;
        if idx + 2 >= data.len() {
            return Err(Error::new(Status::InvalidArg, "pixel out of bounds"));
        }
        Ok(format!(
            "#{:02X}{:02X}{:02X}",
            data[idx],
            data[idx + 1],
            data[idx + 2]
        ))
    }

    fn mouse_position(&self) -> Result<Point> {
        let p = Self::current_point()?;
        Ok(Point { x: p.x, y: p.y })
    }

    fn move_mouse(&self, p: Point) -> Result<()> {
        let point = CGPoint::new(p.x, p.y);
        // Warp the visible cursor to the target so the on-screen pointer actually
        // moves (posting a MouseMoved event alone does not reposition the cursor).
        CGDisplay::warp_mouse_cursor_position(point)
            .map_err(|e| Error::new(Status::GenericFailure, format!("warp cursor failed: {e}")))?;
        // Re-associate so subsequent hardware movement isn't decoupled after a warp.
        let _ = CGDisplay::associate_mouse_and_mouse_cursor_position(true);
        // Also post a MouseMoved event so apps observing the event stream see it.
        self.mouse_event(CGEventType::MouseMoved, point, CGMouseButton::Left)
    }

    fn mouse_button(&self, button: Button, down: bool) -> Result<()> {
        let point = Self::current_point()?;
        let kind = if down {
            down_kind(button)
        } else {
            up_kind(button)
        };
        self.mouse_event(kind, point, cg_button(button))
    }

    fn scroll(&self, dx: f64, dy: f64) -> Result<()> {
        let source = Self::source()?;
        let evt =
            CGEvent::new_scroll_event(source, ScrollEventUnit::LINE, 2, dy as i32, dx as i32, 0)
                .map_err(|_| Error::new(Status::GenericFailure, "Failed to create scroll event"))?;
        stamp(&evt);
        Self::post(evt);
        Ok(())
    }

    fn type_text(&self, text: &str) -> Result<()> {
        // Use unicode string injection so we don't need a per-character keycode map.
        for ch in text.chars() {
            let source = Self::source()?;
            let down = CGEvent::new_keyboard_event(source, 0, true)
                .map_err(|_| Error::new(Status::GenericFailure, "keydown event"))?;
            let buf: Vec<u16> = ch.to_string().encode_utf16().collect();
            down.set_string_from_utf16_unchecked(&buf);
            stamp(&down);
            Self::post_keyboard(down);

            let source_up = Self::source()?;
            let up = CGEvent::new_keyboard_event(source_up, 0, false)
                .map_err(|_| Error::new(Status::GenericFailure, "keyup event"))?;
            up.set_string_from_utf16_unchecked(&buf);
            stamp(&up);
            Self::post_keyboard(up);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
        Ok(())
    }

    fn key(&self, key: Key, down: bool) -> Result<()> {
        let code = keycode(key).ok_or_else(|| {
            Error::new(
                Status::InvalidArg,
                format!("Unsupported key on macOS: {key:?}"),
            )
        })?;
        let source = Self::source()?;
        let evt = CGEvent::new_keyboard_event(source, code, down)
            .map_err(|_| Error::new(Status::GenericFailure, "keyboard event"))?;
        // Update the process-wide modifier state first so a modifier event
        // carries the *new* state (down: includes it; up: excludes it).
        if modifier_mask(key) != 0 {
            let old = MOD_FLAGS.load(Ordering::SeqCst);
            MOD_FLAGS.store(apply_modifier(old, key, down), Ordering::SeqCst);
        }
        stamp(&evt);
        Self::post_keyboard(evt);
        Ok(())
    }

    fn hotkey(&self, keys: &[Key]) -> Result<()> {
        // All events in a chord must share one event source so its modifier state
        // is visible to the non-modifier key without leaking into later text.
        let source = Self::source()?;
        let initial = MOD_FLAGS.load(Ordering::SeqCst);
        let mut state = initial;
        for key in keys {
            let code = keycode(*key).ok_or_else(|| {
                Error::new(
                    Status::InvalidArg,
                    format!("Unsupported key on macOS: {key:?}"),
                )
            })?;
            state = apply_modifier(state, *key, true);
            MOD_FLAGS.store(state, Ordering::SeqCst);
            let evt = CGEvent::new_keyboard_event(source.clone(), code, true)
                .map_err(|_| Error::new(Status::GenericFailure, "hotkey keydown event"))?;
            stamp_with(&evt, state);
            Self::post_keyboard(evt);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        for key in keys.iter().rev() {
            let code = keycode(*key).expect("key was validated during keydown");
            let m = modifier_mask(*key);
            // Releasing a modifier restores its pre-hotkey state (so a modifier
            // already held via key() stays held).
            let flags_for_event = if m != 0 {
                state = (state & !m) | (initial & m);
                state
            } else {
                state
            };
            let evt = CGEvent::new_keyboard_event(source.clone(), code, false)
                .map_err(|_| Error::new(Status::GenericFailure, "hotkey keyup event"))?;
            stamp_with(&evt, flags_for_event);
            Self::post_keyboard(evt);
            MOD_FLAGS.store(state, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        MOD_FLAGS.store(initial, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(20));
        Ok(())
    }
}

/// Map our `Key` vocabulary to macOS virtual keycodes (ANSI layout).
fn keycode(key: Key) -> Option<CGKeyCode> {
    use Key::*;
    let code: u16 = match key {
        // modifiers
        Control => 0x3B,
        Alt => 0x3A,
        Shift => 0x38,
        Meta => 0x37,

        Enter => 0x24,
        Tab => 0x30,
        Space => 0x31,
        Backspace => 0x33,
        Delete => 0x75,
        Escape => 0x35,
        // The Mac "Help" key occupies the Insert position on PC keyboards.
        Insert => 0x72,
        CapsLock => 0x39,

        Left => 0x7B,
        Right => 0x7C,
        Down => 0x7D,
        Up => 0x7E,
        Home => 0x73,
        End => 0x77,
        PageUp => 0x74,
        PageDown => 0x79,

        F(n) => match n {
            1 => 0x7A,
            2 => 0x78,
            3 => 0x63,
            4 => 0x76,
            5 => 0x60,
            6 => 0x61,
            7 => 0x62,
            8 => 0x64,
            9 => 0x65,
            10 => 0x6D,
            11 => 0x67,
            12 => 0x6F,
            13 => 0x69,
            14 => 0x6B,
            15 => 0x71,
            16 => 0x6A,
            17 => 0x40,
            18 => 0x4F,
            19 => 0x50,
            20 => 0x5A,
            // macOS has no virtual keycodes for F21..F24.
            _ => return None,
        },

        Char(c) => return ansi_char_keycode(c),
    };
    Some(code)
}

/// Read a CFString value for `key` out of a window-info CFDictionary.
fn dict_string(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<String> {
    let cf_key = CFString::new(key);
    dict.find(&cf_key)
        .and_then(|val| val.downcast::<CFString>().map(|s| s.to_string()))
}

/// Read an i64 value for `key` out of a window-info CFDictionary.
fn dict_i64(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<i64> {
    let cf_key = CFString::new(key);
    dict.find(&cf_key)
        .and_then(|val| val.downcast::<CFNumber>().and_then(|n| n.to_i64()))
}

/// Read the kCGWindowBounds sub-dictionary ({X,Y,Width,Height}) as a Region.
fn dict_bounds(dict: &CFDictionary<CFString, CFType>) -> Option<Region> {
    let cf_key = CFString::new("kCGWindowBounds");
    let bounds_val = dict.find(&cf_key)?;
    let bounds: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_get_rule(bounds_val.as_CFTypeRef() as CFDictionaryRef) };
    let x = dict_f64(&bounds, "X")?;
    let y = dict_f64(&bounds, "Y")?;
    let w = dict_f64(&bounds, "Width")?;
    let h = dict_f64(&bounds, "Height")?;
    Some(Region {
        x,
        y,
        width: w,
        height: h,
    })
}

fn dict_f64(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<f64> {
    let cf_key = CFString::new(key);
    dict.find(&cf_key)
        .and_then(|val| val.downcast::<CFNumber>().and_then(|n| n.to_f64()))
}

/// Enumerate on-screen application windows using CoreGraphics, front-to-back.
/// The first normal (layer 0) window is flagged `active` — it is the focused
/// window of the frontmost app, so no AppleScript / arbitrary ordering.
/// Owner PID of the frontmost normal (layer 0, ≥100×100) window, via
/// CoreGraphics. Used as a fallback when the Accessibility system-wide
/// element cannot report a focused application.
pub(crate) fn frontmost_window_pid() -> Option<i32> {
    let option = K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS;
    let array_ref = unsafe { CGWindowListCopyWindowInfo(option, K_CG_NULL_WINDOW_ID) };
    if array_ref.is_null() {
        return None;
    }
    let array: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(array_ref) };
    for item in array.iter() {
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(item.as_CFTypeRef() as CFDictionaryRef) };
        if dict_i64(&dict, "kCGWindowLayer").unwrap_or(0) != 0 {
            continue;
        }
        let Some(bounds) = dict_bounds(&dict) else { continue };
        if bounds.width < 100.0 || bounds.height < 100.0 {
            continue;
        }
        if let Some(pid) = dict_i64(&dict, "kCGWindowOwnerPID") {
            if pid > 0 {
                return Some(pid as i32);
            }
        }
    }
    None
}

fn list_windows_cg() -> Result<Vec<WindowInfo>> {
    let option = K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS;
    let array_ref = unsafe { CGWindowListCopyWindowInfo(option, K_CG_NULL_WINDOW_ID) };
    if array_ref.is_null() {
        return Ok(Vec::new());
    }
    // CGWindowListCopyWindowInfo returns a +1 retained CFArray (Copy rule).
    let array: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(array_ref) };

    let mut out: Vec<WindowInfo> = Vec::new();
    // pid -> (exe, bundle id), looked up once per process.
    let mut proc_cache: std::collections::HashMap<i32, (Option<String>, Option<String>)> =
        std::collections::HashMap::new();
    for item in array.iter() {
        // Each item is a CFDictionaryRef.
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(item.as_CFTypeRef() as CFDictionaryRef) };

        let layer = dict_i64(&dict, "kCGWindowLayer").unwrap_or(0);
        // Only surface normal application windows (layer 0). Skip menus, the Dock,
        // status items, wallpaper, etc. which live on non-zero layers.
        if layer != 0 {
            continue;
        }

        let app = dict_string(&dict, "kCGWindowOwnerName").unwrap_or_default();
        let title = dict_string(&dict, "kCGWindowName").unwrap_or_default();
        let id = dict_i64(&dict, "kCGWindowNumber").unwrap_or(0) as u32;
        let bounds = dict_bounds(&dict).unwrap_or(Region {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        });

        // Ignore zero-area/offscreen helper windows.
        if bounds.width < 1.0 || bounds.height < 1.0 {
            continue;
        }

        let pid = dict_i64(&dict, "kCGWindowOwnerPID")
            .filter(|p| *p > 0)
            .map(|p| p as i32);
        let (exe, bundle_id) = match pid {
            Some(p) => proc_cache
                .entry(p)
                .or_insert_with(|| {
                    let path = exe_path_for_pid(p);
                    let exe = path.as_deref().and_then(exe_basename);
                    (exe, bundle_id_for_pid(p, path.as_deref()))
                })
                .clone(),
            None => (None, None),
        };

        out.push(WindowInfo {
            id,
            title,
            app,
            bounds,
            active: false,
            pid: pid.map(|p| p as u32),
            exe,
            bundle_id,
        });
    }

    // Apps such as Chrome expose full-size, untitled layer-0 companion windows
    // alongside their real document windows. They can sit first in z-order and
    // produce an unstable ID after an otherwise successful AXRaise. Suppress an
    // untitled companion when the same owner has a titled document window.
    let owners_with_titled_windows: Vec<String> = out
        .iter()
        .filter(|window| !window.title.trim().is_empty())
        .map(|window| window.app.clone())
        .collect();
    out.retain(|window| {
        !window.title.trim().is_empty()
            || !owners_with_titled_windows
                .iter()
                .any(|owner| owner == &window.app)
    });
    if let Some(front) = out
        .iter_mut()
        .find(|window| window.bounds.width >= 100.0 && window.bounds.height >= 100.0)
    {
        front.active = true;
    }

    Ok(out)
}

/// ANSI keycodes for common characters used in chords (e.g. cmd+c). Letters map
/// case-insensitively; callers add Shift explicitly for uppercase/symbols.
fn ansi_char_keycode(c: char) -> Option<CGKeyCode> {
    let lc = c.to_ascii_lowercase();
    let code: u16 = match lc {
        'a' => 0x00,
        's' => 0x01,
        'd' => 0x02,
        'f' => 0x03,
        'h' => 0x04,
        'g' => 0x05,
        'z' => 0x06,
        'x' => 0x07,
        'c' => 0x08,
        'v' => 0x09,
        'b' => 0x0B,
        'q' => 0x0C,
        'w' => 0x0D,
        'e' => 0x0E,
        'r' => 0x0F,
        'y' => 0x10,
        't' => 0x11,
        '1' => 0x12,
        '2' => 0x13,
        '3' => 0x14,
        '4' => 0x15,
        '6' => 0x16,
        '5' => 0x17,
        '9' => 0x19,
        '7' => 0x1A,
        '8' => 0x1C,
        '0' => 0x1D,
        '=' | '+' => 0x18,
        '-' | '_' => 0x1B,
        ']' | '}' => 0x1E,
        '[' | '{' => 0x21,
        'o' => 0x1F,
        'u' => 0x20,
        'i' => 0x22,
        'p' => 0x23,
        'l' => 0x25,
        'j' => 0x26,
        'k' => 0x28,
        ';' | ':' => 0x29,
        '\\' | '|' => 0x2A,
        ',' | '<' => 0x2B,
        '/' | '?' => 0x2C,
        'n' => 0x2D,
        'm' => 0x2E,
        '.' | '>' => 0x2F,
        '`' | '~' => 0x32,
        '\'' | '"' => 0x27,
        _ => return None,
    };
    Some(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifier_bookkeeping() {
        let s = apply_modifier(0, Key::Meta, true);
        assert_eq!(s, FLAG_COMMAND);
        let s = apply_modifier(s, Key::Alt, true);
        assert_eq!(s, FLAG_COMMAND | FLAG_ALT);
        // non-modifier keys never change state
        assert_eq!(apply_modifier(s, Key::Char('c'), true), s);
        let s = apply_modifier(s, Key::Meta, false);
        assert_eq!(s, FLAG_ALT);
        assert_eq!(modifier_mask(Key::Control), 1 << 18);
        assert_eq!(modifier_mask(Key::Shift), 1 << 17);
        assert_eq!(modifier_mask(Key::Alt), 1 << 19);
        assert_eq!(modifier_mask(Key::Meta), 1 << 20);
    }
}
