//! macOS backend: synthetic input via CoreGraphics `CGEvent`, screen capture via
//! `screencapture` CLI (ScreenCaptureKit-backed on macOS 14+/26). Requires the
//! host process to hold the Accessibility (input) and Screen Recording (capture)
//! TCC permissions; we report those in `permissions_status()`.

#![cfg(target_os = "macos")]

use std::process::Command as StdCommand;
use core_graphics::display::{CGDisplay, CGPoint};
use core_graphics::event::{
  CGEvent, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton, ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

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

// kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
const K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY: u32 = 1 << 0;
const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
const K_CG_NULL_WINDOW_ID: u32 = 0;

use crate::backend::Backend;
use crate::keys::Key;
use crate::types::*;

pub struct MacBackend;

impl MacBackend {
  pub fn new() -> Self {
    MacBackend
  }

  fn source() -> Result<CGEventSource> {
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

  fn mouse_event(
    &self,
    kind: CGEventType,
    point: CGPoint,
    button: CGMouseButton,
  ) -> Result<()> {
    let source = Self::source()?;
    let evt = CGEvent::new_mouse_event(source, kind, point, button)
      .map_err(|_| Error::new(Status::GenericFailure, "Failed to create mouse event"))?;
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
      fixes.push(
        "Grant Accessibility: System Settings > Privacy & Security > Accessibility",
      );
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
    // CGDisplayCreateImage() is broken/hangs on macOS 14+ (Sonoma) and macOS 26+
    // when Screen Recording is controlled by ScreenCaptureKit. Use the
    // `screencapture` CLI instead — it is backed by ScreenCaptureKit and works
    // correctly with TCC permissions granted to the terminal.
    let tmp_path = format!("/tmp/knowhow_sc_{}.png", std::process::id());

    let mut args: Vec<String> = vec![
      "-x".to_string(),        // no sound
      "-t".to_string(), "png".to_string(),
    ];

    // Display selection: screencapture -D <display_index> (1-based).
    // CGDisplay active_displays() gives us the list; find the index of our display.
    if let Some(display_id) = opts.display_id {
      let ids = CGDisplay::active_displays()
        .unwrap_or_default();
      if let Some(pos) = ids.iter().position(|&id| id == display_id as u32) {
        args.push("-D".to_string());
        args.push((pos + 1).to_string());
      }
    }

    args.push(tmp_path.clone());

    let status = StdCommand::new("/usr/sbin/screencapture")
      .args(&args)
      .status()
      .map_err(|e| Error::new(Status::GenericFailure, format!("screencapture launch failed: {e}")))?;

    if !status.success() {
      let _ = std::fs::remove_file(&tmp_path);
      return Err(Error::new(
        Status::GenericFailure,
        "screencapture failed — grant Screen Recording permission to your terminal (System Settings → Privacy & Security → Screen Recording)",
      ));
    }

    // Decode the PNG into RGBA via the `image` crate.
    let png_bytes = std::fs::read(&tmp_path)
      .map_err(|e| Error::new(Status::GenericFailure, format!("failed to read screenshot file: {e}")))?;
    let _ = std::fs::remove_file(&tmp_path);

    let img = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
      .map_err(|e| Error::new(Status::GenericFailure, format!("failed to decode screenshot PNG: {e}")))?;

    let rgba_img = img.into_rgba8();
    let width = rgba_img.width();
    let height = rgba_img.height();
    let rgba = rgba_img.into_raw();

    // opts.region cropping is handled by the TS layer (ComputerService via sharp).
    let _ = &opts.region;

    Ok((width, height, rgba))
  }

  fn pixel_color(&self, p: Point) -> Result<String> {
    let region = ScreenshotOptions::default();
    let (w, _h, data) = self.screenshot(&region)?;
    let x = p.x.max(0.0) as usize;
    let y = p.y.max(0.0) as usize;
    let idx = (y * w as usize + x) * 4;
    if idx + 2 >= data.len() {
      return Err(Error::new(Status::InvalidArg, "pixel out of bounds"));
    }
    Ok(format!("#{:02X}{:02X}{:02X}", data[idx], data[idx + 1], data[idx + 2]))
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
    let kind = if down { down_kind(button) } else { up_kind(button) };
    self.mouse_event(kind, point, cg_button(button))
  }

  fn scroll(&self, dx: f64, dy: f64) -> Result<()> {
    let source = Self::source()?;
    let evt = CGEvent::new_scroll_event(
      source,
      ScrollEventUnit::LINE,
      2,
      dy as i32,
      dx as i32,
      0,
    )
    .map_err(|_| Error::new(Status::GenericFailure, "Failed to create scroll event"))?;
    Self::post(evt);
    Ok(())
  }

  fn type_text(&self, text: &str) -> Result<()> {
    // Use unicode string injection so we don't need a per-character keycode map.
    let chars: Vec<u16> = text.encode_utf16().collect();
    for ch in text.chars() {
      let source = Self::source()?;
      let down = CGEvent::new_keyboard_event(source, 0, true)
        .map_err(|_| Error::new(Status::GenericFailure, "keydown event"))?;
      let buf: Vec<u16> = ch.to_string().encode_utf16().collect();
      down.set_string_from_utf16_unchecked(&buf);
      Self::post(down);

      let source_up = Self::source()?;
      let up = CGEvent::new_keyboard_event(source_up, 0, false)
        .map_err(|_| Error::new(Status::GenericFailure, "keyup event"))?;
      up.set_string_from_utf16_unchecked(&buf);
      Self::post(up);
    }
    let _ = chars;
    Ok(())
  }

  fn key(&self, key: Key, down: bool) -> Result<()> {
    let code = keycode(key).ok_or_else(|| {
      Error::new(Status::InvalidArg, format!("Unsupported key on macOS: {key:?}"))
    })?;
    let source = Self::source()?;
    let evt = CGEvent::new_keyboard_event(source, code, down)
      .map_err(|_| Error::new(Status::GenericFailure, "keyboard event"))?;
    Self::post(evt);
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
      _ => return None,
    },

    Char(c) => return ansi_char_keycode(c),
  };
  Some(code)
}

/// Read a CFString value for `key` out of a window-info CFDictionary.
fn dict_string(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<String> {
  let cf_key = CFString::new(key);
  dict.find(&cf_key).and_then(|val| {
    val.downcast::<CFString>().map(|s| s.to_string())
  })
}

/// Read an i64 value for `key` out of a window-info CFDictionary.
fn dict_i64(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<i64> {
  let cf_key = CFString::new(key);
  dict.find(&cf_key).and_then(|val| {
    val.downcast::<CFNumber>().and_then(|n| n.to_i64())
  })
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
  Some(Region { x, y, width: w, height: h })
}

fn dict_f64(dict: &CFDictionary<CFString, CFType>, key: &str) -> Option<f64> {
  let cf_key = CFString::new(key);
  dict.find(&cf_key).and_then(|val| {
    val.downcast::<CFNumber>().and_then(|n| n.to_f64())
  })
}

/// Enumerate on-screen application windows using CoreGraphics, front-to-back.
/// The first normal (layer 0) window is flagged `active` — it is the focused
/// window of the frontmost app, so no AppleScript / arbitrary ordering.
fn list_windows_cg() -> Result<Vec<WindowInfo>> {
  let option =
    K_CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS;
  let array_ref = unsafe { CGWindowListCopyWindowInfo(option, K_CG_NULL_WINDOW_ID) };
  if array_ref.is_null() {
    return Ok(Vec::new());
  }
  // CGWindowListCopyWindowInfo returns a +1 retained CFArray (Copy rule).
  let array: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(array_ref) };

  let mut out: Vec<WindowInfo> = Vec::new();
  let mut active_assigned = false;
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

    let active = !active_assigned;
    if active {
      active_assigned = true;
    }

    out.push(WindowInfo {
      title,
      app,
      bounds,
      active,
    });
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
    'o' => 0x1F,
    'u' => 0x20,
    'i' => 0x22,
    'p' => 0x23,
    'l' => 0x25,
    'j' => 0x26,
    'k' => 0x28,
    'n' => 0x2D,
    'm' => 0x2E,
    _ => return None,
  };
  Some(code)
}
