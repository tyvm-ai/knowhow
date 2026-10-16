//! Fallback backend for platforms whose native implementation hasn't landed yet
//! (currently Windows and Linux — those get real backends in later phases). It
//! compiles everywhere and reports zero capabilities so the TS layer cleanly
//! falls back to the CLI-adapter driver instead of crashing.

use napi::{Error, Result, Status};

use crate::backend::Backend;
use crate::keys::Key;
use crate::types::*;

pub struct StubBackend {
    platform: String,
}

impl StubBackend {
    pub fn new(platform: &str) -> Self {
        StubBackend {
            platform: platform.to_string(),
        }
    }

    fn unsupported<T>(&self) -> Result<T> {
        Err(Error::new(
            Status::GenericFailure,
            format!(
                "knowhow-computer-core: no native backend for '{}' yet; use the CLI-adapter driver",
                self.platform
            ),
        ))
    }
}

impl Backend for StubBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            input: false,
            capture: false,
            windows: false,
            reason: Some(format!(
                "no native backend for '{}' yet (fall back to CLI adapter)",
                self.platform
            )),
        }
    }

    fn permissions_status(&self) -> PermissionsStatus {
        PermissionsStatus {
            platform: self.platform.clone(),
            input_ok: false,
            capture_ok: false,
            fix: Some("Native core backend not implemented for this platform yet.".to_string()),
        }
    }

    fn get_displays(&self) -> Result<Vec<Display>> {
        self.unsupported()
    }
    fn screen_size(&self) -> Result<Size> {
        self.unsupported()
    }
    fn screenshot(&self, _opts: &ScreenshotOptions) -> Result<(u32, u32, Vec<u8>)> {
        self.unsupported()
    }
    fn pixel_color(&self, _p: Point) -> Result<String> {
        self.unsupported()
    }
    fn mouse_position(&self) -> Result<Point> {
        self.unsupported()
    }
    fn move_mouse(&self, _p: Point) -> Result<()> {
        self.unsupported()
    }
    fn mouse_button(&self, _button: Button, _down: bool) -> Result<()> {
        self.unsupported()
    }
    fn scroll(&self, _dx: f64, _dy: f64) -> Result<()> {
        self.unsupported()
    }
    fn type_text(&self, _text: &str) -> Result<()> {
        self.unsupported()
    }
    fn key(&self, _key: Key, _down: bool) -> Result<()> {
        self.unsupported()
    }
}
