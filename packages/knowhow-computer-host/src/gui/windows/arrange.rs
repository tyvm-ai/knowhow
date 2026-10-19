//! Applying the layout engine's frames to the native controls (DPI aware).

use super::state::{CKind, Ctl, WinState};
use super::util::{NullCheck, dpi_of, px, set_font};
use crate::gui::layout::{layout_window, ApproxMeasure, LayoutNode, Rect, Size};
use crate::gui::spec::Node;
use ::windows::Win32::Foundation::{HWND, RECT};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{EnableWindow, IsWindowEnabled};
use ::windows::Win32::UI::WindowsAndMessaging::*;

struct Cx {
    dpi: u32,
    ctls: Vec<Ctl>,
    hdwp: Option<HDWP>,
}

/// Re-run the layout for the current client size and move/show/hide/enable
/// every control. Safe to call re-entrantly (guarded by `in_layout`).
pub fn relayout(st: &WinState) {
    if st.in_layout.replace(true) {
        return;
    }
    do_relayout(st);
    st.in_layout.set(false);
}

fn do_relayout(st: &WinState) {
    let hwnd = st.hwnd.get();
    if hwnd.is_invalid() {
        return;
    }
    let dpi = dpi_of(hwnd);
    st.dpi.set(dpi);
    let mut rc = RECT::default();
    unsafe {
        let _ = GetClientRect(hwnd, &mut rc);
    }
    let k = 96.0 / dpi as f32;
    let content = Size { w: (rc.right - rc.left) as f32 * k, h: (rc.bottom - rc.top) as f32 * k };
    let ctls: Vec<Ctl> = st.ctls.borrow().clone();
    let root = st.root.borrow().clone();
    let lay = layout_window(&root, content, &ApproxMeasure);
    let hdwp = unsafe { BeginDeferWindowPos(ctls.len() as i32 * 2 + 2).ok() };
    let mut cx = Cx { dpi, ctls, hdwp };
    let mut idx = 0;
    walk(&mut cx, &root, &lay, true, &mut idx);
    if let Some(h) = cx.hdwp {
        unsafe {
            let _ = EndDeferWindowPos(h);
        }
    }
}

fn place(cx: &mut Cx, h: HWND, r: Rect, hidden: bool, extra_h: i32) {
    if h.is_invalid() {
        return;
    }
    let flags = SWP_NOZORDER | SWP_NOACTIVATE | if hidden { SWP_HIDEWINDOW } else { SWP_SHOWWINDOW };
    let (x, y) = (px(r.x, cx.dpi), px(r.y, cx.dpi));
    let (w, hh) = (px(r.w, cx.dpi).max(1), (px(r.h, cx.dpi) + extra_h).max(1));
    if let Some(d) = cx.hdwp {
        cx.hdwp = unsafe { DeferWindowPos(d, h, HWND::default(), x, y, w, hh, flags).ok() };
    } else {
        unsafe {
            let _ = SetWindowPos(h, HWND::default(), x, y, w, hh, flags);
        }
    }
}

fn walk(cx: &mut Cx, n: &Node, l: &LayoutNode, enabled: bool, idx: &mut usize) {
    let i = *idx;
    *idx += 1;
    let c = cx.ctls[i];
    let en = enabled && n.is_enabled();
    let extra = if c.kind == CKind::Dropdown { px(180.0, cx.dpi) } else { 0 };
    let mut frame = l.frame;
    if c.kind == CKind::Separator {
        frame.h = frame.h.max(2.0);
    }
    place(cx, c.hwnd, frame, l.hidden, extra);
    if let Some(lf) = l.label_frame {
        place(cx, c.label, lf, l.hidden, 0);
    }
    if !c.hwnd.is_invalid() {
        unsafe {
            if IsWindowEnabled(c.hwnd).as_bool() != en {
                let _ = EnableWindow(c.hwnd, en);
            }
        }
    }
    for (cn, cl) in n.children().iter().zip(l.children.iter()) {
        walk(cx, cn, cl, en, idx);
    }
}

/// (Re)create the fonts for the current DPI and apply them to all controls.
pub fn apply_fonts(st: &WinState) {
    let dpi = st.dpi.get();
    let old = (st.font.get(), st.mono_font.get());
    let (f, m) = (super::util::make_font(dpi, false), super::util::make_font(dpi, true));
    st.font.set(f);
    st.mono_font.set(m);
    let ctls: Vec<Ctl> = st.ctls.borrow().clone();
    for c in ctls {
        let font = if c.monospace { m } else { f };
        for h in [c.hwnd, c.label] {
            if !h.is_invalid() {
                set_font(h, font);
            }
        }
    }
    super::util::delete_font(old.0);
    super::util::delete_font(old.1);
}
