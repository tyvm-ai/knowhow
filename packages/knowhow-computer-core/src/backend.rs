//! The platform seam, in Rust. Each OS implements `Backend`; `lib.rs` picks the
//! right one at compile time via `#[cfg(target_os = ...)]`. Mirroring the TS
//! `ComputerDriver` interface one layer down keeps the two seams aligned and
//! means adding a platform never touches the napi surface.

use napi::Result;

use crate::keys::Key;
use crate::types::*;

pub trait Backend: Send {
  fn capabilities(&self) -> Capabilities;
  fn permissions_status(&self) -> PermissionsStatus;

  // ── screen ──
  fn get_displays(&self) -> Result<Vec<Display>>;
  fn screen_size(&self) -> Result<Size>;
  fn screenshot(&self, opts: &ScreenshotOptions) -> Result<(u32, u32, Vec<u8>)>;
  fn pixel_color(&self, p: Point) -> Result<String>;

  // ── mouse ──
  fn mouse_position(&self) -> Result<Point>;
  fn move_mouse(&self, p: Point) -> Result<()>;
  fn mouse_button(&self, button: Button, down: bool) -> Result<()>;
  fn scroll(&self, dx: f64, dy: f64) -> Result<()>;

  /// Convenience click = down+up at the current position. Backends may override
  /// for a more faithful implementation; the default composes button events.
  fn click(&self, button: Button) -> Result<()> {
    self.mouse_button(button, true)?;
    self.mouse_button(button, false)
  }

  // ── keyboard ──
  /// Type a unicode string as text (not as key chords).
  fn type_text(&self, text: &str) -> Result<()>;
  /// Press+release a single resolved key.
  fn key(&self, key: Key, down: bool) -> Result<()>;

  fn press_key(&self, key: Key) -> Result<()> {
    self.key(key, true)?;
    self.key(key, false)
  }

  /// Press a chord: hold each key in order, then release in reverse.
  fn hotkey(&self, keys: &[Key]) -> Result<()> {
    for k in keys {
      self.key(*k, true)?;
    }
    for k in keys.iter().rev() {
      self.key(*k, false)?;
    }
    Ok(())
  }
}
