//! `@tyvm/knowhow-computer-core` — the Knowhow-owned, cross-platform computer-use
//! engine. A `napi-rs` addon exposing a narrow `ComputerCore` surface that the TS
//! `RustCoreDriver` marshals directly onto. We own every line here so we can tune
//! permissions, capture, and the key vocabulary to fit Knowhow without depending
//! on a third-party input library.

#![deny(clippy::all)]

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};
use napi_derive::napi;

mod backend;
mod keys;
mod perception;
mod platform;
mod types;

use backend::Backend;
use keys::Key;
use types::*;

// Re-export napi object types so they appear in the generated .d.ts.
pub use types::{
    AccessibilityElement, AccessibilityOptions, Capabilities, Display, OverlayPrimitive,
    PermissionsStatus, Point, RawImage, Region, ScreenshotOptions, Size, WindowInfo,
};

// Re-export stream types so they appear in the generated .d.ts.
pub use types::{ScreenFrame, ScreenStreamOptions};

// Re-export native perception primitives (free functions) + their result types.
pub use perception::{
    find_boxes_raw, find_color_regions_raw, find_regions_raw, BoxNative, ColorRegionNative,
};

/// The main entry point handed to JS. Wraps the platform backend chosen at
/// construction time. One instance is created per process by the TS layer.
#[napi]
pub struct ComputerCore {
    backend: Box<dyn Backend>,
}

#[napi]
impl ComputerCore {
    #[napi(constructor)]
    pub fn new() -> Self {
        ComputerCore {
            backend: platform::create_backend(),
        }
    }

    /// Name of the active backend ("macos" | "windows" | "linux" | "stub:*").
    #[napi]
    pub fn backend_name(&self) -> String {
        let c = self.backend.capabilities();
        if c.input || c.capture {
            std::env::consts::OS.to_string()
        } else {
            format!("stub:{}", std::env::consts::OS)
        }
    }

    #[napi]
    pub fn capabilities(&self) -> Capabilities {
        self.backend.capabilities()
    }

    #[napi]
    pub fn permissions_status(&self) -> PermissionsStatus {
        self.backend.permissions_status()
    }

    // ── windows ──

    /// Enumerate on-screen application windows, front-to-back z-order. The first
    /// entry (and the one with `active == true`) is the focused window.
    #[napi]
    pub fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        self.backend.list_windows()
    }

    /// The frontmost (focused) window, or null when none/unavailable.
    #[napi]
    pub fn active_window(&self) -> Result<Option<WindowInfo>> {
        self.backend.active_window()
    }

    // ── accessibility ──

    #[napi]
    pub fn accessibility_trusted(&self) -> bool {
        #[cfg(target_os = "macos")]
        return platform::macos_accessibility::trusted();

        #[cfg(not(target_os = "macos"))]
        false
    }

    #[napi]
    pub fn accessibility_elements(
        &self,
        options: Option<AccessibilityOptions>,
    ) -> Result<Vec<AccessibilityElement>> {
        #[cfg(target_os = "macos")]
        return platform::macos_accessibility::elements(options);

        #[cfg(not(target_os = "macos"))]
        Err(Error::new(
            Status::GenericFailure,
            "Native accessibility inspection is only supported on macOS",
        ))
    }

    #[napi]
    pub fn set_accessibility_value(&self, id: String, value: String) -> Result<()> {
        #[cfg(target_os = "macos")]
        return platform::macos_accessibility::set_value(&id, &value);

        #[cfg(not(target_os = "macos"))]
        Err(Error::new(
            Status::GenericFailure,
            "Native accessibility value setting is only supported on macOS",
        ))
    }

    #[napi]
    pub fn perform_accessibility_action(&self, id: String, action: String) -> Result<()> {
        #[cfg(target_os = "macos")]
        return platform::macos_accessibility::perform_action(&id, &action);

        #[cfg(not(target_os = "macos"))]
        Err(Error::new(
            Status::GenericFailure,
            "Native accessibility actions are only supported on macOS",
        ))
    }

    // ── debug overlay ──

    /// Replace the click-through desktop debug overlay with these primitives.
    /// The overlay never activates and is excluded from normal screen capture.
    #[napi]
    pub fn show_overlay(&self, primitives: Vec<OverlayPrimitive>) -> Result<()> {
        #[cfg(target_os = "macos")]
        return platform::macos_overlay::show(primitives);

        #[cfg(not(target_os = "macos"))]
        Err(Error::new(
            Status::GenericFailure,
            "Native overlays are currently only supported on macOS",
        ))
    }

    #[napi]
    pub fn clear_overlay(&self) -> Result<()> {
        #[cfg(target_os = "macos")]
        platform::macos_overlay::clear();

        Ok(())
    }

    // ── screen ──

    #[napi]
    pub fn get_displays(&self) -> Result<Vec<Display>> {
        self.backend.get_displays()
    }

    #[napi]
    pub fn screen_size(&self) -> Result<Size> {
        self.backend.screen_size()
    }

    /// Capture the screen (or a single display) as raw RGBA8. The TS layer encodes
    /// to PNG/JPEG and applies scaling/cropping via sharp.
    #[napi]
    pub fn screenshot(&self, options: Option<ScreenshotOptions>) -> Result<RawImage> {
        let opts = options.unwrap_or_default();
        let (width, height, data) = self.backend.screenshot(&opts)?;
        Ok(RawImage {
            width,
            height,
            data: Buffer::from(data),
        })
    }

    #[napi]
    pub fn pixel_color(&self, x: f64, y: f64) -> Result<String> {
        self.backend.pixel_color(Point { x, y })
    }

    // ── mouse ──

    #[napi]
    pub fn mouse_position(&self) -> Result<Point> {
        self.backend.mouse_position()
    }

    #[napi]
    pub fn move_mouse(&self, x: f64, y: f64) -> Result<()> {
        self.backend.move_mouse(Point { x, y })
    }

    #[napi]
    pub fn mouse_button(&self, button: String, down: bool) -> Result<()> {
        self.backend.mouse_button(Button::parse(&button), down)
    }

    #[napi]
    pub fn click(&self, button: Option<String>) -> Result<()> {
        let b = Button::parse(&button.unwrap_or_else(|| "left".to_string()));
        self.backend.click(b)
    }

    #[napi]
    pub fn scroll(&self, dx: f64, dy: f64) -> Result<()> {
        self.backend.scroll(dx, dy)
    }

    // ── keyboard ──

    #[napi]
    pub fn type_text(&self, text: String) -> Result<()> {
        self.backend.type_text(&text)
    }

    #[napi]
    pub fn press_key(&self, key: String) -> Result<()> {
        let k = parse_key(&key)?;
        self.backend.press_key(k)
    }

    #[napi]
    pub fn key(&self, key: String, down: bool) -> Result<()> {
        let k = parse_key(&key)?;
        self.backend.key(k, down)
    }

    /// Press a chord, e.g. `hotkey(["control", "c"])`.
    #[napi]
    pub fn hotkey(&self, keys: Vec<String>) -> Result<()> {
        let parsed = Key::parse_many(&keys).map_err(|e| Error::new(Status::InvalidArg, e))?;
        self.backend.hotkey(&parsed)
    }

    // ── Persistent screen stream ─────────────────────────────────────────────

    /// Start a persistent ScreenCaptureKit stream (macOS only).
    ///
    /// Returns a numeric stream id. Use `latestScreenFrame(id)` to poll frames
    /// and `stopScreenStream(id)` to tear down the stream.
    ///
    /// Options:
    ///   region        – capture sub-region in virtual-desktop coords
    ///   displayId     – CGDirectDisplayID (0 = main display)
    ///   scale         – downsample factor 0 < scale ≤ 1 (default 1.0)
    ///   fps           – desired frames per second 1..60 (default 10)
    ///   framesToKeep  – ring-buffer capacity 1..256 (default 4)
    #[napi]
    pub fn start_screen_stream(
        &self,
        options: Option<ScreenStreamOptions>,
    ) -> Result<f64> {
        #[cfg(target_os = "macos")]
        return platform::macos_stream::start_stream(options);

        #[cfg(not(target_os = "macos"))]
        Err(Error::new(
            Status::GenericFailure,
            "startScreenStream is only supported on macOS",
        ))
    }

    /// Poll for the latest captured frame with sequence > afterSequence.
    ///
    /// Pass `afterSequence: frame.sequence` on subsequent calls to receive only
    /// new frames. Returns null when no new frame is available yet.
    #[napi]
    pub fn latest_screen_frame(
        &self,
        stream_id: f64,
        after_sequence: Option<f64>,
    ) -> Result<Option<ScreenFrame>> {
        #[cfg(target_os = "macos")]
        return platform::macos_stream::latest_frame(stream_id, after_sequence);

        #[cfg(not(target_os = "macos"))]
        Err(Error::new(
            Status::GenericFailure,
            "latestScreenFrame is only supported on macOS",
        ))
    }

    /// Stop a running stream and free its resources.
    #[napi]
    pub fn stop_screen_stream(&self, stream_id: f64) -> Result<()> {
        #[cfg(target_os = "macos")]
        {
            platform::macos_stream::stop_stream(stream_id);
            return Ok(());
        }

        #[cfg(not(target_os = "macos"))]
        Err(Error::new(
            Status::GenericFailure,
            "stopScreenStream is only supported on macOS",
        ))
    }
}

fn parse_key(name: &str) -> Result<Key> {
    Key::parse(name).ok_or_else(|| Error::new(Status::InvalidArg, format!("Unknown key: {name:?}")))
}
