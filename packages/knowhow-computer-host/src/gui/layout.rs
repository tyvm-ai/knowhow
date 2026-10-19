//! Platform-independent layout engine. Computes frames (logical points,
//! top-left origin, relative to the window content area) for a [`Node`] tree.
//!
//! Rules (see E0 spec):
//! * root padding 12, default gap 8; `row`/`column`/`grid`/`group`.
//! * `grow` children absorb extra main-axis space proportionally; `spacer`
//!   defaults to `grow: 1`.
//! * Cross axis: children stretch unless `align` is given or a fixed
//!   `width`/`height` is set. Single-line controls (label, button, checkbox,
//!   input, number, dropdown, progress) never stretch *vertically* by default
//!   (they keep their natural height, aligned start); textarea/listbox/containers do.
//! * `label` on input-ish controls is laid out above the control (4pt gap):
//!   [`LayoutNode::label_frame`] + [`LayoutNode::frame`] (the control).
//! * `visible:false` nodes take no space (zero frame, `hidden = true`).
//! * Group: titled box; children stacked as a column inside a 10pt inset
//!   (extra top inset for the title).

use super::spec::{Align, Kind, Node};
use std::collections::HashMap;

pub const ROOT_PADDING: f32 = 12.0;
pub const DEFAULT_GAP: f32 = 8.0;
pub const LABEL_GAP: f32 = 4.0;
pub const GROUP_PAD: f32 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Size {
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }
    pub fn right(&self) -> f32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }
    pub fn inset(&self, l: f32, t: f32, r: f32, b: f32) -> Rect {
        Rect::new(self.x + l, self.y + t, (self.w - l - r).max(0.0), (self.h - t - b).max(0.0))
    }
}

/// Text / control measurement supplied by the platform backend.
pub trait Measure {
    /// Size of `text` (may contain `\n`) in the UI font.
    fn text_size(&self, text: &str, monospace: bool) -> Size;
    /// Natural size of a control, *excluding* its above-label. Containers are
    /// never passed here. Override for pixel-accurate native sizes.
    fn control_size(&self, node: &Node) -> Size {
        default_control_size(self, node)
    }
}

/// Approximate measurer: 7px per char, 22px per line.
#[derive(Debug, Clone, Copy, Default)]
pub struct ApproxMeasure;

impl Measure for ApproxMeasure {
    fn text_size(&self, text: &str, _monospace: bool) -> Size {
        let lines = text.split('\n');
        let mut w = 0usize;
        let mut n = 0usize;
        for l in lines {
            w = w.max(l.chars().count());
            n += 1;
        }
        Size { w: w as f32 * 7.0, h: n as f32 * 22.0 }
    }
}

/// Default per-kind intrinsic sizes (buttons min 80x28, input h 24,
/// dropdown h 26, listbox/textarea min h 80, progress h 16, checkbox h 20).
pub fn default_control_size<M: Measure + ?Sized>(m: &M, node: &Node) -> Size {
    let t = |s: &str| m.text_size(s, false);
    match &node.kind {
        Kind::Label { text } => t(text),
        Kind::Button { text, .. } => {
            let s = t(text);
            Size { w: (s.w + 24.0).max(80.0), h: 28.0 }
        }
        Kind::Checkbox { text, .. } => Size { w: t(text).w + 24.0, h: 20.0 },
        Kind::Input { value, placeholder, .. } => {
            let s = value.as_deref().filter(|v| !v.is_empty()).or(placeholder.as_deref()).unwrap_or("");
            Size { w: (t(s).w + 16.0).max(120.0), h: 24.0 }
        }
        Kind::Number { .. } => Size { w: 100.0, h: 24.0 },
        Kind::Dropdown { options, .. } => {
            let w = options.iter().map(|o| t(o).w).fold(0.0, f32::max);
            Size { w: (w + 32.0).max(120.0), h: 26.0 }
        }
        Kind::Listbox { items, .. } => {
            let w = items.iter().map(|o| t(o).w).fold(0.0, f32::max);
            Size { w: (w + 24.0).max(120.0), h: 80.0 }
        }
        Kind::Textarea { monospace, .. } => {
            let _ = monospace;
            Size { w: 160.0, h: 80.0 }
        }
        Kind::Progress { .. } => Size { w: 120.0, h: 16.0 },
        Kind::Separator => Size { w: 1.0, h: 1.0 },
        Kind::Spacer => Size { w: 0.0, h: 0.0 },
        _ => Size::default(),
    }
}

/// Layout result, mirroring the node tree (`children[i]` ↔ `node.children()[i]`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LayoutNode {
    /// The node's frame. For a control with a `label`, this is the *control*
    /// frame (below the label).
    pub frame: Rect,
    /// Frame of the label above an input-ish control.
    pub label_frame: Option<Rect>,
    /// `visible:false`: zero frame, takes no space (descendants too).
    pub hidden: bool,
    pub children: Vec<LayoutNode>,
}

fn single_line(k: &Kind) -> bool {
    matches!(
        k,
        Kind::Label { .. }
            | Kind::Button { .. }
            | Kind::Checkbox { .. }
            | Kind::Input { .. }
            | Kind::Number { .. }
            | Kind::Dropdown { .. }
            | Kind::Progress { .. }
    )
}

fn grow_of(n: &Node) -> f32 {
    match (n.grow, &n.kind) {
        (Some(g), _) => g.max(0.0),
        (None, Kind::Spacer) => 1.0,
        _ => 0.0,
    }
}

fn gap_of(n: &Node) -> f32 {
    match &n.kind {
        Kind::Row { gap, .. } | Kind::Column { gap, .. } | Kind::Grid { gap, .. } => gap.unwrap_or(DEFAULT_GAP),
        _ => DEFAULT_GAP,
    }
}

fn padding_of(n: &Node) -> f32 {
    match &n.kind {
        Kind::Row { padding, .. } | Kind::Column { padding, .. } => padding.unwrap_or(0.0),
        _ => 0.0,
    }
}

/// (left, top, right, bottom) inset of a group box.
fn group_inset(title: Option<&str>, m: &dyn Measure) -> (f32, f32, f32, f32) {
    let top = match title.filter(|t| !t.is_empty()) {
        Some(t) => m.text_size(t, false).h + 6.0,
        None => GROUP_PAD,
    };
    (GROUP_PAD, top, GROUP_PAD, GROUP_PAD)
}

fn sum_gaps(n: usize, gap: f32) -> f32 {
    if n > 1 {
        gap * (n - 1) as f32
    } else {
        0.0
    }
}

/// Natural size of a node (fixed `width`/`height` override), (0,0) when hidden.
fn base_size(n: &Node, m: &dyn Measure) -> Size {
    if !n.is_visible() {
        return Size::default();
    }
    let mut s = content_size(n, m);
    if let Some(w) = n.width {
        s.w = w;
    }
    if let Some(h) = n.height {
        s.h = h;
    }
    s
}

fn visible_children(n: &Node) -> Vec<&Node> {
    n.children().iter().filter(|c| c.is_visible()).collect()
}

fn content_size(n: &Node, m: &dyn Measure) -> Size {
    match &n.kind {
        Kind::Row { .. } | Kind::Column { .. } => {
            let horiz = matches!(n.kind, Kind::Row { .. });
            let kids = visible_children(n);
            let p = padding_of(n);
            let (mut main, mut cross) = (0.0f32, 0.0f32);
            for c in &kids {
                let s = base_size(c, m);
                let (cm, cc) = if horiz { (s.w, s.h) } else { (s.h, s.w) };
                main += cm;
                cross = cross.max(cc);
            }
            main += sum_gaps(kids.len(), gap_of(n)) + 2.0 * p;
            cross += 2.0 * p;
            if horiz {
                Size { w: main, h: cross }
            } else {
                Size { w: cross, h: main }
            }
        }
        Kind::Grid { .. } => {
            let g = grid_tracks(n, m);
            Size {
                w: g.cols.iter().sum::<f32>() + sum_gaps(g.cols.len(), gap_of(n)),
                h: g.rows.iter().sum::<f32>() + sum_gaps(g.rows.len(), gap_of(n)),
            }
        }
        Kind::Group { title, .. } => {
            let (l, t, r, b) = group_inset(title.as_deref(), m);
            let kids = visible_children(n);
            let (mut w, mut h) = (0.0f32, 0.0f32);
            for c in &kids {
                let s = base_size(c, m);
                w = w.max(s.w);
                h += s.h;
            }
            h += sum_gaps(kids.len(), DEFAULT_GAP);
            let tw = title.as_deref().map(|t| m.text_size(t, false).w + 16.0).unwrap_or(0.0);
            Size { w: (w + l + r).max(tw), h: h + t + b }
        }
        _ => {
            let c = m.control_size(n);
            match n.kind.label() {
                Some(l) => {
                    let ls = m.text_size(l, false);
                    Size { w: c.w.max(ls.w), h: ls.h + LABEL_GAP + c.h }
                }
                None => c,
            }
        }
    }
}


// ---------------------------------------------------------------- grid

struct GridTracks {
    cols: Vec<f32>,
    rows: Vec<f32>,
    col_w: Vec<f32>,
    row_w: Vec<f32>,
    /// per child index: (col, row, span); None when hidden.
    cells: Vec<Option<(usize, usize, usize)>>,
}

fn grid_tracks(n: &Node, m: &dyn Measure) -> GridTracks {
    let columns = match &n.kind {
        Kind::Grid { columns, .. } => (*columns).max(1),
        _ => 1,
    };
    let kids = n.children();
    let mut cells = vec![None; kids.len()];
    let (mut col, mut row) = (0usize, 0usize);
    let (mut ncols, mut nrows) = (0usize, 0usize);
    for (i, c) in kids.iter().enumerate() {
        if !c.is_visible() {
            continue;
        }
        let span = c.col_span.unwrap_or(1).clamp(1, columns);
        if col + span > columns {
            col = 0;
            row += 1;
        }
        cells[i] = Some((col, row, span));
        ncols = ncols.max(col + span);
        nrows = nrows.max(row + 1);
        col += span;
        if col >= columns {
            col = 0;
            row += 1;
        }
    }
    let gap = gap_of(n);
    let mut cols = vec![0.0f32; ncols];
    let mut rows = vec![0.0f32; nrows];
    let mut col_w = vec![0.0f32; ncols];
    let mut row_w = vec![0.0f32; nrows];
    for (i, c) in kids.iter().enumerate() {
        if let Some((cc, r, span)) = cells[i] {
            let b = base_size(c, m);
            let g = grow_of(c);
            rows[r] = rows[r].max(b.h);
            row_w[r] = row_w[r].max(g);
            if span == 1 {
                cols[cc] = cols[cc].max(b.w);
                col_w[cc] = col_w[cc].max(g);
            } else {
                col_w[cc + span - 1] = col_w[cc + span - 1].max(g);
            }
        }
    }
    // spanning cells: widen the last spanned column if the span is too narrow
    for (i, c) in kids.iter().enumerate() {
        if let Some((cc, _, span)) = cells[i] {
            if span > 1 {
                let have: f32 = cols[cc..cc + span].iter().sum::<f32>() + gap * (span - 1) as f32;
                let need = base_size(c, m).w;
                if need > have {
                    cols[cc + span - 1] += need - have;
                }
            }
        }
    }
    GridTracks { cols, rows, col_w, row_w, cells }
}

/// Give extra space (beyond the sum of `base`) to entries by `weights`.
fn distribute(base: &[f32], weights: &[f32], avail: f32) -> Vec<f32> {
    let total: f32 = base.iter().sum();
    let wsum: f32 = weights.iter().sum();
    let extra = avail - total;
    if extra > 0.0 && wsum > 0.0 {
        base.iter().zip(weights).map(|(b, w)| b + extra * w / wsum).collect()
    } else {
        base.to_vec()
    }
}

fn place_grid(n: &Node, rect: Rect, m: &dyn Measure) -> Vec<LayoutNode> {
    let g = grid_tracks(n, m);
    let gap = gap_of(n);
    let cols = distribute(&g.cols, &g.col_w, rect.w - sum_gaps(g.cols.len(), gap));
    let rows = distribute(&g.rows, &g.row_w, rect.h - sum_gaps(g.rows.len(), gap));
    let mut xs = Vec::new();
    let mut x = rect.x;
    for w in &cols {
        xs.push(x);
        x += w + gap;
    }
    let mut ys = Vec::new();
    let mut y = rect.y;
    for h in &rows {
        ys.push(y);
        y += h + gap;
    }
    n.children()
        .iter()
        .enumerate()
        .map(|(i, c)| match g.cells[i] {
            None => hidden_node(c),
            Some((cc, r, span)) => {
                let w: f32 = cols[cc..cc + span].iter().sum::<f32>() + gap * (span - 1) as f32;
                let cell = Rect::new(xs[cc], ys[r], w, rows[r]);
                let fr = fit(c, cell, base_size(c, m), false, false);
                layout_node(c, fr, m)
            }
        })
        .collect()
}

// ---------------------------------------------------------------- placement

fn resolve_align(n: &Node, horizontal: bool) -> Align {
    if let Some(a) = n.align {
        return a;
    }
    let stretch = if horizontal {
        n.width.is_none()
    } else {
        n.height.is_none() && !single_line(&n.kind)
    };
    if stretch {
        Align::Stretch
    } else {
        Align::Start
    }
}

fn axis(pos: f32, len: f32, base: f32, a: Align) -> (f32, f32) {
    let b = base.min(len);
    match a {
        Align::Stretch => (pos, len),
        Align::Start => (pos, b),
        Align::Center => (pos + (len - b) / 2.0, b),
        Align::End => (pos + len - b, b),
    }
}

/// Place `n` inside `cell`; `force_w`/`force_h` = main axis (fills the cell).
fn fit(n: &Node, cell: Rect, base: Size, force_w: bool, force_h: bool) -> Rect {
    let (x, w) = if force_w { (cell.x, cell.w) } else { axis(cell.x, cell.w, base.w, resolve_align(n, true)) };
    let (y, h) = if force_h { (cell.y, cell.h) } else { axis(cell.y, cell.h, base.h, resolve_align(n, false)) };
    Rect::new(x, y, w, h)
}

fn hidden_node(n: &Node) -> LayoutNode {
    LayoutNode {
        frame: Rect::default(),
        label_frame: None,
        hidden: true,
        children: n.children().iter().map(hidden_node).collect(),
    }
}

fn place_linear(n: &Node, rect: Rect, horiz: bool, pad: f32, gap: f32, m: &dyn Measure) -> Vec<LayoutNode> {
    let inner = rect.inset(pad, pad, pad, pad);
    let kids = n.children();
    let vis: Vec<usize> = (0..kids.len()).filter(|&i| kids[i].is_visible()).collect();
    let bases: Vec<f32> = vis
        .iter()
        .map(|&i| {
            let s = base_size(&kids[i], m);
            if horiz {
                s.w
            } else {
                s.h
            }
        })
        .collect();
    let weights: Vec<f32> = vis.iter().map(|&i| grow_of(&kids[i])).collect();
    let main_len = if horiz { inner.w } else { inner.h };
    let sizes = distribute(&bases, &weights, main_len - sum_gaps(vis.len(), gap));
    let mut out: Vec<LayoutNode> = kids.iter().map(hidden_node).collect();
    let mut pos = if horiz { inner.x } else { inner.y };
    for (k, &i) in vis.iter().enumerate() {
        let c = &kids[i];
        let cell = if horiz {
            Rect::new(pos, inner.y, sizes[k], inner.h)
        } else {
            Rect::new(inner.x, pos, inner.w, sizes[k])
        };
        let fr = fit(c, cell, base_size(c, m), horiz, !horiz);
        out[i] = layout_node(c, fr, m);
        pos += sizes[k] + gap;
    }
    out
}

fn layout_node(n: &Node, frame: Rect, m: &dyn Measure) -> LayoutNode {
    if !n.is_visible() {
        return hidden_node(n);
    }
    let mut out = LayoutNode { frame, label_frame: None, hidden: false, children: Vec::new() };
    match &n.kind {
        Kind::Row { .. } => out.children = place_linear(n, frame, true, padding_of(n), gap_of(n), m),
        Kind::Column { .. } => out.children = place_linear(n, frame, false, padding_of(n), gap_of(n), m),
        Kind::Grid { .. } => out.children = place_grid(n, frame, m),
        Kind::Group { title, .. } => {
            let (l, t, r, b) = group_inset(title.as_deref(), m);
            out.children = place_linear(n, frame.inset(l, t, r, b), false, 0.0, DEFAULT_GAP, m);
        }
        _ => {
            if let Some(label) = n.kind.label() {
                let lh = m.text_size(label, false).h;
                out.label_frame = Some(Rect::new(frame.x, frame.y, frame.w, lh));
                let rest = (frame.h - lh - LABEL_GAP).max(0.0);
                let ch = if single_line(&n.kind) { m.control_size(n).h.min(rest) } else { rest };
                out.frame = Rect::new(frame.x, frame.y + lh + LABEL_GAP, frame.w, ch);
            }
        }
    }
    out
}

// ---------------------------------------------------------------- public API

/// Lay out the whole window for a content area of `content` (root padding 12).
pub fn layout_window(root: &Node, content: Size, m: &dyn Measure) -> LayoutNode {
    let rect = Rect::new(ROOT_PADDING, ROOT_PADDING, content.w - 2.0 * ROOT_PADDING, content.h - 2.0 * ROOT_PADDING);
    layout_node(root, Rect::new(rect.x, rect.y, rect.w.max(0.0), rect.h.max(0.0)), m)
}

/// Minimum content size (natural size of the tree + root padding).
pub fn min_window_size(root: &Node, m: &dyn Measure) -> Size {
    let s = content_size(root, m);
    Size { w: s.w + 2.0 * ROOT_PADDING, h: s.h + 2.0 * ROOT_PADDING }
}

/// Content size to use: the requested one, but never below the minimum.
pub fn effective_size(root: &Node, requested: Size, m: &dyn Measure) -> Size {
    let min = min_window_size(root, m);
    Size { w: requested.w.max(min.w), h: requested.h.max(min.h) }
}

/// Walk a node tree and its layout in lock-step (preorder).
pub fn zip_walk<'a>(n: &'a Node, l: &'a LayoutNode, f: &mut dyn FnMut(&'a Node, &'a LayoutNode)) {
    f(n, l);
    for (c, lc) in n.children().iter().zip(l.children.iter()) {
        zip_walk(c, lc, f);
    }
}

/// `id -> (control frame, label frame)` for every node that has an id.
pub fn frames_by_id(root: &Node, l: &LayoutNode) -> HashMap<String, (Rect, Option<Rect>)> {
    let mut map = HashMap::new();
    zip_walk(root, l, &mut |n, ln| {
        if let Some(id) = &n.id {
            map.insert(id.clone(), (ln.frame, ln.label_frame));
        }
    });
    map
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn node(v: Value) -> Node {
        serde_json::from_value(v).unwrap()
    }

    fn lay(v: Value, w: f32, h: f32) -> (Node, LayoutNode) {
        let n = node(v);
        let l = layout_window(&n, Size { w, h }, &ApproxMeasure);
        (n, l)
    }

    fn r(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect::new(x, y, w, h)
    }

    fn close(a: Rect, b: Rect) {
        let d = (a.x - b.x).abs() + (a.y - b.y).abs() + (a.w - b.w).abs() + (a.h - b.h).abs();
        assert!(d < 0.01, "{a:?} != {b:?}");
    }

    fn poecraft() -> Value {
        json!({"type": "row", "children": [
            {"type": "column", "width": 300, "children": [
                {"type": "input", "id": "primary", "label": "Primary"},
                {"type": "listbox", "id": "history", "label": "History", "grow": 1}
            ]},
            {"type": "column", "grow": 1, "children": [
                {"type": "textarea", "id": "notes", "grow": 1},
                {"type": "row", "id": "buttons", "children": [
                    {"type": "button", "id": "ok", "text": "OK"},
                    {"type": "button", "id": "cancel", "text": "Cancel"}
                ]}
            ]}
        ]})
    }

    #[test]
    fn poecraft_two_column_layout() {
        let (n, l) = lay(poecraft(), 800.0, 600.0);
        let f = frames_by_id(&n, &l);
        // left column: fixed 300 wide, full height
        close(l.children[0].frame, r(12.0, 12.0, 300.0, 576.0));
        // right column grows: 800-12-(12+300+8)
        close(l.children[1].frame, r(320.0, 12.0, 468.0, 576.0));
        // labelled input: label above, 24 high control below
        close(f["primary"].1.unwrap(), r(12.0, 12.0, 300.0, 22.0));
        close(f["primary"].0, r(12.0, 38.0, 300.0, 24.0));
        // listbox absorbs the rest: item y 70..588
        close(f["history"].1.unwrap(), r(12.0, 70.0, 300.0, 22.0));
        close(f["history"].0, r(12.0, 96.0, 300.0, 492.0));
        // textarea grows, buttons row pinned at the bottom
        close(f["notes"].0, r(320.0, 12.0, 468.0, 540.0));
        close(f["buttons"].0, r(320.0, 560.0, 468.0, 28.0));
        close(f["ok"].0, r(320.0, 560.0, 80.0, 28.0));
        close(f["cancel"].0, r(408.0, 560.0, 80.0, 28.0));
    }

    #[test]
    fn min_size_of_poecraft_layout() {
        let n = node(poecraft());
        let min = min_window_size(&n, &ApproxMeasure);
        assert_eq!(min, Size { w: 500.0, h: 188.0 });
        let eff = effective_size(&n, Size { w: 100.0, h: 900.0 }, &ApproxMeasure);
        assert_eq!(eff, Size { w: 500.0, h: 900.0 });
    }

    #[test]
    fn hidden_nodes_take_no_space() {
        let (n, l) = lay(
            json!({"type": "column", "children": [
                {"type": "label", "text": "a"},
                {"type": "label", "text": "b", "visible": false},
                {"type": "label", "text": "c"}
            ]}),
            200.0,
            200.0,
        );
        assert!(!l.children[0].hidden);
        assert!(l.children[1].hidden);
        assert_eq!(l.children[1].frame, Rect::default());
        close(l.children[0].frame, r(12.0, 12.0, 176.0, 22.0));
        close(l.children[2].frame, r(12.0, 42.0, 176.0, 22.0));
        assert_eq!(min_window_size(&n, &ApproxMeasure).h, 12.0 + 22.0 + 8.0 + 22.0 + 12.0);
    }

    #[test]
    fn hidden_container_zeroes_descendants() {
        let (_, l) = lay(
            json!({"type": "row", "children": [
                {"type": "column", "visible": false, "children": [{"type": "button", "text": "x"}]},
                {"type": "button", "text": "y"}
            ]}),
            300.0,
            100.0,
        );
        assert!(l.children[0].hidden && l.children[0].children[0].hidden);
        close(l.children[1].frame, r(12.0, 12.0, 80.0, 28.0));
    }

    #[test]
    fn grid_with_colspan() {
        let (n, l) = lay(
            json!({"type": "grid", "columns": 2, "children": [
                {"type": "label", "text": "Name"},
                {"type": "input", "id": "i"},
                {"type": "label", "text": "Longer label"},
                {"type": "dropdown", "id": "d", "options": ["a"]},
                {"type": "button", "id": "b", "text": "Go", "colSpan": 2}
            ]}),
            400.0,
            300.0,
        );
        let f = frames_by_id(&n, &l);
        close(l.children[0].frame, r(12.0, 12.0, 84.0, 22.0));
        close(f["i"].0, r(104.0, 12.0, 120.0, 24.0));
        close(f["d"].0, r(104.0, 44.0, 120.0, 26.0));
        close(f["b"].0, r(12.0, 78.0, 212.0, 28.0));
        assert_eq!(min_window_size(&n, &ApproxMeasure), Size { w: 24.0 + 212.0, h: 24.0 + 24.0 + 8.0 + 26.0 + 8.0 + 28.0 });
    }

    #[test]
    fn grid_growing_column() {
        let (n, l) = lay(
            json!({"type": "grid", "columns": 2, "children": [
                {"type": "label", "text": "Name"},
                {"type": "input", "id": "i", "grow": 1}
            ]}),
            400.0,
            300.0,
        );
        let f = frames_by_id(&n, &l);
        // total width 376; col0 = 28, gap 8 -> col1 = 340
        close(f["i"].0, r(12.0 + 28.0 + 8.0, 12.0, 340.0, 24.0));
    }

    #[test]
    fn nested_rows_and_gap() {
        let (_, l) = lay(
            json!({"type": "column", "children": [
                {"type": "row", "gap": 4, "children": [
                    {"type": "label", "text": "ab"}, {"type": "label", "text": "cd"}]},
                {"type": "label", "text": "x"}
            ]}),
            300.0,
            200.0,
        );
        close(l.children[0].frame, r(12.0, 12.0, 276.0, 22.0));
        close(l.children[0].children[0].frame, r(12.0, 12.0, 14.0, 22.0));
        close(l.children[0].children[1].frame, r(30.0, 12.0, 14.0, 22.0));
        close(l.children[1].frame, r(12.0, 42.0, 276.0, 22.0));
    }

    #[test]
    fn group_insets_title() {
        let (_, l) = lay(
            json!({"type": "column", "children": [
                {"type": "group", "title": "G", "children": [{"type": "button", "text": "b"}]}
            ]}),
            300.0,
            200.0,
        );
        let g = &l.children[0];
        close(g.frame, r(12.0, 12.0, 276.0, 66.0));
        close(g.children[0].frame, r(22.0, 40.0, 256.0, 28.0));
    }

    #[test]
    fn spacer_absorbs_space() {
        let (_, l) = lay(
            json!({"type": "row", "children": [
                {"type": "button", "text": "a"}, {"type": "spacer"}, {"type": "button", "text": "b"}]}),
            400.0,
            100.0,
        );
        close(l.children[1].frame, r(100.0, 12.0, 200.0, 76.0));
        close(l.children[2].frame, r(308.0, 12.0, 80.0, 28.0));
    }

    #[test]
    fn align_and_fixed_sizes() {
        let (_, l) = lay(
            json!({"type": "column", "children": [
                {"type": "button", "text": "a", "width": 100, "align": "end"},
                {"type": "button", "text": "b", "width": 100, "align": "center"},
                {"type": "textarea", "height": 50}
            ]}),
            300.0,
            300.0,
        );
        close(l.children[0].frame, r(188.0, 12.0, 100.0, 28.0));
        close(l.children[1].frame, r(100.0, 48.0, 100.0, 28.0));
        // fixed width wins over stretch: textarea stretches horizontally, h fixed
        close(l.children[2].frame, r(12.0, 84.0, 276.0, 50.0));
    }

    #[test]
    fn row_children_stretch_vertically_except_single_line() {
        let (_, l) = lay(
            json!({"type": "row", "children": [
                {"type": "listbox", "items": []}, {"type": "button", "text": "b"}]}),
            400.0,
            300.0,
        );
        close(l.children[0].frame, r(12.0, 12.0, 120.0, 276.0));
        close(l.children[1].frame, r(140.0, 12.0, 80.0, 28.0));
    }

    #[test]
    fn two_growers_share_by_weight() {
        let (_, l) = lay(
            json!({"type": "row", "gap": 0, "children": [
                {"type": "listbox", "items": [], "grow": 1, "width": 0},
                {"type": "listbox", "items": [], "grow": 3, "width": 0}]}),
            424.0,
            100.0,
        );
        close(l.children[0].frame, r(12.0, 12.0, 100.0, 76.0));
        close(l.children[1].frame, r(112.0, 12.0, 300.0, 76.0));
    }

    #[test]
    fn root_padding_option_and_leaf_root() {
        let (_, l) = lay(json!({"type": "column", "padding": 5, "children": [{"type": "label", "text": "a"}]}), 200.0, 100.0);
        close(l.children[0].frame, r(17.0, 17.0, 166.0, 22.0));
        let (_, l) = lay(json!({"type": "textarea"}), 200.0, 100.0);
        close(l.frame, r(12.0, 12.0, 176.0, 76.0));
    }

    #[test]
    fn approx_measure_and_default_sizes() {
        let m = ApproxMeasure;
        assert_eq!(m.text_size("abc", false), Size { w: 21.0, h: 22.0 });
        assert_eq!(m.text_size("ab\nabcd", false), Size { w: 28.0, h: 44.0 });
        let sz = |v: Value| m.control_size(&node(v));
        assert_eq!(sz(json!({"type": "button", "text": "x"})), Size { w: 80.0, h: 28.0 });
        assert_eq!(sz(json!({"type": "input"})).h, 24.0);
        assert_eq!(sz(json!({"type": "dropdown", "options": []})).h, 26.0);
        assert_eq!(sz(json!({"type": "listbox", "items": []})).h, 80.0);
        assert_eq!(sz(json!({"type": "textarea"})).h, 80.0);
        assert_eq!(sz(json!({"type": "progress"})).h, 16.0);
        assert_eq!(sz(json!({"type": "checkbox", "text": "ab"})), Size { w: 38.0, h: 20.0 });
    }
}
