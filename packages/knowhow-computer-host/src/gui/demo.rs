//! Built-in demo form for `--gui-demo`: every control kind, poecraft-like
//! two-column layout (left: inputs + growing history list, right: growing
//! notes + button row).

pub const DEMO_SPEC: &str = r#"{
  "title": "knowhow GUI demo",
  "width": 760, "height": 520, "resizable": true, "alwaysOnTop": false,
  "closeBehavior": "hide", "position": "center",
  "layout": {
    "type": "row", "gap": 12, "children": [
      { "type": "column", "width": 300, "children": [
        { "type": "label", "id": "status", "text": "Status: IDLE" },
        { "type": "input", "id": "primaryInput", "label": "Primary match", "placeholder": "e.g. +# to maximum Life" },
        { "type": "input", "id": "secret", "label": "Password", "password": true },
        { "type": "number", "id": "count", "label": "Attempts", "value": 3, "min": 0, "max": 99, "step": 1 },
        { "type": "dropdown", "id": "presetDropdown", "label": "Preset", "options": ["Default", "Fast", "Careful"], "selected": 0 },
        { "type": "checkbox", "id": "enabled", "text": "Enabled", "checked": true },
        { "type": "progress", "id": "progress", "value": 40, "max": 100 },
        { "type": "listbox", "id": "historyList", "label": "History", "grow": 1,
          "items": ["alpha", "beta", "gamma"], "selected": 0 }
      ]},
      { "type": "column", "grow": 1, "children": [
        { "type": "group", "title": "Options", "children": [
          { "type": "grid", "columns": 2, "children": [
            { "type": "label", "text": "Delay (ms)" },
            { "type": "number", "id": "delay", "value": 50 },
            { "type": "label", "text": "Mode" },
            { "type": "dropdown", "id": "mode", "options": ["a", "b"], "selected": -1 },
            { "type": "checkbox", "id": "wrap", "text": "Wrap notes", "checked": true, "colSpan": 2 }
          ]}
        ]},
        { "type": "separator" },
        { "type": "textarea", "id": "notes", "label": "Notes", "grow": 1, "wrap": true, "monospace": true, "value": "hello" },
        { "type": "textarea", "id": "log", "height": 60, "readOnly": true, "value": "read-only log" },
        { "type": "row", "children": [
          { "type": "button", "id": "saveBtn", "text": "Save", "default": true },
          { "type": "button", "id": "clearBtn", "text": "Clear" },
          { "type": "spacer" },
          { "type": "label", "id": "hidden", "text": "never shown", "visible": false },
          { "type": "button", "id": "closeBtn", "text": "Close" }
        ]}
      ]}
    ]
  }
}"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gui::layout::*;
    use crate::gui::spec::{validate, WindowSpec};

    #[test]
    fn demo_spec_parses_and_lays_out() {
        let spec: WindowSpec = serde_json::from_str(DEMO_SPEC).unwrap();
        validate(&spec).unwrap();
        let min = min_window_size(&spec.layout, &ApproxMeasure);
        let size = effective_size(
            &spec.layout,
            Size { w: spec.content_width(), h: spec.content_height() },
            &ApproxMeasure,
        );
        assert!(size.w >= min.w && size.h >= min.h);
        let l = layout_window(&spec.layout, size, &ApproxMeasure);
        let f = frames_by_id(&spec.layout, &l);
        // left column fixed, history list grows to the bottom
        assert_eq!(f["historyList"].0.w, 300.0);
        assert!((f["historyList"].0.bottom() - (size.h - ROOT_PADDING)).abs() < 0.01);
        // right notes grow; hidden label takes no space
        assert!(f["notes"].0.h > 100.0);
        assert_eq!(f["hidden"].0, Rect::default());
        // close button is pushed to the right edge by the spacer
        assert!((f["closeBtn"].0.right() - (size.w - ROOT_PADDING)).abs() < 0.01);
    }
}
