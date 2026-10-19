//! Tooltip: a click-through, non-activating, always-on-top popup near the cursor.

use super::util::{NullCheck, dpi_of, make_font, pcwstr, px, wide};
use super::window::hinstance;
use crate::gui::TooltipRequest;
use ::windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use ::windows::Win32::Graphics::Gdi::*;
use ::windows::Win32::UI::WindowsAndMessaging::*;
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

const CLASS: &str = "KnowhowTooltipWindow";
const TIMER_ID: usize = 1;

#[derive(Default)]
struct Tip {
    hwnd: HWND,
    owner: String,
    text: String,
    font: HFONT,
}

thread_local! {
    static TIP: RefCell<Tip> = RefCell::new(Tip::default());
}

fn register_class() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let name = wide(CLASS);
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(proc),
            hInstance: hinstance(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            lpszClassName: pcwstr(&name),
            ..Default::default()
        };
        RegisterClassExW(&wc);
    });
}

fn ensure_window() -> Result<HWND, String> {
    let existing = TIP.with(|t| t.borrow().hwnd);
    if !existing.is_invalid() {
        return Ok(existing);
    }
    register_class();
    let class = wide(CLASS);
    let ex = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE;
    let hwnd = unsafe {
        CreateWindowExW(ex, pcwstr(&class), pcwstr(&[0u16]), WS_POPUP, 0, 0, 10, 10, None, None, hinstance(), None)
    };
    if hwnd.is_invalid() {
        return Err("tooltip window creation failed".into());
    }
    unsafe {
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 255, LWA_ALPHA);
    }
    TIP.with(|t| t.borrow_mut().hwnd = hwnd);
    Ok(hwnd)
}

pub fn hide() {
    let hwnd = TIP.with(|t| t.borrow().hwnd);
    if !hwnd.is_invalid() {
        unsafe {
            let _ = KillTimer(hwnd, TIMER_ID);
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

pub fn clear_for(owner: &str) {
    if TIP.with(|t| t.borrow().owner == owner) {
        hide();
    }
}

pub fn show(owner: &str, req: &TooltipRequest) -> Result<(), String> {
    if req.text.is_empty() {
        hide();
        return Ok(());
    }
    let hwnd = ensure_window()?;
    let mut cur = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut cur);
    }
    let (ax, ay) = match req.at {
        Some((x, y)) => (x as i32, y as i32),
        None => (cur.x + 16, cur.y + 16),
    };
    let dpi = dpi_of(hwnd);
    let font = make_font(dpi, false);
    let text = wide(&req.text);
    let pad = px(6.0, dpi);
    let (w, h) = unsafe {
        let dc = GetDC(hwnd);
        let old = SelectObject(dc, HGDIOBJ(font.0));
        let mut rc = RECT { left: 0, top: 0, right: px(480.0, dpi), bottom: 0 };
        DrawTextW(dc, &mut text.clone()[..text.len() - 1], &mut rc, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
        SelectObject(dc, old);
        ReleaseDC(hwnd, dc);
        (rc.right - rc.left + 2 * pad, rc.bottom - rc.top + 2 * pad)
    };
    // keep fully on the work area of the monitor containing the anchor
    let (mut x, mut y) = (ax, ay);
    unsafe {
        let mon = MonitorFromPoint(POINT { x: ax, y: ay }, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(mon, &mut mi).as_bool() {
            x = x.min(mi.rcWork.right - w).max(mi.rcWork.left);
            y = y.min(mi.rcWork.bottom - h).max(mi.rcWork.top);
        }
    }
    let old_font = TIP.with(|t| {
        let mut t = t.borrow_mut();
        t.owner = owner.to_string();
        t.text = req.text.clone();
        std::mem::replace(&mut t.font, font)
    });
    super::util::delete_font(old_font);
    unsafe {
        let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        let _ = InvalidateRect(hwnd, None, true);
        if req.ms > 0 {
            SetTimer(hwnd, TIMER_ID, req.ms.min(u32::MAX as u64) as u32, None);
        } else {
            let _ = KillTimer(hwnd, TIMER_ID);
        }
    }
    Ok(())
}

fn paint(hwnd: HWND) {
    unsafe {
        let mut ps = PAINTSTRUCT::default();
        let dc = BeginPaint(hwnd, &mut ps);
        let mut rc = RECT::default();
        let _ = GetClientRect(hwnd, &mut rc);
        let bg = CreateSolidBrush(COLORREF(0x00E1FFFF)); // RGB(255,255,225)
        let border = CreateSolidBrush(COLORREF(0x00000000));
        FillRect(dc, &rc, bg);
        FrameRect(dc, &rc, border);
        let _ = DeleteObject(HGDIOBJ(bg.0));
        let _ = DeleteObject(HGDIOBJ(border.0));
        let (text, font) = TIP.with(|t| {
            let t = t.borrow();
            (t.text.clone(), t.font)
        });
        let pad = px(6.0, dpi_of(hwnd));
        let old = SelectObject(dc, HGDIOBJ(font.0));
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, COLORREF(0));
        let mut r = rc;
        r.left += pad;
        r.top += pad;
        r.right -= pad;
        r.bottom -= pad;
        let mut w: Vec<u16> = text.encode_utf16().collect();
        DrawTextW(dc, &mut w, &mut r, DT_WORDBREAK | DT_NOPREFIX);
        SelectObject(dc, old);
        let _ = EndPaint(hwnd, &ps);
    }
}

unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let r = catch_unwind(AssertUnwindSafe(|| -> Option<LRESULT> {
        match msg {
            WM_PAINT => {
                paint(hwnd);
                Some(LRESULT(0))
            }
            WM_TIMER => {
                hide();
                Some(LRESULT(0))
            }
            WM_NCHITTEST => Some(LRESULT(-1)), // HTTRANSPARENT
            WM_MOUSEACTIVATE => Some(LRESULT(3)), // MA_NOACTIVATE
            _ => None,
        }
    }));
    match r {
        Ok(Some(l)) => l,
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}
