//! Per-window state shared between the backend and the Objective-C target.

use crate::gui::spec::Node;
use crate::gui::GuiEmitter;
use objc2::rc::Retained;
use objc2_app_kit::NSView;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

/// Views for one node (preorder index): the control view (or box/scroll view)
/// and an optional label view placed above it.
#[derive(Default)]
pub struct NodeViews {
    pub main: Option<Retained<NSView>>,
    pub label: Option<Retained<NSView>>,
}

pub struct WinState {
    pub emitter: GuiEmitter,
    /// Set while applying programmatic patches: callbacks must not emit.
    pub silent: Cell<bool>,
    /// The (patched) spec tree, used for relayout.
    pub root: RefCell<Node>,
    /// Indexed by preorder position in `root`.
    pub views: RefCell<Vec<NodeViews>>,
    pub ids: RefCell<HashMap<String, usize>>,
    /// Listbox items by control id (table data source).
    pub lists: RefCell<HashMap<String, Vec<String>>>,
    pub content: RefCell<Option<Retained<NSView>>>,
}

impl WinState {
    pub fn new(emitter: GuiEmitter, root: Node) -> WinState {
        WinState {
            emitter,
            silent: Cell::new(false),
            root: RefCell::new(root),
            views: RefCell::new(Vec::new()),
            ids: RefCell::new(HashMap::new()),
            lists: RefCell::new(HashMap::new()),
            content: RefCell::new(None),
        }
    }

    /// Run `f` with event emission suppressed.
    pub fn silently<R>(&self, f: impl FnOnce() -> R) -> R {
        let prev = self.silent.replace(true);
        let r = f();
        self.silent.set(prev);
        r
    }
}
