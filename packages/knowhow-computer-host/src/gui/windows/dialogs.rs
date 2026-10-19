//! Alert / confirm (MessageBoxW) and prompt (small modal window with its own
//! nested message loop). `reply` is always called before returning.

use super::util::{NullCheck, dpi_of, get_text, make_font, pcwstr, px, set_font, set_text, wide};
use super::window::{hinstance, show};
use crate::gui::{DialogKind, DialogReply, DialogRequest, DialogResult};
use ::windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use ::windows::Win32::Graphics::Gdi::{COLOR_BTNFACE, HBRUSH};
use ::windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use ::windows::Win32::UI::WindowsAndMessaging::*;
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Once;

const PROMPT_CLASS: &str = "KnowhowPromptWindow";
const ID_EDIT: isize = 100;
const EM_SETSEL: u32 = 0x00B1;

thread_local! {
    /// `Some(Some(text))` = OK, `Some(None)` = cancelled, `None` = still open.
    static PROMPT: RefCell<Option<Option<String>>> = const { RefCell::new(None) };
}

pub fn dialog(req: &DialogRequest, reply: DialogReply) {
    let res = match req.kind {
        DialogKind::Alert => {
            message_box(req, MB_OK | MB_ICONINFORMATION);
            Ok(DialogResult { button: "ok".into(), value: None })
        }
        DialogKind::Confirm => {
            let r = message_box(req, MB_YESNO | MB_ICONQUESTION);
            Ok(DialogResult { button: if r == IDYES { "yes" } else { "no" }.into(), value: None })
        }
        DialogKind::Prompt => Ok(match prompt(req) {
            Some(v) => DialogResult { button: "ok".into(), value: Some(v) },
            None => DialogResult { button: "cancel".into(), value: None },
        }),
    };
    reply(res);
}

fn message_box(req: &DialogRequest, icon: MESSAGEBOX_STYLE) -> MESSAGEBOX_RESULT {
    let (t, m) = (wide(&req.title), wide(&req.message));
    unsafe { MessageBoxW(None, pcwstr(&m), pcwstr(&t), icon | MB_TOPMOST | MB_SETFOREGROUND) }
}

fn register_prompt_class() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        let name = wide(PROMPT_CLASS);
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(prompt_proc),
            hInstance: hinstance(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: HBRUSH((COLOR_BTNFACE.0 + 1) as isize),
            lpszClassName: pcwstr(&name),
            ..Default::default()
        };
        RegisterClassExW(&wc);
    });
}

fn child(parent: HWND, class: &str, text: &str, style: u32, ex: u32, id: isize) -> HWND {
    let (c, t) = (wide(class), wide(text));
    unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(ex),
            pcwstr(&c),
            pcwstr(&t),
            WINDOW_STYLE(style | WS_CHILD.0 | WS_VISIBLE.0),
            0,
            0,
            10,
            10,
            parent,
            HMENU(id),
            hinstance(),
            None,
        )
    }
}

fn mv(h: HWND, dpi: u32, x: f32, y: f32, w: f32, hh: f32) {
    unsafe {
        let _ = SetWindowPos(h, HWND::default(), px(x, dpi), px(y, dpi), px(w, dpi), px(hh, dpi), SWP_NOZORDER);
    }
}

/// Modal prompt; returns the text on OK, `None` on cancel/close.
fn prompt(req: &DialogRequest) -> Option<String> {
    register_prompt_class();
    PROMPT.with(|p| *p.borrow_mut() = None);
    let class = wide(PROMPT_CLASS);
    let title = wide(&req.title);
    let style = WS_CAPTION.0 | WS_SYSMENU.0;
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_DLGMODALFRAME,
            pcwstr(&class),
            pcwstr(&title),
            WINDOW_STYLE(style),
            0,
            0,
            100,
            100,
            None,
            None,
            hinstance(),
            None,
        )
    };
    if hwnd.is_invalid() {
        return None;
    }
    let dpi = dpi_of(hwnd);
    let (cw, ch) = (380.0f32, 150.0f32);
    let font = make_font(dpi, false);
    let label = child(hwnd, "STATIC", &req.message, 0, 0, 101);
    let edit = child(hwnd, "EDIT", "", WS_TABSTOP.0 | ES_AUTOHSCROLL as u32, WS_EX_CLIENTEDGE.0, ID_EDIT);
    let ok = child(hwnd, "BUTTON", "OK", WS_TABSTOP.0 | BS_DEFPUSHBUTTON as u32, 0, 1);
    let cancel = child(hwnd, "BUTTON", "Cancel", WS_TABSTOP.0 | BS_PUSHBUTTON as u32, 0, 2);
    set_text(edit, &req.default);
    for h in [label, edit, ok, cancel] {
        set_font(h, font);
    }
    mv(label, dpi, 12.0, 12.0, cw - 24.0, 56.0);
    mv(edit, dpi, 12.0, 74.0, cw - 24.0, 24.0);
    mv(ok, dpi, cw - 12.0 - 168.0, ch - 40.0, 80.0, 28.0);
    mv(cancel, dpi, cw - 12.0 - 80.0, ch - 40.0, 80.0, 28.0);
    let mut rc = RECT { left: 0, top: 0, right: px(cw, dpi), bottom: px(ch, dpi) };
    unsafe {
        let _ = ::windows::Win32::UI::HiDpi::AdjustWindowRectExForDpi(
            &mut rc,
            WINDOW_STYLE(style),
            false,
            WS_EX_TOPMOST | WS_EX_DLGMODALFRAME,
            dpi,
        );
        let (w, h) = (rc.right - rc.left, rc.bottom - rc.top);
        let x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
        let y = (GetSystemMetrics(SM_CYSCREEN) - h) / 3;
        let _ = SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_NOACTIVATE);
    }
    show(hwnd);
    unsafe {
        let _ = SetFocus(edit);
        SendMessageW(edit, EM_SETSEL, WPARAM(0), LPARAM(-1));
    }
    run_loop(hwnd);
    let res = PROMPT.with(|p| p.borrow_mut().take()).flatten();
    unsafe {
        let _ = DestroyWindow(hwnd);
    }
    super::util::delete_font(font);
    res
}

fn run_loop(hwnd: HWND) {
    let mut msg = MSG::default();
    while PROMPT.with(|p| p.borrow().is_none()) {
        let r = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if r.0 == 0 {
            // WM_QUIT: re-post for the outer loop and cancel
            unsafe { PostQuitMessage(msg.wParam.0 as i32) };
            PROMPT.with(|p| *p.borrow_mut() = Some(None));
            break;
        }
        if r.0 < 0 {
            break;
        }
        unsafe {
            if !IsDialogMessageW(hwnd, &msg).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

unsafe extern "system" fn prompt_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    let r = catch_unwind(AssertUnwindSafe(|| -> bool {
        match msg {
            WM_COMMAND => {
                let id = wp.0 & 0xffff;
                if id == 1 {
                    let e = GetDlgItem(hwnd, ID_EDIT as i32);
                    let v = get_text(e);
                    PROMPT.with(|p| *p.borrow_mut() = Some(Some(v)));
                } else if id == 2 {
                    PROMPT.with(|p| *p.borrow_mut() = Some(None));
                }
                true
            }
            WM_CLOSE => {
                PROMPT.with(|p| *p.borrow_mut() = Some(None));
                true
            }
            _ => false,
        }
    }));
    if let Ok(true) = r {
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wp, lp)
}
