//! Creating the child controls for a spec tree (preorder) + keyboard subclass.

use super::state::{lookup, CKind, Ctl, WinState, CID_BASE};
use super::util::{pcwstr, to_crlf, wide, NullCheck};
use crate::gui::spec::{Kind, Node};
use ::windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, SetFocus, VK_RETURN, VK_SHIFT, VK_TAB};
use ::windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use ::windows::Win32::UI::WindowsAndMessaging::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const SS_ETCHEDHORZ: u32 = 0x10;
const EM_SETCUEBANNER: u32 = 0x1501;
const PBM_SETRANGE32: u32 = 0x0406;
const PBM_SETPOS: u32 = 0x0402;

fn hinst() -> HINSTANCE {
    unsafe { HINSTANCE(GetModuleHandleW(None).map(|m| m.0).unwrap_or_default()) }
}

fn mk(class: &str, text: &str, style: u32, ex: u32, parent: HWND, cid: u16) -> HWND {
    let c = wide(class);
    let t = wide(text);
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
            HMENU(cid as isize),
            hinst(),
            None,
        )
    }
}

fn add_items(hwnd: HWND, msg: u32, items: &[String]) {
    for it in items {
        let w = wide(it);
        unsafe {
            SendMessageW(hwnd, msg, WPARAM(0), LPARAM(w.as_ptr() as isize));
        }
    }
}

fn subclass(hwnd: HWND, parent: HWND) {
    unsafe {
        let _ = SetWindowSubclass(hwnd, Some(ctl_proc), 1, parent.0 as usize);
    }
}

/// Create all controls for `root`; returns one [`Ctl`] per node in preorder.
pub fn build(st: &WinState, parent: HWND, root: &Node) -> Vec<Ctl> {
    let mut out = Vec::new();
    st.silently(|| build_node(st, parent, root, &mut out));
    out
}

fn build_node(st: &WinState, parent: HWND, n: &Node, out: &mut Vec<Ctl>) {
    let idx = out.len();
    let cid = CID_BASE + idx as u16;
    let tab = WS_TABSTOP.0;
    let mut label = HWND::default();
    if let Some(l) = n.kind.label() {
        label = mk("STATIC", l, 0, 0, parent, 0);
    }
    let none = HWND::default();
    let (kind, hwnd, mono) = match &n.kind {
        Kind::Row { .. } | Kind::Column { .. } | Kind::Grid { .. } => (CKind::Container, none, false),
        Kind::Spacer => (CKind::Spacer, none, false),
        Kind::Separator => (CKind::Separator, mk("STATIC", "", SS_ETCHEDHORZ, 0, parent, cid), false),
        Kind::Group { title, .. } => {
            let t = title.as_deref().unwrap_or("");
            (CKind::Group, mk("BUTTON", t, BS_GROUPBOX as u32, 0, parent, cid), false)
        }
        Kind::Label { text } => (CKind::Label, mk("STATIC", text, 0, 0, parent, cid), false),
        Kind::Input { value, placeholder, password, .. } => {
            let mut s = tab | ES_AUTOHSCROLL as u32;
            if password.unwrap_or(false) {
                s |= ES_PASSWORD as u32;
            }
            let h = mk("EDIT", value.as_deref().unwrap_or(""), s, WS_EX_CLIENTEDGE.0, parent, cid);
            if let Some(p) = placeholder.as_deref().filter(|p| !p.is_empty()) {
                let w = wide(p);
                unsafe {
                    SendMessageW(h, EM_SETCUEBANNER, WPARAM(1), LPARAM(w.as_ptr() as isize));
                }
            }
            (CKind::Input, h, false)
        }
        Kind::Textarea { value, read_only, wrap, monospace, .. } => {
            let mut s = tab | (ES_MULTILINE | ES_AUTOVSCROLL) as u32 | WS_VSCROLL.0;
            if !wrap.unwrap_or(true) {
                s |= ES_AUTOHSCROLL as u32 | WS_HSCROLL.0;
            }
            if read_only.unwrap_or(false) {
                s |= ES_READONLY as u32;
            }
            let h = mk("EDIT", &to_crlf(value.as_deref().unwrap_or("")), s, WS_EX_CLIENTEDGE.0, parent, cid);
            (CKind::Textarea, h, monospace.unwrap_or(false))
        }
        Kind::Number { value, .. } => {
            let t = value.map(super::util::fmt_num).unwrap_or_default();
            let h = mk("EDIT", &t, tab | ES_AUTOHSCROLL as u32, WS_EX_CLIENTEDGE.0, parent, cid);
            (CKind::Number, h, false)
        }
        Kind::Checkbox { text, checked } => {
            let h = mk("BUTTON", text, tab | BS_AUTOCHECKBOX as u32, 0, parent, cid);
            unsafe {
                SendMessageW(h, BM_SETCHECK, WPARAM(checked.unwrap_or(false) as usize), LPARAM(0));
            }
            (CKind::Checkbox, h, false)
        }
        Kind::Dropdown { options, selected, .. } => {
            let h = mk("COMBOBOX", "", tab | CBS_DROPDOWNLIST as u32 | WS_VSCROLL.0, 0, parent, cid);
            add_items(h, CB_ADDSTRING, options);
            unsafe {
                SendMessageW(h, CB_SETCURSEL, WPARAM(selected.unwrap_or(-1) as usize), LPARAM(0));
            }
            (CKind::Dropdown, h, false)
        }
        Kind::Listbox { items, selected, .. } => {
            let s = tab | (LBS_NOTIFY | LBS_NOINTEGRALHEIGHT) as u32 | WS_VSCROLL.0;
            let h = mk("LISTBOX", "", s, WS_EX_CLIENTEDGE.0, parent, cid);
            add_items(h, LB_ADDSTRING, items);
            unsafe {
                SendMessageW(h, LB_SETCURSEL, WPARAM(selected.unwrap_or(-1) as usize), LPARAM(0));
            }
            (CKind::Listbox, h, false)
        }
        Kind::Button { text, is_default } => {
            let def = is_default.unwrap_or(false);
            let style = if def { BS_DEFPUSHBUTTON } else { BS_PUSHBUTTON } as u32;
            if def {
                st.default_btn.set(idx);
            }
            (CKind::Button, mk("BUTTON", text, tab | style, 0, parent, cid), false)
        }
        Kind::Progress { value, max } => {
            let h = mk("msctls_progress32", "", 0, 0, parent, cid);
            unsafe {
                SendMessageW(h, PBM_SETRANGE32, WPARAM(0), LPARAM(max.unwrap_or(100.0) as isize));
                SendMessageW(h, PBM_SETPOS, WPARAM(value.unwrap_or(0.0) as usize), LPARAM(0));
            }
            (CKind::Progress, h, false)
        }
    };
    if !hwnd.is_invalid() && !matches!(kind, CKind::Group | CKind::Separator | CKind::Label | CKind::Progress) {
        subclass(hwnd, parent);
    }
    out.push(Ctl { kind, hwnd, label, monospace: mono });
    for c in n.children() {
        build_node(st, parent, c, out);
    }
}

/// Keyboard handling for focusable controls: Tab navigation, Enter → submit /
/// default button.
unsafe extern "system" fn ctl_proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, parent: usize) -> LRESULT {
    let handled = catch_unwind(AssertUnwindSafe(|| key(h, msg, wp, HWND(parent as isize))));
    if let Ok(true) = handled {
        return LRESULT(0);
    }
    DefSubclassProc(h, msg, wp, lp)
}

fn key(h: HWND, msg: u32, wp: WPARAM, parent: HWND) -> bool {
    let is_tab = wp.0 == VK_TAB.0 as usize || wp.0 == 9;
    let is_ret = wp.0 == VK_RETURN.0 as usize || wp.0 == 13;
    if msg == WM_CHAR && (is_tab || is_ret) {
        // swallow the char so the control doesn't beep / insert a tab
        let multiline = lookup(parent).and_then(|s| find(&s, h)).map(|c| c.kind == CKind::Textarea).unwrap_or(false);
        return is_tab || !multiline;
    }
    if msg != WM_KEYDOWN || !(is_tab || is_ret) {
        return false;
    }
    let Some(st) = lookup(parent) else { return false };
    let Some(ctl) = find(&st, h) else { return false };
    if is_tab {
        let shift = unsafe { GetKeyState(VK_SHIFT.0 as i32) } < 0;
        unsafe {
            let next = GetNextDlgTabItem(parent, h, shift);
            if !next.is_invalid() {
                let _ = SetFocus(next);
            }
        }
        return true;
    }
    match ctl.kind {
        CKind::Textarea => false,
        CKind::Input => {
            let (id, v) = (control_id(&st, h), super::util::get_text(h));
            if let Some(id) = id {
                st.emitter.submit(&id, &v);
            }
            true
        }
        CKind::Button => {
            unsafe { SendMessageW(h, BM_CLICK, WPARAM(0), LPARAM(0)) };
            true
        }
        _ => {
            if let Some(b) = st.ctl(st.default_btn.get()) {
                unsafe { SendMessageW(b.hwnd, BM_CLICK, WPARAM(0), LPARAM(0)) };
            }
            true
        }
    }
}

fn find(st: &WinState, h: HWND) -> Option<Ctl> {
    st.ctls.borrow().iter().find(|c| c.hwnd == h).copied()
}

pub fn control_id(st: &WinState, h: HWND) -> Option<String> {
    let idx = st.ctls.borrow().iter().position(|c| c.hwnd == h)?;
    index_id(st, idx)
}

pub fn index_id(st: &WinState, idx: usize) -> Option<String> {
    st.by_id.borrow().iter().find(|(_, v)| **v == idx).map(|(k, _)| k.clone())
}
