//! Native text measurement (NSFont metrics) for the layout engine.

use crate::gui::layout::{Measure, Size};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSFont, NSFontAttributeName, NSFontWeightRegular, NSStringDrawing};
use objc2_foundation::{NSDictionary, NSString};

pub const UI_FONT_SIZE: f64 = 13.0;
pub const MONO_FONT_SIZE: f64 = 12.0;

pub fn ui_font() -> Retained<NSFont> {
    NSFont::systemFontOfSize(UI_FONT_SIZE)
}

pub fn mono_font() -> Retained<NSFont> {
    unsafe { NSFont::monospacedSystemFontOfSize_weight(MONO_FONT_SIZE, NSFontWeightRegular) }
}

#[derive(Default, Clone, Copy)]
pub struct NativeMeasure;

impl Measure for NativeMeasure {
    fn text_size(&self, text: &str, monospace: bool) -> Size {
        let font = if monospace { mono_font() } else { ui_font() };
        let mut w = 0.0f64;
        let mut n = 0usize;
        for line in text.split('\n') {
            n += 1;
            if line.is_empty() {
                continue;
            }
            let s = NSString::from_str(line);
            let obj: &AnyObject = &font;
            let attrs: Retained<NSDictionary<NSString, AnyObject>> =
                unsafe { NSDictionary::from_slices(&[NSFontAttributeName], &[obj]) };
            let sz = unsafe { s.sizeWithAttributes(Some(&attrs)) };
            w = w.max(sz.width);
        }
        let line_h = (font.ascender() - font.descender() + font.leading()).ceil().max(14.0);
        Size { w: w.ceil() as f32 + 1.0, h: (line_h as f32) * n as f32 }
    }
}
