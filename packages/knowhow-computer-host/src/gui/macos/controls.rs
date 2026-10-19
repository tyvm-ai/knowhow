//! Building AppKit views from spec nodes, and reading / patching them.

use super::measure::{mono_font, ui_font};
use super::state::NodeViews;
use super::target::Target;
use crate::gui::spec::{Kind, Node, PropsPatch};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{sel, MainThreadOnly, Message};
use objc2_app_kit::{
    NSBezelStyle, NSBox, NSBoxType, NSButton, NSControl, NSControlStateValueOff,
    NSControlStateValueOn, NSPopUpButton, NSProgressIndicator, NSProgressIndicatorStyle,
    NSScrollView, NSSecureTextField, NSTableColumn, NSTableView, NSTextField, NSTextView,
    NSUserInterfaceItemIdentification, NSView,
};
use objc2_foundation::{
    ns_string, MainThreadMarker, NSArray, NSIndexSet, NSPoint, NSRect, NSSize, NSString,
};

const NUMBER_TAG: isize = 7001;

/// Reinterpret a view as a concrete AppKit class (caller knows the kind).
fn cast<T>(v: &NSView) -> &T {
    unsafe { &*(v as *const NSView as *const T) }
}

fn upcast<T: objc2::Message>(t: &Retained<T>) -> Retained<NSView> {
    // SAFETY: only called with NSView subclasses.
    unsafe { Retained::cast_unchecked::<NSView>(t.clone()) }
}

pub fn button_checked(v: &NSView) -> bool {
    unsafe { cast::<NSButton>(v).state() == NSControlStateValueOn }
}

pub fn popup_index(v: &NSView) -> i64 {
    unsafe { cast::<NSPopUpButton>(v).indexOfSelectedItem() as i64 }
}

pub fn field_string(v: &NSView) -> String {
    unsafe { cast::<NSTextField>(v).stringValue() }.to_string()
}

pub fn is_number_field(v: &NSView) -> bool {
    unsafe { cast::<NSControl>(v).tag() == NUMBER_TAG }
}

pub fn fmt_number(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        format!("{}", x)
    }
}

fn zero() -> NSRect {
    NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(100.0, 24.0))
}

fn set_id(v: &NSView, id: Option<&str>) {
    if let Some(id) = id {
        unsafe { v.setIdentifier(Some(&NSString::from_str(id))) };
    }
}

fn label_view(mtm: MainThreadMarker, text: &str) -> Retained<NSView> {
    let l = unsafe { NSTextField::labelWithString(&NSString::from_str(text), mtm) };
    upcast(&l)
}

fn set_ta(c: &NSControl, target: &Target, action: objc2::runtime::Sel) {
    let t: &AnyObject = target.as_ref();
    unsafe {
        c.setTarget(Some(t));
        c.setAction(Some(action));
    }
}

/// Build the views for `node` and its subtree (preorder), adding them to
/// `parent`. `views` receives one entry per node, in preorder.
pub fn build(
    mtm: MainThreadMarker,
    node: &Node,
    target: &Retained<Target>,
    parent: &NSView,
    views: &mut Vec<NodeViews>,
    ids: &mut std::collections::HashMap<String, usize>,
    lists: &mut std::collections::HashMap<String, Vec<String>>,
) {
    let index = views.len();
    views.push(NodeViews::default());
    if let Some(id) = &node.id {
        ids.insert(id.clone(), index);
    }
    let idr = node.id.as_deref();
    let label = node.kind.label().map(|l| label_view(mtm, l));
    let main: Option<Retained<NSView>> = match &node.kind {
        Kind::Group { title, .. } => {
            let b = unsafe { NSBox::new(mtm) };
            unsafe {
                b.setTitle(&NSString::from_str(title.as_deref().unwrap_or("")));
                if title.is_none() {
                    b.setTitlePosition(objc2_app_kit::NSTitlePosition::NoTitle);
                }
            }
            Some(upcast(&b))
        }
        Kind::Separator => {
            let b = unsafe { NSBox::new(mtm) };
            unsafe { b.setBoxType(NSBoxType::Separator) };
            Some(upcast(&b))
        }
        Kind::Label { text } => Some(label_view(mtm, text)),
        Kind::Input { value, placeholder, password, .. } => {
            let f: Retained<NSTextField> = if password.unwrap_or(false) {
                let s = unsafe { NSSecureTextField::initWithFrame(NSSecureTextField::alloc(mtm), zero()) };
                Retained::into_super(s)
            } else {
                unsafe { NSTextField::textFieldWithString(&NSString::from_str(value.as_deref().unwrap_or("")), mtm) }
            };
            unsafe {
                f.setStringValue(&NSString::from_str(value.as_deref().unwrap_or("")));
                if let Some(p) = placeholder {
                    f.setPlaceholderString(Some(&NSString::from_str(p)));
                }
                f.setDelegate(Some(ProtocolObject::from_ref(&**target)));
            }
            Some(upcast(&f))
        }
        Kind::Number { value, .. } => {
            let s = value.map(fmt_number).unwrap_or_default();
            let f = unsafe { NSTextField::textFieldWithString(&NSString::from_str(&s), mtm) };
            unsafe {
                f.setTag(NUMBER_TAG);
                f.setDelegate(Some(ProtocolObject::from_ref(&**target)));
            }
            Some(upcast(&f))
        }
        Kind::Checkbox { text, checked } => {
            let t: &AnyObject = target.as_ref();
            let b = unsafe {
                NSButton::checkboxWithTitle_target_action(
                    &NSString::from_str(text),
                    Some(t),
                    Some(sel!(checkChanged:)),
                    mtm,
                )
            };
            unsafe {
                b.setState(if checked.unwrap_or(false) { NSControlStateValueOn } else { NSControlStateValueOff })
            };
            Some(upcast(&b))
        }
        Kind::Button { text, is_default } => {
            let t: &AnyObject = target.as_ref();
            let b = unsafe {
                NSButton::buttonWithTitle_target_action(
                    &NSString::from_str(text),
                    Some(t),
                    Some(sel!(buttonClicked:)),
                    mtm,
                )
            };
            unsafe {
                b.setBezelStyle(NSBezelStyle::Push);
                if is_default.unwrap_or(false) {
                    b.setKeyEquivalent(ns_string!("\r"));
                }
            }
            Some(upcast(&b))
        }
        Kind::Dropdown { options, selected, .. } => {
            let p = unsafe { NSPopUpButton::initWithFrame_pullsDown(NSPopUpButton::alloc(mtm), zero(), false) };
            set_options(&p, options, *selected);
            set_ta(&p, target, sel!(popupChanged:));
            Some(upcast(&p))
        }
        Kind::Progress { value, max } => {
            let p = unsafe { NSProgressIndicator::new(mtm) };
            unsafe {
                p.setStyle(NSProgressIndicatorStyle::Bar);
                p.setIndeterminate(false);
                p.setMinValue(0.0);
                p.setMaxValue(max.unwrap_or(100.0));
                p.setDoubleValue(value.unwrap_or(0.0));
            }
            Some(upcast(&p))
        }
        Kind::Textarea { value, read_only, wrap, monospace, .. } => {
            Some(build_textarea(mtm, target, value.as_deref().unwrap_or(""), *read_only, *wrap, *monospace, idr))
        }
        Kind::Listbox { items, .. } => {
            if let Some(id) = idr {
                lists.insert(id.to_string(), items.clone());
            }
            Some(build_listbox(mtm, target, idr))
        }
        _ => None,
    };
    if let Some(m) = &main {
        // the identifier lives on the document view for scroll-based controls
        if !matches!(node.kind, Kind::Textarea { .. } | Kind::Listbox { .. }) {
            set_id(m, idr);
        }
        if let Some(c) = m.downcast_ref::<NSControl>() {
            unsafe { c.setEnabled(node.is_enabled()) };
        }
        parent.addSubview(m);
    }
    if let Some(l) = &label {
        parent.addSubview(l);
    }
    views[index] = NodeViews { main, label };
    for c in node.children() {
        build(mtm, c, target, parent, views, ids, lists);
    }
}


fn set_options(p: &NSPopUpButton, options: &[String], selected: Option<i64>) {
    unsafe {
        p.removeAllItems();
        let titles: Vec<Retained<NSString>> = options.iter().map(|o| NSString::from_str(o)).collect();
        let arr = NSArray::from_retained_slice(&titles);
        p.addItemsWithTitles(&arr);
        match selected {
            Some(i) if i >= 0 && (i as usize) < options.len() => p.selectItemAtIndex(i as isize),
            _ => p.selectItemAtIndex(if options.is_empty() { -1 } else { 0 }),
        }
    }
}

fn build_textarea(
    mtm: MainThreadMarker,
    target: &Retained<Target>,
    value: &str,
    read_only: Option<bool>,
    wrap: Option<bool>,
    monospace: Option<bool>,
    id: Option<&str>,
) -> Retained<NSView> {
    let wrap = wrap.unwrap_or(true);
    let sv = unsafe { NSScrollView::new(mtm) };
    let tv = unsafe { NSTextView::initWithFrame(NSTextView::alloc(mtm), zero()) };
    unsafe {
        sv.setHasVerticalScroller(true);
        sv.setHasHorizontalScroller(!wrap);
        sv.setBorderType(objc2_app_kit::NSBorderType::BezelBorder);
        tv.setRichText(false);
        tv.setEditable(!read_only.unwrap_or(false));
        tv.setSelectable(true);
        tv.setAutomaticQuoteSubstitutionEnabled(false);
        tv.setAutomaticDashSubstitutionEnabled(false);
        tv.setAutomaticTextReplacementEnabled(false);
        let font = if monospace.unwrap_or(false) { mono_font() } else { ui_font() };
        tv.setFont(Some(&font));
        tv.setVerticallyResizable(true);
        tv.setHorizontallyResizable(!wrap);
        tv.setMaxSize(NSSize::new(f64::MAX, f64::MAX));
        if let Some(tc) = tv.textContainer() {
            tc.setWidthTracksTextView(wrap);
            if !wrap {
                tc.setContainerSize(NSSize::new(f64::MAX, f64::MAX));
            }
        }
        tv.setString(&NSString::from_str(value));
        tv.setDelegate(Some(ProtocolObject::from_ref(&**target)));
        sv.setDocumentView(Some(&tv));
    }
    let tvv: &NSView = &tv;
    set_id(tvv, id);
    upcast(&sv)
}

fn build_listbox(
    mtm: MainThreadMarker,
    target: &Retained<Target>,
    id: Option<&str>,
) -> Retained<NSView> {
    let sv = unsafe { NSScrollView::new(mtm) };
    let tb = unsafe { NSTableView::initWithFrame(NSTableView::alloc(mtm), zero()) };
    unsafe {
        let col = NSTableColumn::initWithIdentifier(NSTableColumn::alloc(mtm), ns_string!("c"));
        col.setResizingMask(objc2_app_kit::NSTableColumnResizingOptions::AutoresizingMask);
        tb.addTableColumn(&col);
        tb.setHeaderView(None);
        tb.setAllowsEmptySelection(true);
        tb.setAllowsMultipleSelection(false);
        tb.setColumnAutoresizingStyle(objc2_app_kit::NSTableViewColumnAutoresizingStyle::UniformColumnAutoresizingStyle);
        let ds: &ProtocolObject<dyn objc2_app_kit::NSTableViewDataSource> = ProtocolObject::from_ref(&**target);
        tb.setDataSource(Some(ds));
        sv.setHasVerticalScroller(true);
        sv.setBorderType(objc2_app_kit::NSBorderType::BezelBorder);
        sv.setDocumentView(Some(&tb));
    }
    let tbv: &NSView = &tb;
    set_id(tbv, id);
    unsafe { tb.setDelegate(Some(ProtocolObject::from_ref(&**target))) };
    upcast(&sv)
}

/// The control view that carries events/values (scroll views → document view).
pub fn inner_view(v: &NSView, kind: &Kind) -> Retained<NSView> {
    match kind {
        Kind::Textarea { .. } | Kind::Listbox { .. } => {
            let sv: &NSScrollView = cast(v);
            unsafe { sv.documentView() }.unwrap_or_else(|| v.retain())
        }
        _ => v.retain(),
    }
}

/// Apply the non-layout props of `p` to the view of `node` (silent: the
/// caller holds the `silently` guard). Returns true if the layout may change.
pub fn apply_props(
    view: &NSView,
    node: &Node,
    p: &PropsPatch,
    lists: &std::cell::RefCell<std::collections::HashMap<String, Vec<String>>>,
) -> bool {
    let mut relayout = false;
    let inner = inner_view(view, &node.kind);
    unsafe {
        if let Some(en) = p.enabled {
            if let Some(c) = inner.downcast_ref::<NSControl>() {
                c.setEnabled(en);
            }
        }
        match &node.kind {
            Kind::Label { .. } => {
                if let Some(t) = &p.text {
                    cast::<NSTextField>(view).setStringValue(&NSString::from_str(t));
                    relayout = true;
                }
            }
            Kind::Button { .. } | Kind::Checkbox { .. } => {
                let b = cast::<NSButton>(view);
                if let Some(t) = &p.text {
                    b.setTitle(&NSString::from_str(t));
                    relayout = true;
                }
                if let Some(c) = p.checked {
                    b.setState(if c { NSControlStateValueOn } else { NSControlStateValueOff });
                }
            }
            Kind::Input { .. } => {
                if let Some(v) = p.value_str() {
                    cast::<NSTextField>(view).setStringValue(&NSString::from_str(&v));
                }
            }
            Kind::Number { .. } => {
                if let Some(x) = p.value_f64() {
                    cast::<NSTextField>(view).setStringValue(&NSString::from_str(&fmt_number(x)));
                } else if let Some(v) = p.value_str() {
                    cast::<NSTextField>(view).setStringValue(&NSString::from_str(&v));
                }
            }
            Kind::Textarea { .. } => {
                if let Some(v) = p.value_str() {
                    cast::<NSTextView>(&inner).setString(&NSString::from_str(&v));
                }
            }
            Kind::Dropdown { .. } => {
                let pb = cast::<NSPopUpButton>(view);
                if let Some(o) = &p.options {
                    set_options(pb, o, p.selected);
                    relayout = true;
                } else if let Some(s) = p.selected {
                    pb.selectItemAtIndex(s as isize);
                }
            }
            Kind::Listbox { .. } => {
                let tb = cast::<NSTableView>(&inner);
                if let (Some(items), Some(id)) = (&p.items, node.id.as_ref()) {
                    // release the borrow before reloadData (data source re-borrows)
                    lists.borrow_mut().insert(id.clone(), items.clone());
                    tb.reloadData();
                    relayout = true;
                }
                if let Some(s) = p.selected {
                    if s < 0 {
                        tb.deselectAll(None);
                    } else {
                        tb.selectRowIndexes_byExtendingSelection(&NSIndexSet::indexSetWithIndex(s as usize), false);
                        tb.scrollRowToVisible(s as isize);
                    }
                }
            }
            Kind::Progress { .. } => {
                let pi = cast::<NSProgressIndicator>(view);
                if let Some(m) = p.max {
                    pi.setMaxValue(m);
                }
                if let Some(x) = p.value_f64() {
                    pi.setDoubleValue(x);
                }
            }
            Kind::Group { .. } => {
                if let Some(t) = &p.text {
                    cast::<NSBox>(view).setTitle(&NSString::from_str(t));
                }
            }
            _ => {}
        }
    }
    relayout
}
