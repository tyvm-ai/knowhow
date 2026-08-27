//! Rust FFI bindings to the Objective-C ScreenCaptureKit stream bridge.
//! Exposes `start_stream`, `latest_frame`, and `stop_stream` to `lib.rs`.
//! Types (`ScreenStreamOptions`, `ScreenFrame`) are defined in `types.rs`.

#![cfg(target_os = "macos")]

use napi::bindgen_prelude::Buffer;
use napi::{Error, Result, Status};

use crate::types::{ScreenFrame, ScreenStreamOptions};

// ── C struct mirroring KnowhowStreamOptions in macos_stream.m ───────────────

/// Must be kept in sync with `KnowhowStreamOptions` in `macos_stream.m`.
#[repr(C)]
struct RawStreamOptions {
    region_x: f64,
    region_y: f64,
    region_w: f64,
    region_h: f64,
    use_region: i32,
    display_id: u32,
    scale: f32,
    fps: f32,
    frames_to_keep: u32,
}

extern "C" {
    fn knowhow_stream_start(opts: *const RawStreamOptions) -> u64;

    fn knowhow_stream_latest_frame(
        stream_id: u64,
        after_sequence: u64,
        out_data: *mut *mut u8,
        out_width: *mut u32,
        out_height: *mut u32,
        out_sequence: *mut u64,
        out_captured_at_ms: *mut i64,
    ) -> i32;

    fn knowhow_stream_stop(stream_id: u64);
}

// ── Public API (called from lib.rs) ─────────────────────────────────────────

/// Start a persistent ScreenCaptureKit stream. Returns a numeric stream id.
pub fn start_stream(options: Option<ScreenStreamOptions>) -> Result<f64> {
    let opts = options.unwrap_or_default();

    let (use_region, region_x, region_y, region_w, region_h) =
        if let Some(r) = opts.region {
            if r.width > 0.0 && r.height > 0.0 {
                (1i32, r.x, r.y, r.width, r.height)
            } else {
                (0i32, 0.0, 0.0, 0.0, 0.0)
            }
        } else {
            (0i32, 0.0, 0.0, 0.0, 0.0)
        };

    let display_id = opts.display_id.unwrap_or(0.0) as u32;

    let scale = opts
        .scale
        .map(|s| s.clamp(0.01, 1.0) as f32)
        .unwrap_or(1.0f32);

    let fps = opts
        .fps
        .map(|f| f.clamp(1.0, 60.0) as f32)
        .unwrap_or(10.0f32);

    let frames_to_keep = opts.frames_to_keep.unwrap_or(4).clamp(1, 256);

    let raw = RawStreamOptions {
        region_x,
        region_y,
        region_w,
        region_h,
        use_region,
        display_id,
        scale,
        fps,
        frames_to_keep,
    };

    let id = unsafe { knowhow_stream_start(&raw as *const RawStreamOptions) };

    if id == 0 {
        Err(Error::new(
            Status::GenericFailure,
            "Failed to start ScreenCaptureKit stream — ensure Screen Recording permission is granted",
        ))
    } else {
        Ok(id as f64)
    }
}

/// Poll for the latest frame newer than `after_sequence` (0 = any frame).
/// Returns `None` when no new frame is available yet.
pub fn latest_frame(stream_id: f64, after_sequence: Option<f64>) -> Result<Option<ScreenFrame>> {
    let id = stream_id as u64;
    let after = after_sequence.unwrap_or(0.0) as u64;

    let mut out_data: *mut u8 = std::ptr::null_mut();
    let mut out_width: u32 = 0;
    let mut out_height: u32 = 0;
    let mut out_seq: u64 = 0;
    let mut out_ts_ms: i64 = 0;

    let found = unsafe {
        knowhow_stream_latest_frame(
            id,
            after,
            &mut out_data,
            &mut out_width,
            &mut out_height,
            &mut out_seq,
            &mut out_ts_ms,
        )
    };

    if found == 0 || out_data.is_null() {
        return Ok(None);
    }

    // Take ownership of the C-malloc'd buffer into a Vec<u8>, then into Buffer.
    let len = (out_width as usize) * (out_height as usize) * 4;
    let data_vec: Vec<u8> = unsafe { Vec::from_raw_parts(out_data, len, len) };

    Ok(Some(ScreenFrame {
        sequence: out_seq as f64,
        captured_at: out_ts_ms as f64,
        width: out_width,
        height: out_height,
        data: Buffer::from(data_vec),
    }))
}

/// Stop a running stream and free its resources.
pub fn stop_stream(stream_id: f64) {
    unsafe { knowhow_stream_stop(stream_id as u64) };
}
