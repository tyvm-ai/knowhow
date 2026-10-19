//! Tooltip: borderless non-activating panel near the cursor.

use super::measure::{ui_font, NativeMeasure};
use crate::gui::layout::Measure;
use crate::gui::TooltipRequest;
use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::{
    NSBackingStoreType, NSBox, NSBoxType, NSColor, NSEvent, NSPanel, NSScreen,
    NSStatusWindowLevel, NSTextField, NSTitlePosition, NSView, NSWindowStyleMask,
};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString, NSTimer};
use std::cell::Cell;
use std::rc::Rc;

pub struct Tip {
    panel: Retained<NSPanel>,
    label: Retained<NSTextField>,
    generation: Rc<Cell<u64>>,
}

impl Tip {
    pub fn hide(&self) {
        self.generation.set(self.generation.get() + 1);
        self.panel.orderOut(None);
    }
}

fn make(mtm: MainThreadMarker) -> Tip {
    let style = NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel;
    let panel = unsafe {
        NSPanel::initWithContentRect_styleMask_backing_defer(
            mtm.alloc::<NSPanel>(),
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(100.0, 24.0)),
            style,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { panel.setReleasedWhenClosed(false) };
    panel.setIgnoresMouseEvents(true);
    panel.setLevel(NSStatusWindowLevel);
    panel.setOpaque(false);
    panel.setHasShadow(true);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setHidesOnDeactivate(false);
    let label = unsafe { NSTextField::labelWithString(&NSString::from_str(""), mtm) };
    label.setFont(Some(&ui_font()));
    label.setTextColor(Some(&NSColor::blackColor()));
    let bx = unsafe { NSBox::new(mtm) };
    unsafe {
        bx.setBoxType(NSBoxType::Custom);
        bx.setTitlePosition(NSTitlePosition::NoTitle);
        bx.setCornerRadius(5.0);
        bx.setBorderWidth(1.0);
        bx.setBorderColor(&NSColor::colorWithSRGBRed_green_blue_alpha(0.55, 0.55, 0.45, 1.0));
        bx.setFillColor(&NSColor::colorWithSRGBRed_green_blue_alpha(1.0, 1.0, 0.88, 1.0));
        bx.setContentViewMargins(NSSize::new(6.0, 3.0));
        bx.setContentView(Some(&label));
    }
    let bxv: Retained<NSView> = Retained::into_super(bx);
    panel.setContentView(Some(&bxv));
    Tip { panel, label, generation: Rc::new(Cell::new(0)) }
}

fn primary_height(mtm: MainThreadMarker) -> f64 {
    NSScreen::screens(mtm).firstObject().map(|s| s.frame().size.height).unwrap_or(900.0)
}

/// Show / replace / hide the tip held in `slot`.
pub fn show(mtm: MainThreadMarker, slot: &mut Option<Tip>, req: &TooltipRequest) {
    if req.text.is_empty() {
        if let Some(t) = slot.as_ref() {
            t.hide();
        }
        return;
    }
    let tip = slot.get_or_insert_with(|| make(mtm));
    let text = NativeMeasure.text_size(&req.text, false);
    let (w, h) = ((text.w + 12.0 + 4.0) as f64, (text.h + 6.0 + 2.0) as f64);
    // top-left in Cocoa (bottom-left origin) coordinates
    let tl = match req.at {
        Some((x, y)) => NSPoint::new(x, primary_height(mtm) - y),
        None => {
            let m = NSEvent::mouseLocation();
            NSPoint::new(m.x + 16.0, m.y - 16.0)
        }
    };
    tip.label.setStringValue(&NSString::from_str(&req.text));
    tip.panel.setFrame_display(NSRect::new(NSPoint::new(tl.x, tl.y - h), NSSize::new(w, h)), true);
    tip.panel.orderFrontRegardless();
    let gen = tip.generation.get() + 1;
    tip.generation.set(gen);
    if req.ms > 0 {
        let g = tip.generation.clone();
        let panel = tip.panel.clone();
        let block = RcBlock::new(move |_t: std::ptr::NonNull<NSTimer>| {
            if g.get() == gen {
                panel.orderOut(None);
            }
        });
        unsafe {
            NSTimer::scheduledTimerWithTimeInterval_repeats_block(req.ms as f64 / 1000.0, false, &block);
        }
    }
}
