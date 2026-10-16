
// ─── Actionable roles ─────────────────────────────────────────────────────────

export const ACTIONABLE_ROLES = new Set([
  "AXButton",
  "AXLink",
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
  "AXCheckBox",
  "AXRadioButton",
  "AXPopUpButton",
  "AXComboBox",
  "AXMenuItem",
  "AXTab",
  "AXCell",
  "AXRow",
  "AXImage",
  "AXSlider",
  "AXSegmentedControl",
  "AXDisclosureTriangle",
  // Screenshot-detected pseudo roles (see visualElements.ts)
  "VXButton",
  "VXInput",
  "VXText",
  "VXLongText",
  "VXIcon",
  "VXWord",
]);

/** Short label prefix for each role. */
export const ROLE_LABEL: Record<string, string> = {
  AXButton: "button",
  AXLink: "link",
  AXTextField: "input",
  AXTextArea: "input",
  AXSearchField: "input",
  AXCheckBox: "check",
  AXRadioButton: "radio",
  AXPopUpButton: "select",
  AXComboBox: "select",
  AXMenuItem: "item",
  AXTab: "tab",
  AXCell: "cell",
  AXRow: "row",
  AXImage: "image",
  AXSlider: "slider",
  VXButton: "button",
  VXInput: "input",
  VXText: "text",
  VXLongText: "text",
  VXIcon: "icon",
  VXWord: "text",
};

/** Score prior by role (higher = preferred). */
export const ROLE_PRIOR: Record<string, number> = {
  AXButton: 1.0,
  AXTextField: 1.0,
  AXTextArea: 0.95,
  AXSearchField: 1.0,
  AXLink: 0.9,
  AXCheckBox: 0.9,
  AXRadioButton: 0.85,
  AXPopUpButton: 0.9,
  AXComboBox: 0.9,
  AXTab: 0.8,
  AXMenuItem: 0.75,
  AXSlider: 0.8,
  AXCell: 0.6,
  AXRow: 0.55,
  AXImage: 0.5,
  VXButton: 0.9,
  VXInput: 0.9,
  VXText: 0.75,
  VXLongText: 0.3, // body copy: rarely the click target, never crowd out labels
  VXIcon: 0.55,
  VXWord: 0.3, // below buttons/text so a matching control wins over an inline word
};
