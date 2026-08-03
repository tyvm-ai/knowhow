//! Click-through native debug overlay for macOS.
//!
//! Rust owns validation/color parsing and the public napi surface. A tiny
//! Objective-C AppKit shim (compiled by build.rs) owns the NSPanel instances;
//! AppKit is the platform renderer and must be called on the main thread.

use crate::types::OverlayPrimitive;
use napi::{Error, Result, Status};

#[repr(C)]
#[derive(Clone, Copy)]
struct NativeOverlayPrimitive {
    kind: i32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    x2: f64,
    y2: f64,
    red: f64,
    green: f64,
    blue: f64,
    alpha: f64,
    line_width: f64,
}

extern "C" {
    fn knowhow_overlay_show(items: *const NativeOverlayPrimitive, count: usize);
    fn knowhow_overlay_clear();
}

fn color(value: Option<&str>) -> Result<(f64, f64, f64, f64)> {
    let text = value.unwrap_or("#ffff00").trim().trim_start_matches('#');
    if text.len() != 6 && text.len() != 8 {
        return Err(Error::new(
            Status::InvalidArg,
            "Overlay colors must be #RRGGBB or #RRGGBBAA",
        ));
    }
    let byte = |offset| {
        u8::from_str_radix(&text[offset..offset + 2], 16).map_err(|_| {
            Error::new(
                Status::InvalidArg,
                "Overlay color contains invalid hex digits",
            )
        })
    };
    Ok((
        byte(0)? as f64 / 255.0,
        byte(2)? as f64 / 255.0,
        byte(4)? as f64 / 255.0,
        if text.len() == 8 {
            byte(6)? as f64 / 255.0
        } else {
            1.0
        },
    ))
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn finite(name: &str, value: f64) -> Result<f64> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(invalid(format!("Overlay {name} must be finite")))
    }
}

fn dimension(name: &str, value: Option<f64>) -> Result<f64> {
    let value = value.ok_or_else(|| invalid(format!("Overlay {name} is required")))?;
    if !value.is_finite() || value < 0.0 {
        return Err(invalid(format!(
            "Overlay {name} must be a finite non-negative number"
        )));
    }
    Ok(value)
}

pub fn show(primitives: Vec<OverlayPrimitive>) -> Result<()> {
    let mut native = Vec::with_capacity(primitives.len());
    for p in primitives {
        let kind = match p.kind.to_ascii_lowercase().as_str() {
            "rect" => 0,
            "circle" => 1,
            "line" => 2,
            "point" => 3,
            other => return Err(invalid(format!("Unknown overlay primitive: {other}"))),
        };
        let x = finite("x", p.x)?;
        let y = finite("y", p.y)?;
        let (width, height, x2, y2) = match kind {
            0 | 1 => (
                dimension("width", p.width)?,
                dimension("height", p.height)?,
                x,
                y,
            ),
            2 => (
                0.0,
                0.0,
                finite(
                    "x2",
                    p.x2.ok_or_else(|| invalid("Overlay x2 is required for lines"))?,
                )?,
                finite(
                    "y2",
                    p.y2.ok_or_else(|| invalid("Overlay y2 is required for lines"))?,
                )?,
            ),
            _ => (
                p.width
                    .map(|v| dimension("width", Some(v)))
                    .transpose()?
                    .unwrap_or(0.0),
                0.0,
                x,
                y,
            ),
        };
        let (red, green, blue, alpha) = color(p.color.as_deref())?;
        native.push(NativeOverlayPrimitive {
            kind,
            x,
            y,
            width,
            height,
            x2,
            y2,
            red,
            green,
            blue,
            alpha,
            line_width: finite("lineWidth", p.line_width.unwrap_or(3.0))?.clamp(1.0, 32.0),
        });
    }
    unsafe { knowhow_overlay_show(native.as_ptr(), native.len()) };
    Ok(())
}

pub fn clear() {
    unsafe { knowhow_overlay_clear() };
}
