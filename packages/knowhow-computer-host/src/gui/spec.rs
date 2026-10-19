//! Serde types for the E0 form spec (WindowSpec / Node) and prop patches.
//! Tolerant: unknown fields are ignored (the TS side already validates).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Start,
    Center,
    End,
    Stretch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    Hide,
    Exit,
    Destroy,
}

/// `"center"` | `"cursor"` | `{x, y}`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Position {
    Named(String),
    Xy { x: f64, y: f64 },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSpec {
    #[serde(default)]
    pub title: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub resizable: Option<bool>,
    pub always_on_top: Option<bool>,
    pub close_behavior: Option<CloseBehavior>,
    pub position: Option<Position>,
    pub layout: Node,
}

impl WindowSpec {
    pub fn content_width(&self) -> f32 {
        self.width.unwrap_or(480.0) as f32
    }
    pub fn content_height(&self) -> f32 {
        self.height.unwrap_or(360.0) as f32
    }
    pub fn is_resizable(&self) -> bool {
        self.resizable.unwrap_or(true)
    }
    pub fn is_always_on_top(&self) -> bool {
        self.always_on_top.unwrap_or(false)
    }
}

/// One layout node: common props + the per-type payload.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: Option<String>,
    pub grow: Option<f32>,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub align: Option<Align>,
    pub enabled: Option<bool>,
    pub visible: Option<bool>,
    /// Only meaningful for grid children.
    pub col_span: Option<usize>,
    #[serde(flatten)]
    pub kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Kind {
    Row {
        #[serde(default)]
        children: Vec<Node>,
        gap: Option<f32>,
        padding: Option<f32>,
    },
    Column {
        #[serde(default)]
        children: Vec<Node>,
        gap: Option<f32>,
        padding: Option<f32>,
    },
    Grid {
        columns: usize,
        #[serde(default)]
        children: Vec<Node>,
        gap: Option<f32>,
    },
    Group {
        title: Option<String>,
        #[serde(default)]
        children: Vec<Node>,
    },
    Spacer,
    Separator,
    Label {
        #[serde(default)]
        text: String,
    },
    Input {
        label: Option<String>,
        value: Option<String>,
        placeholder: Option<String>,
        password: Option<bool>,
    },
    Textarea {
        label: Option<String>,
        value: Option<String>,
        read_only: Option<bool>,
        wrap: Option<bool>,
        monospace: Option<bool>,
    },
    Number {
        label: Option<String>,
        value: Option<f64>,
        min: Option<f64>,
        max: Option<f64>,
        step: Option<f64>,
    },
    Checkbox {
        #[serde(default)]
        text: String,
        checked: Option<bool>,
    },
    Dropdown {
        label: Option<String>,
        #[serde(default)]
        options: Vec<String>,
        selected: Option<i64>,
    },
    Listbox {
        label: Option<String>,
        #[serde(default)]
        items: Vec<String>,
        selected: Option<i64>,
    },
    Button {
        #[serde(default)]
        text: String,
        #[serde(rename = "default")]
        is_default: Option<bool>,
    },
    Progress {
        value: Option<f64>,
        max: Option<f64>,
    },
}

impl Kind {
    pub fn children(&self) -> &[Node] {
        match self {
            Kind::Row { children, .. }
            | Kind::Column { children, .. }
            | Kind::Grid { children, .. }
            | Kind::Group { children, .. } => children,
            _ => &[],
        }
    }

    pub fn is_container(&self) -> bool {
        matches!(self, Kind::Row { .. } | Kind::Column { .. } | Kind::Grid { .. } | Kind::Group { .. })
    }

    /// The `label` shown above input-ish controls.
    pub fn label(&self) -> Option<&str> {
        match self {
            Kind::Input { label, .. }
            | Kind::Textarea { label, .. }
            | Kind::Number { label, .. }
            | Kind::Dropdown { label, .. }
            | Kind::Listbox { label, .. } => label.as_deref().filter(|l| !l.is_empty()),
            _ => None,
        }
    }

    /// Short type name as used on the wire (`"row"`, `"button"`, ...).
    pub fn name(&self) -> &'static str {
        match self {
            Kind::Row { .. } => "row",
            Kind::Column { .. } => "column",
            Kind::Grid { .. } => "grid",
            Kind::Group { .. } => "group",
            Kind::Spacer => "spacer",
            Kind::Separator => "separator",
            Kind::Label { .. } => "label",
            Kind::Input { .. } => "input",
            Kind::Textarea { .. } => "textarea",
            Kind::Number { .. } => "number",
            Kind::Checkbox { .. } => "checkbox",
            Kind::Dropdown { .. } => "dropdown",
            Kind::Listbox { .. } => "listbox",
            Kind::Button { .. } => "button",
            Kind::Progress { .. } => "progress",
        }
    }
}

impl Node {
    pub fn is_visible(&self) -> bool {
        self.visible.unwrap_or(true)
    }
    pub fn is_enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }
    pub fn children(&self) -> &[Node] {
        self.kind.children()
    }

    /// Depth-first walk (self first) over every node, including hidden ones.
    pub fn walk<'a>(&'a self, f: &mut dyn FnMut(&'a Node)) {
        f(self);
        for c in self.children() {
            c.walk(f);
        }
    }

    pub fn find(&self, id: &str) -> Option<&Node> {
        if self.id.as_deref() == Some(id) {
            return Some(self);
        }
        self.children().iter().find_map(|c| c.find(id))
    }
}

/// One entry of a `guiPatch`: `{id, props}`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct Patch {
    pub id: String,
    #[serde(default)]
    pub props: PropsPatch,
}

/// Patchable props. Unknown props are ignored. Setting them is silent
/// (backends must not emit change/select events for programmatic changes).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
pub struct PropsPatch {
    pub text: Option<String>,
    /// string (input/textarea) or number (number/progress).
    pub value: Option<Value>,
    pub options: Option<Vec<String>>,
    pub items: Option<Vec<String>>,
    pub selected: Option<i64>,
    pub checked: Option<bool>,
    pub enabled: Option<bool>,
    pub visible: Option<bool>,
    pub max: Option<f64>,
}

impl PropsPatch {
    /// `value` as a string (numbers are formatted).
    pub fn value_str(&self) -> Option<String> {
        match self.value.as_ref()? {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        }
    }
    pub fn value_f64(&self) -> Option<f64> {
        match self.value.as_ref()? {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.parse().ok(),
            _ => None,
        }
    }
    pub fn is_empty(&self) -> bool {
        *self == PropsPatch::default()
    }
}

/// Validate structural invariants the adapters rely on.
pub fn validate(spec: &WindowSpec) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    let mut err: Option<String> = None;
    spec.layout.walk(&mut |n| {
        if let Some(id) = &n.id {
            if !seen.insert(id.clone()) && err.is_none() {
                err = Some(format!("duplicate control id '{id}'"));
            }
        }
        if let Kind::Grid { columns, .. } = &n.kind {
            if *columns == 0 && err.is_none() {
                err = Some("grid.columns must be >= 1".into());
            }
        }
    });
    match err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_every_kind_and_ignores_unknown_fields() {
        let spec: WindowSpec = serde_json::from_value(json!({
            "title": "T", "width": 600, "bogus": 1, "position": {"x": 1, "y": 2},
            "layout": {"type": "column", "futureProp": true, "children": [
                {"type": "label", "text": "hi", "grow": 1},
                {"type": "input", "id": "i", "label": "L", "value": "v", "password": true},
                {"type": "textarea", "readOnly": true, "monospace": true},
                {"type": "number", "value": 3, "min": 0, "max": 10, "step": 0.5},
                {"type": "checkbox", "text": "c", "checked": true},
                {"type": "dropdown", "options": ["a", "b"], "selected": -1},
                {"type": "listbox", "items": ["x"], "selected": 0},
                {"type": "button", "text": "ok", "default": true},
                {"type": "progress", "value": 5, "max": 10},
                {"type": "spacer"}, {"type": "separator"},
                {"type": "group", "title": "G", "children": [{"type": "label", "text": "n"}]},
                {"type": "grid", "columns": 2, "children": [{"type": "label", "text": "a", "colSpan": 2}]},
                {"type": "row", "gap": 4, "padding": 2, "visible": false, "children": []}
            ]}
        }))
        .unwrap();
        assert_eq!(spec.title, "T");
        assert_eq!(spec.position, Some(Position::Xy { x: 1.0, y: 2.0 }));
        let kids = spec.layout.children();
        assert_eq!(kids.len(), 14);
        assert_eq!(kids[0].grow, Some(1.0));
        assert!(matches!(&kids[7].kind, Kind::Button { is_default: Some(true), .. }));
        assert_eq!(kids[11].children().len(), 1);
        assert_eq!(kids[12].children()[0].col_span, Some(2));
        assert!(!kids[13].is_visible());
        assert_eq!(kids[1].kind.label(), Some("L"));
        assert!(validate(&spec).is_ok());
    }

    #[test]
    fn named_position_and_defaults() {
        let spec: WindowSpec = serde_json::from_value(json!({
            "title": "x", "position": "cursor", "layout": {"type": "spacer"}
        }))
        .unwrap();
        assert_eq!(spec.position, Some(Position::Named("cursor".into())));
        assert_eq!(spec.content_width(), 480.0);
        assert_eq!(spec.content_height(), 360.0);
        assert!(spec.is_resizable());
        assert!(!spec.is_always_on_top());
    }

    #[test]
    fn unknown_type_is_an_error_and_duplicates_are_caught() {
        assert!(serde_json::from_value::<WindowSpec>(json!({
            "title": "x", "layout": {"type": "nope"}
        }))
        .is_err());
        let spec: WindowSpec = serde_json::from_value(json!({
            "title": "x", "layout": {"type": "row", "children": [
                {"type": "label", "id": "a", "text": ""}, {"type": "label", "id": "a", "text": ""}]}
        }))
        .unwrap();
        assert!(validate(&spec).unwrap_err().contains("duplicate"));
    }

    #[test]
    fn patches_parse() {
        let p: Vec<Patch> = serde_json::from_value(json!([
            {"id": "s", "props": {"text": "Status", "enabled": false, "selected": -1, "zzz": 1}},
            {"id": "n", "props": {"value": 4}}
        ]))
        .unwrap();
        assert_eq!(p[0].props.text.as_deref(), Some("Status"));
        assert_eq!(p[0].props.selected, Some(-1));
        assert_eq!(p[1].props.value_f64(), Some(4.0));
        assert_eq!(p[1].props.value_str().as_deref(), Some("4"));
        assert!(PropsPatch::default().is_empty());
    }
}
