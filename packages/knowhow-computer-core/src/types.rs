//! Shared, platform-agnostic types exposed across the napi boundary and used by
//! every platform backend. Keeping these in one place means the `Backend` trait
//! and the `#[napi]` surface speak the exact same vocabulary.

use napi_derive::napi;

/// A screen coordinate in virtual-desktop space (top-left origin).
#[napi(object)]
#[derive(Clone, Copy, Debug)]
pub struct Point {
  pub x: f64,
  pub y: f64,
}

/// A width/height pair in pixels.
#[napi(object)]
#[derive(Clone, Copy, Debug)]
pub struct Size {
  pub width: f64,
  pub height: f64,
}

/// A rectangular region in virtual-desktop space.
#[napi(object)]
#[derive(Clone, Copy, Debug)]
pub struct Region {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

/// A window on the desktop. `bounds` is in virtual-desktop coords (top-left
/// origin). `active` is true for the frontmost (focused) window.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct WindowInfo {
  /// Window title (may be empty; the TS layer falls back to `app`).
  pub title: String,
  /// Owning application / process name.
  pub app: String,
  pub bounds: Region,
  /// True for the frontmost window of the frontmost app.
  pub active: bool,
}

/// A single physical/logical display.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct Display {
  pub id: f64,
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  /// HiDPI / Retina scale factor (device pixels per logical pixel).
  pub scale_factor: f64,
  pub primary: bool,
}

/// What this backend can actually do on the current session. The TS layer turns
/// `input == false` / `capture == false` into a doctor hint rather than a crash.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct Capabilities {
  pub input: bool,
  pub capture: bool,
  pub windows: bool,
  /// Human-readable explanation when a capability is unavailable
  /// (e.g. "macOS: Accessibility permission not granted").
  pub reason: Option<String>,
}

/// Structured permission report used by `knowhow computer doctor`.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct PermissionsStatus {
  /// e.g. "macos" | "windows" | "linux-x11" | "linux-wayland"
  pub platform: String,
  /// Can we synthesize input (mouse/keyboard) right now?
  pub input_ok: bool,
  /// Can we capture the screen right now?
  pub capture_ok: bool,
  /// Actionable remediation text when something is not ok.
  pub fix: Option<String>,
}

/// Options for a screen capture. All fields optional; defaults to the full
/// virtual desktop as raw RGBA bytes plus the dimensions needed to decode them.
#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct ScreenshotOptions {
  /// Capture only this region (virtual-desktop coords).
  pub region: Option<Region>,
  /// Capture a single display by id.
  pub display_id: Option<f64>,
}

/// Raw capture result. We return RGBA bytes + dimensions and let the TS layer
/// (via `sharp`) handle PNG/JPEG encoding and scaling, so the native core stays
/// small and we don't bundle an image codec per platform.
#[napi(object)]
pub struct RawImage {
  pub width: u32,
  pub height: u32,
  /// Tightly-packed RGBA8 pixels, row-major, length == width*height*4.
  pub data: napi::bindgen_prelude::Buffer,
}

/// Mouse buttons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
  Left,
  Right,
  Middle,
}

impl Button {
  /// Parse a JS-facing button string. Defaults to Left on unknown input so a
  /// missing/typo'd button never throws in the hot path.
  pub fn parse(s: &str) -> Button {
    match s.to_ascii_lowercase().as_str() {
      "right" => Button::Right,
      "middle" => Button::Middle,
      _ => Button::Left,
    }
  }
}
