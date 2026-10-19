//! Window creation, relayout, patching, positioning.

use super::controls;
use super::measure::NativeMeasure;
use super::state::WinState;
use super::target::{FlippedView, KhPanel, Target};
use crate::gui::layout::{effective_size, layout_window, min_window_size, zip_walk, Rect, Size};
use crate::gui::spec::{Kind, Node, Patch, Position, PropsPatch, WindowSpec};
use crate::gui::GuiEmitter;
use objc2::rc::Retained;
use objc2::DefinedClass;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{
    NSBackingStoreType, NSEvent, NSFloatingWindowLevel, NSScreen, NSView, NSWindow,
    NSWindowStyleMask,
};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString};

pub struct Win {
    pub window: Retained<NSWindow>,
    pub target: Retained<Target>,
}

fn rect(r: Rect) -> NSRect {
    NSRect::new(
        NSPoint::new(r.x.round() as f64, r.y.round() as f64),
        NSSize::new(r.w.round().max(0.0) as f64, r.h.round().max(0.0) as f64),
    )
}

/// Re-run the layout engine for a content area of `w`x`h` and move the views.
pub fn relayout(st: &WinState, w: f32, h: f32) {
    let root = st.root.borrow();
    let views = st.views.borrow();
    let layout = layout_window(&root, Size { w, h }, &NativeMeasure);
    let mut i = 0usize;
    zip_walk(&root, &layout, &mut |_n, l| {
        if let Some(v) = views.get(i) {
            if let Some(m) = &v.main {
                m.setHidden(l.hidden);
                if !l.hidden {
                    m.setFrame(rect(l.frame));
                }
            }
            if let Some(lb) = &v.label {
                lb.setHidden(l.hidden || l.label_frame.is_none());
                if let (false, Some(lf)) = (l.hidden, l.label_frame) {
                    lb.setFrame(rect(lf));
                }
            }
        }
        i += 1;
    });
}

fn primary_height(mtm: MainThreadMarker) -> f64 {
    NSScreen::screens(mtm).firstObject().map(|s| s.frame().size.height).unwrap_or(900.0)
}

fn position(window: &NSWindow, pos: Option<&Position>, mtm: MainThreadMarker) {
    match pos {
        Some(Position::Xy { x, y }) => {
            // spec coords: screen points, origin top-left
            window.setFrameTopLeftPoint(NSPoint::new(*x, primary_height(mtm) - *y));
        }
        Some(Position::Named(n)) if n == "cursor" => {
            let m = NSEvent::mouseLocation();
            window.setFrameTopLeftPoint(NSPoint::new(m.x, m.y));
        }
        _ => window.center(),
    }
}

pub fn create(
    mtm: MainThreadMarker,
    spec: &WindowSpec,
    emitter: GuiEmitter,
) -> Result<Win, String> {
    let req = Size { w: spec.content_width(), h: spec.content_height() };
    let eff = effective_size(&spec.layout, req, &NativeMeasure);
    let mut style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::NonactivatingPanel;
    if spec.is_resizable() {
        style |= NSWindowStyleMask::Resizable;
    }
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(eff.w as f64, eff.h as f64));
    let panel = unsafe {
        let p: Retained<KhPanel> = objc2::msg_send![
            mtm.alloc::<KhPanel>(),
            initWithContentRect: frame,
            styleMask: style,
            backing: NSBackingStoreType::Buffered,
            defer: false
        ];
        p
    };
    panel.setHidesOnDeactivate(false);
    let window: Retained<NSWindow> = Retained::into_super(Retained::into_super(panel));
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str(&spec.title));
    if spec.is_always_on_top() {
        window.setLevel(NSFloatingWindowLevel);
    }
    let content = FlippedView::new(mtm);
    let content_view: Retained<NSView> = Retained::into_super(content);
    content_view.setFrame(frame);
    window.setContentView(Some(&content_view));
    if spec.is_resizable() {
        let min = min_window_size(&spec.layout, &NativeMeasure);
        window.setContentMinSize(NSSize::new(min.w as f64, min.h as f64));
    }
    let target = Target::new(mtm, WinState::new(emitter, spec.layout.clone()));
    {
        let st = target.ivars();
        let mut views = Vec::new();
        let mut ids = std::collections::HashMap::new();
        let mut lists = std::collections::HashMap::new();
        controls::build(mtm, &spec.layout, &target, &content_view, &mut views, &mut ids, &mut lists);
        *st.views.borrow_mut() = views;
        *st.ids.borrow_mut() = ids;
        *st.lists.borrow_mut() = lists;
        *st.content.borrow_mut() = Some(content_view.clone());
        relayout(st, eff.w, eff.h);
        // listboxes: data source now has the items; apply the initial selection silently
        let root = st.root.borrow();
        root.walk(&mut |n| {
            if let (Kind::Listbox { selected: Some(s), .. }, Some(id)) = (&n.kind, &n.id) {
                if let Some(idx) = st.ids.borrow().get(id).copied() {
                    let view = st.views.borrow().get(idx).and_then(|v| v.main.clone());
                    if let Some(view) = view {
                        let p = PropsPatch { selected: Some(*s), ..Default::default() };
                        st.silently(|| controls::apply_props(&view, n, &p, &st.lists));
                    }
                }
            }
        });
    }
    // reload tables now that the data source has its items
    window.setDelegate(Some(ProtocolObject::from_ref(&*target)));
    position(&window, spec.position.as_ref(), mtm);
    Ok(Win { window, target })
}

fn find_mut<'a>(n: &'a mut Node, id: &str) -> Option<&'a mut Node> {
    if n.id.as_deref() == Some(id) {
        return Some(n);
    }
    match &mut n.kind {
        Kind::Row { children, .. }
        | Kind::Column { children, .. }
        | Kind::Grid { children, .. }
        | Kind::Group { children, .. } => children.iter_mut().find_map(|c| find_mut(c, id)),
        _ => None,
    }
}

/// Keep the stored tree in sync (needed for relayout).
fn update_node(n: &mut Node, p: &PropsPatch) {
    if let Some(v) = p.visible {
        n.visible = Some(v);
    }
    if let Some(v) = p.enabled {
        n.enabled = Some(v);
    }
    match &mut n.kind {
        Kind::Label { text } | Kind::Button { text, .. } | Kind::Checkbox { text, .. } => {
            if let Some(t) = &p.text {
                *text = t.clone();
            }
        }
        Kind::Group { title, .. } => {
            if let Some(t) = &p.text {
                *title = Some(t.clone());
            }
        }
        Kind::Input { value, .. } => {
            if let Some(v) = p.value_str() {
                *value = Some(v);
            }
        }
        Kind::Dropdown { options, selected, .. } => {
            if let Some(o) = &p.options {
                *options = o.clone();
            }
            if p.selected.is_some() {
                *selected = p.selected;
            }
        }
        Kind::Listbox { items, selected, .. } => {
            if let Some(o) = &p.items {
                *items = o.clone();
            }
            if p.selected.is_some() {
                *selected = p.selected;
            }
        }
        _ => {}
    }
}

pub fn apply_patches(win: &Win, patches: &[Patch]) -> Result<(), String> {
    let st = win.target.ivars();
    let mut need_layout = false;
    for patch in patches {
        let idx = *st.ids.borrow().get(&patch.id).ok_or_else(|| format!("unknown control '{}'", patch.id))?;
        let node = {
            let mut root = st.root.borrow_mut();
            let n = find_mut(&mut root, &patch.id).ok_or_else(|| format!("unknown control '{}'", patch.id))?;
            update_node(n, &patch.props);
            n.clone()
        };
        if patch.props.visible.is_some() {
            need_layout = true;
        }
        let view = st.views.borrow().get(idx).and_then(|v| v.main.clone());
        if let Some(view) = view {
            let r = st.silently(|| {
                controls::apply_props(&view, &node, &patch.props, &st.lists)
            });
            need_layout |= r;
        }
    }
    if need_layout {
        let size = win.window.contentView().map(|v| v.frame().size).unwrap_or(NSSize::new(480.0, 360.0));
        st.silently(|| relayout(st, size.width as f32, size.height as f32));
    }
    Ok(())
}

pub fn focus_control(win: &Win, id: &str) -> Result<(), String> {
    let st = win.target.ivars();
    let idx = *st.ids.borrow().get(id).ok_or_else(|| format!("unknown control '{id}'"))?;
    let view = st.views.borrow().get(idx).and_then(|v| v.main.clone());
    if let Some(v) = view {
        let target_view = match st.root.borrow().find(id) {
            Some(n) => controls::inner_view(&v, &n.kind),
            None => v.clone(),
        };
        win.window.makeFirstResponder(Some(&target_view));
    }
    Ok(())
}
