//! Top-level form windows: class, WndProc, creation, show/hide/destroy.

use super::arrange::{apply_fonts, relayout};
use super::events::handle;
use super::controls::build;
use super::state::{lookup, register, unregister, WinState};
use super::util::{dpi_of, pcwstr, wide, NullCheck};
use crate::gui::layout::{effective_size, min_window_size, ApproxMeasure, Size};
use crate::gui::spec::{Position, WindowSpec};
use crate::gui::GuiEmitter;
use ::windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use ::windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, COLOR_BTNFACE, HBRUSH, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::UI::HiDpi::AdjustWindowRectExForDpi;
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, SetFocus, KEYEVENTF_KEYUP, VK_MENU,
};
use ::windows::Win32::UI::WindowsAndMessaging::*;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;
use std::sync::Once;

const CLASS: &str = "KnowhowGuiWindow";

pub fn hinstance() -> HINSTANCE {
    unsafe { HINSTANCE(GetModuleHandleW(None).map(|m| m.0).unwrap_or_default()) }
}

pub fn register_class() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        super::init_common_controls();
        let name = wide(CLASS);
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wndproc),
            hInstance: hinstance(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: HBRUSH((COLOR_BTNFACE.0 + 1) as isize),
            lpszClassName: pcwstr(&name),
            ..Default::default()
        };
        RegisterClassExW(&wc);
    });
}

fn work_area_at(p: POINT) -> RECT {
    unsafe {
        let mon = MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if GetMonitorInfoW(mon, &mut mi).as_bool() {
            mi.rcWork
        } else {
            RECT { left: 0, top: 0, right: 1280, bottom: 720 }
        }
    }
}

/// Top-left for a `w`x`h` window per the spec position.
fn position_for(pos: Option<&Position>, w: i32, h: i32) -> (i32, i32) {
    let mut cur = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut cur);
    }
    let wa = work_area_at(cur);
    let clamp = |x: i32, y: i32| {
        (x.min(wa.right - w).max(wa.left), y.min(wa.bottom - h).max(wa.top))
    };
    match pos {
        Some(Position::Xy { x, y }) => (*x as i32, *y as i32),
        Some(Position::Named(s)) if s == "cursor" => clamp(cur.x, cur.y),
        _ => clamp(wa.left + (wa.right - wa.left - w) / 2, wa.top + (wa.bottom - wa.top - h) / 2),
    }
}

pub fn create(spec: &WindowSpec, emitter: GuiEmitter) -> Result<HWND, String> {
    register_class();
    let mut style = WS_OVERLAPPEDWINDOW.0;
    if !spec.is_resizable() {
        style &= !(WS_THICKFRAME.0 | WS_MAXIMIZEBOX.0);
    }
    let class = wide(CLASS);
    let title = wide(&spec.title);
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            pcwstr(&class),
            pcwstr(&title),
            WINDOW_STYLE(style),
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            100,
            100,
            None,
            None,
            hinstance(),
            None,
        )
    };
    if hwnd.is_invalid() {
        return Err("CreateWindowEx failed".into());
    }
    let dpi = dpi_of(hwnd);
    let st = Rc::new(WinState {
        emitter,
        hwnd: Cell::new(hwnd),
        root: RefCell::new(spec.layout.clone()),
        ctls: RefCell::new(Vec::new()),
        by_id: RefCell::new(HashMap::new()),
        font: Cell::new(Default::default()),
        mono_font: Cell::new(Default::default()),
        dpi: Cell::new(dpi),
        suppress: Cell::new(0),
        in_layout: Cell::new(false),
        min_content: Cell::new((0.0, 0.0)),
        style,
        ex_style: 0,
        default_btn: Cell::new(usize::MAX),
        destroyed: Cell::new(false),
    });
    register(hwnd, st.clone());
    let ctls = build(&st, hwnd, &spec.layout);
    let mut ids = HashMap::new();
    let mut i = 0usize;
    spec.layout.walk(&mut |n| {
        if let Some(id) = &n.id {
            ids.insert(id.clone(), i);
        }
        i += 1;
    });
    *st.ctls.borrow_mut() = ctls;
    *st.by_id.borrow_mut() = ids;
    let m = ApproxMeasure;
    let min = min_window_size(&spec.layout, &m);
    st.min_content.set((min.w, min.h));
    let want = Size { w: spec.content_width(), h: spec.content_height() };
    let eff = effective_size(&spec.layout, want, &m);
    let mut rc = RECT {
        left: 0,
        top: 0,
        right: super::util::px(eff.w, dpi),
        bottom: super::util::px(eff.h, dpi),
    };
    unsafe {
        let _ = AdjustWindowRectExForDpi(&mut rc, WINDOW_STYLE(style), false, WINDOW_EX_STYLE(0), dpi);
    }
    let (w, h) = (rc.right - rc.left, rc.bottom - rc.top);
    let (x, y) = position_for(spec.position.as_ref(), w, h);
    let after = if spec.is_always_on_top() { HWND_TOPMOST } else { HWND_TOP };
    unsafe {
        let _ = SetWindowPos(hwnd, after, x, y, w, h, SWP_NOACTIVATE);
    }
    st.dpi.set(dpi_of(hwnd));
    apply_fonts(&st);
    relayout(&st);
    Ok(hwnd)
}

/// Show + bring to the foreground. Windows only lets the foreground process
/// steal focus, so when `SetForegroundWindow` fails we synthesise an ALT
/// key press (the classic workaround that lifts the foreground lock).
pub fn show(hwnd: HWND) {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        } else {
            let _ = ShowWindow(hwnd, SW_SHOW);
        }
        if !SetForegroundWindow(hwnd).as_bool() {
            keybd_event(VK_MENU.0 as u8, 0, Default::default(), 0);
            let _ = SetForegroundWindow(hwnd);
            keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
        }
        let _ = BringWindowToTop(hwnd);
    }
}

pub fn destroy(hwnd: HWND) {
    let Some(st) = lookup(hwnd) else { return };
    st.destroyed.set(true);
    unsafe {
        let _ = DestroyWindow(hwnd);
    }
    unregister(hwnd);
    super::util::delete_font(st.font.replace(Default::default()));
    super::util::delete_font(st.mono_font.replace(Default::default()));
}

pub fn focus_control(hwnd: HWND, ctl: Option<HWND>) {
    unsafe {
        match ctl {
            Some(c) => {
                let _ = SetFocus(c);
            }
            None => {
                let _ = SetFocus(hwnd);
            }
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let r = catch_unwind(AssertUnwindSafe(|| handle(hwnd, msg, wp, lp)));
    match r {
        Ok(Some(l)) => l,
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}
