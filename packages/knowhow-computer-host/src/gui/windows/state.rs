//! Per-window state + thread-local registry keyed by HWND.
//!
//! Rule: never hold a `RefCell` borrow across a Win32 call that can re-enter
//! the WndProc (SetWindowText, ShowWindow, SetWindowPos, DestroyWindow, ...).
//! Copy out what you need (HWNDs are `Copy`) and drop the borrow first.

use crate::gui::spec::Node;
use crate::gui::GuiEmitter;
use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::Graphics::Gdi::HFONT;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

/// First numeric control id (`WM_COMMAND` low word = `CID_BASE + index`).
pub const CID_BASE: u16 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CKind {
    Container,
    Spacer,
    Separator,
    Group,
    Label,
    Input,
    Textarea,
    Number,
    Checkbox,
    Dropdown,
    Listbox,
    Button,
    Progress,
}

/// One entry per node of the spec tree, in preorder (index = position).
#[derive(Clone, Copy)]
pub struct Ctl {
    pub kind: CKind,
    /// Null for containers / spacers.
    pub hwnd: HWND,
    /// The label static above an input-ish control (null if none).
    pub label: HWND,
    pub monospace: bool,
}

pub struct WinState {
    pub emitter: GuiEmitter,
    pub hwnd: Cell<HWND>,
    /// Current spec tree (patched in place so relayout sees visible/text/...).
    pub root: RefCell<Node>,
    pub ctls: RefCell<Vec<Ctl>>,
    pub by_id: RefCell<HashMap<String, usize>>,
    pub font: Cell<HFONT>,
    pub mono_font: Cell<HFONT>,
    pub dpi: Cell<u32>,
    /// >0 while we set control text/selection programmatically (no events).
    pub suppress: Cell<u32>,
    pub in_layout: Cell<bool>,
    /// Minimum content size in logical points.
    pub min_content: Cell<(f32, f32)>,
    pub style: u32,
    pub ex_style: u32,
    /// Preorder index of the default button (`usize::MAX` = none).
    pub default_btn: Cell<usize>,
    /// Set after the user closed the window and we hid it.
    pub destroyed: Cell<bool>,
}

thread_local! {
    static REG: RefCell<HashMap<isize, Rc<WinState>>> = RefCell::new(HashMap::new());
}

pub fn register(hwnd: HWND, st: Rc<WinState>) {
    REG.with(|r| {
        r.borrow_mut().insert(hwnd.0, st);
    });
}

pub fn lookup(hwnd: HWND) -> Option<Rc<WinState>> {
    REG.with(|r| r.borrow().get(&(hwnd.0)).cloned())
}

pub fn unregister(hwnd: HWND) -> Option<Rc<WinState>> {
    REG.with(|r| r.borrow_mut().remove(&(hwnd.0)))
}

impl WinState {
    pub fn ctl(&self, idx: usize) -> Option<Ctl> {
        self.ctls.borrow().get(idx).copied()
    }

    pub fn ctl_by_id(&self, id: &str) -> Option<(usize, Ctl)> {
        let idx = *self.by_id.borrow().get(id)?;
        self.ctl(idx).map(|c| (idx, c))
    }

    /// Run `f` with event emission suppressed.
    pub fn silently<R>(&self, f: impl FnOnce() -> R) -> R {
        self.suppress.set(self.suppress.get() + 1);
        let r = f();
        self.suppress.set(self.suppress.get() - 1);
        r
    }
}

/// Mutable access to the node at preorder `index`.
pub fn node_at_mut(root: &mut Node, index: usize) -> Option<&mut Node> {
    fn go<'a>(n: &'a mut Node, target: usize, counter: &mut usize) -> Option<&'a mut Node> {
        if *counter == target {
            return Some(n);
        }
        *counter += 1;
        let kids: &mut Vec<Node> = match &mut n.kind {
            crate::gui::spec::Kind::Row { children, .. }
            | crate::gui::spec::Kind::Column { children, .. }
            | crate::gui::spec::Kind::Grid { children, .. }
            | crate::gui::spec::Kind::Group { children, .. } => children,
            _ => return None,
        };
        for c in kids.iter_mut() {
            if let Some(f) = go(c, target, counter) {
                return Some(f);
            }
        }
        None
    }
    let mut counter = 0;
    go(root, index, &mut counter)
}
