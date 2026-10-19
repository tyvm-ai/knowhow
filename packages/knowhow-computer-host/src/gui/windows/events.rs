//! Window message handling: WM_COMMAND → GuiEmitter events, size/DPI/close.

use super::arrange::{apply_fonts, relayout};
use super::state::{lookup, CKind, WinState, CID_BASE};
use super::util::{from_crlf, get_text};
use ::windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use ::windows::Win32::UI::HiDpi::AdjustWindowRectExForDpi;
use ::windows::Win32::UI::WindowsAndMessaging::*;

const BN_CLICKED: u32 = 0;
const EN_CHANGE: u32 = 0x0300;
const SELCHANGE: u32 = 1; // CBN_SELCHANGE == LBN_SELCHANGE

/// `None` = fall through to DefWindowProc.
pub fn handle(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> Option<LRESULT> {
    match msg {
        WM_SIZE => {
            if wp.0 != SIZE_MINIMIZED as usize {
                let st = lookup(hwnd)?;
                relayout(&st);
            }
            Some(LRESULT(0))
        }
        WM_GETMINMAXINFO => {
            let st = lookup(hwnd)?;
            let (mw, mh) = st.min_content.get();
            let dpi = st.dpi.get();
            let mut rc = RECT {
                left: 0,
                top: 0,
                right: super::util::px(mw, dpi),
                bottom: super::util::px(mh, dpi),
            };
            unsafe {
                let _ = AdjustWindowRectExForDpi(&mut rc, WINDOW_STYLE(st.style), false, WINDOW_EX_STYLE(st.ex_style), dpi);
                let mmi = lp.0 as *mut MINMAXINFO;
                (*mmi).ptMinTrackSize.x = rc.right - rc.left;
                (*mmi).ptMinTrackSize.y = rc.bottom - rc.top;
            }
            Some(LRESULT(0))
        }
        WM_DPICHANGED => {
            let st = lookup(hwnd)?;
            let r = unsafe { *(lp.0 as *const RECT) };
            st.dpi.set(((wp.0 >> 16) & 0xffff) as u32);
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    HWND::default(),
                    r.left,
                    r.top,
                    r.right - r.left,
                    r.bottom - r.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            apply_fonts(&st);
            relayout(&st);
            Some(LRESULT(0))
        }
        WM_COMMAND => {
            let st = lookup(hwnd)?;
            command(&st, wp, lp);
            Some(LRESULT(0))
        }
        WM_CLOSE => {
            // never destroy on our own: hide, then tell the worker
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            if let Some(st) = lookup(hwnd) {
                if !st.destroyed.get() {
                    st.emitter.close();
                }
            }
            Some(LRESULT(0))
        }
        _ => None,
    }
}

fn command(st: &WinState, wp: WPARAM, lp: LPARAM) {
    let cid = (wp.0 & 0xffff) as u16;
    let code = ((wp.0 >> 16) & 0xffff) as u32;
    if lp.0 == 0 || cid < CID_BASE || st.suppress.get() > 0 || st.destroyed.get() {
        return;
    }
    let idx = (cid - CID_BASE) as usize;
    let Some(c) = st.ctl(idx) else { return };
    let Some(id) = super::controls::index_id(st, idx) else { return };
    let h = c.hwnd;
    match (c.kind, code) {
        (CKind::Button, BN_CLICKED) => st.emitter.click(&id),
        (CKind::Checkbox, BN_CLICKED) => {
            let v = unsafe { SendMessageW(h, BM_GETCHECK, WPARAM(0), LPARAM(0)) };
            st.emitter.change_checked(&id, v.0 == 1);
        }
        (CKind::Input, EN_CHANGE) => st.emitter.change_text(&id, &get_text(h)),
        (CKind::Textarea, EN_CHANGE) => st.emitter.change_text(&id, &from_crlf(&get_text(h))),
        (CKind::Number, EN_CHANGE) => {
            if let Ok(v) = get_text(h).trim().parse::<f64>() {
                st.emitter.change_number(&id, v);
            }
        }
        (CKind::Dropdown, SELCHANGE) => {
            let v = unsafe { SendMessageW(h, CB_GETCURSEL, WPARAM(0), LPARAM(0)) };
            st.emitter.select(&id, v.0 as i64);
        }
        (CKind::Listbox, SELCHANGE) => {
            let v = unsafe { SendMessageW(h, LB_GETCURSEL, WPARAM(0), LPARAM(0)) };
            st.emitter.select(&id, v.0 as i64);
        }
        _ => {}
    }
}
