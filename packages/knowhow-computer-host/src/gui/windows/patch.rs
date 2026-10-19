//! Applying `guiPatch` props to native controls (silently) + the node tree.

use super::arrange::relayout;
use super::state::{node_at_mut, CKind, WinState};
use super::util::{fmt_num, set_text, to_crlf, wide};
use crate::gui::spec::{Kind, Patch};
use ::windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use ::windows::Win32::UI::WindowsAndMessaging::*;

const PBM_SETRANGE32: u32 = 0x0406;
const PBM_SETPOS: u32 = 0x0402;

fn fill(h: HWND, reset: u32, add: u32, items: &[String]) {
    unsafe {
        SendMessageW(h, reset, WPARAM(0), LPARAM(0));
        for it in items {
            let w = wide(it);
            SendMessageW(h, add, WPARAM(0), LPARAM(w.as_ptr() as isize));
        }
    }
}

pub fn apply(st: &WinState, patches: &[Patch]) -> Result<(), String> {
    let mut relay = false;
    for p in patches {
        let (idx, c) = st.ctl_by_id(&p.id).ok_or_else(|| format!("unknown control id '{}'", p.id))?;
        let pr = &p.props;
        let h = c.hwnd;
        st.silently(|| {
            if let Some(t) = &pr.text {
                if matches!(c.kind, CKind::Label | CKind::Button | CKind::Checkbox | CKind::Group) {
                    set_text(h, t);
                    relay = true;
                    if let Some(n) = node_at_mut(&mut st.root.borrow_mut(), idx) {
                        match &mut n.kind {
                            Kind::Label { text } | Kind::Button { text, .. } | Kind::Checkbox { text, .. } => {
                                *text = t.clone()
                            }
                            Kind::Group { title, .. } => *title = Some(t.clone()),
                            _ => {}
                        }
                    }
                }
            }
            match c.kind {
                CKind::Input | CKind::Number | CKind::Textarea => {
                    let v = if c.kind == CKind::Number {
                        pr.value_f64().map(fmt_num).or_else(|| pr.value_str())
                    } else {
                        pr.value_str()
                    };
                    if let Some(v) = v {
                        set_text(h, &if c.kind == CKind::Textarea { to_crlf(&v) } else { v });
                    }
                }
                CKind::Progress => {
                    if let Some(m) = pr.max {
                        unsafe { SendMessageW(h, PBM_SETRANGE32, WPARAM(0), LPARAM(m as isize)) };
                    }
                    if let Some(v) = pr.value_f64() {
                        unsafe { SendMessageW(h, PBM_SETPOS, WPARAM(v.max(0.0) as usize), LPARAM(0)) };
                    }
                }
                CKind::Dropdown => {
                    if let Some(o) = &pr.options {
                        fill(h, CB_RESETCONTENT, CB_ADDSTRING, o);
                        relay = true;
                    }
                    if let Some(s) = pr.selected {
                        unsafe { SendMessageW(h, CB_SETCURSEL, WPARAM(s as usize), LPARAM(0)) };
                    }
                }
                CKind::Listbox => {
                    if let Some(o) = &pr.items {
                        fill(h, LB_RESETCONTENT, LB_ADDSTRING, o);
                        relay = true;
                    }
                    if let Some(s) = pr.selected {
                        unsafe { SendMessageW(h, LB_SETCURSEL, WPARAM(s as usize), LPARAM(0)) };
                    }
                }
                CKind::Checkbox => {
                    if let Some(b) = pr.checked {
                        unsafe { SendMessageW(h, BM_SETCHECK, WPARAM(b as usize), LPARAM(0)) };
                    }
                }
                _ => {}
            }
        });
        if pr.enabled.is_some() || pr.visible.is_some() {
            relay = true;
            if let Some(n) = node_at_mut(&mut st.root.borrow_mut(), idx) {
                if pr.enabled.is_some() {
                    n.enabled = pr.enabled;
                }
                if pr.visible.is_some() {
                    n.visible = pr.visible;
                }
            }
        }
    }
    if relay {
        relayout(st);
    }
    Ok(())
}
