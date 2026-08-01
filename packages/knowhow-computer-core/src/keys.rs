//! Unified, platform-agnostic key vocabulary. The JS layer sends key *names*
//! (e.g. "control", "enter", "a", "f5"); we parse them into a `Key` enum here,
//! and each backend maps `Key` to its native keycode. This is the single source
//! of truth for what a "key" is across macOS / Windows / Linux.

/// A resolved key. `Char` carries a single character for letter/number/symbol
/// keys; the named variants cover modifiers, navigation, function keys, etc.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
  Char(char),

  // modifiers
  Control,
  Alt,
  Shift,
  Meta, // Windows key / Command

  // whitespace / editing
  Enter,
  Tab,
  Space,
  Backspace,
  Delete,
  Escape,

  // navigation
  Left,
  Right,
  Up,
  Down,
  Home,
  End,
  PageUp,
  PageDown,

  // function keys F1..F12
  F(u8),
}

impl Key {
  /// Parse a JS-facing key name into a `Key`. Case-insensitive; accepts common
  /// aliases (ctrl/control, cmd/command/super/win → Meta, esc/escape, etc.).
  /// Returns `None` for unknown names so the caller can surface a clear error.
  pub fn parse(name: &str) -> Option<Key> {
    let n = name.trim();
    if n.chars().count() == 1 {
      // single character key (letter, digit, punctuation)
      return Some(Key::Char(n.chars().next().unwrap()));
    }
    let lower = n.to_ascii_lowercase();

    // function keys: f1..f24
    if let Some(rest) = lower.strip_prefix('f') {
      if let Ok(num) = rest.parse::<u8>() {
        if (1..=24).contains(&num) {
          return Some(Key::F(num));
        }
      }
    }

    let key = match lower.as_str() {
      "ctrl" | "control" => Key::Control,
      "alt" | "option" | "opt" => Key::Alt,
      "shift" => Key::Shift,
      "cmd" | "command" | "meta" | "super" | "win" | "windows" => Key::Meta,

      "enter" | "return" => Key::Enter,
      "tab" => Key::Tab,
      "space" | "spacebar" => Key::Space,
      "backspace" => Key::Backspace,
      "delete" | "del" => Key::Delete,
      "escape" | "esc" => Key::Escape,

      "left" | "arrowleft" => Key::Left,
      "right" | "arrowright" => Key::Right,
      "up" | "arrowup" => Key::Up,
      "down" | "arrowdown" => Key::Down,
      "home" => Key::Home,
      "end" => Key::End,
      "pageup" | "pgup" => Key::PageUp,
      "pagedown" | "pgdn" => Key::PageDown,

      _ => return None,
    };
    Some(key)
  }

  /// Parse a list of names, erroring on the first unknown one.
  pub fn parse_many(names: &[String]) -> Result<Vec<Key>, String> {
    let mut out = Vec::with_capacity(names.len());
    for name in names {
      match Key::parse(name) {
        Some(k) => out.push(k),
        None => return Err(format!("Unknown key: {name:?}")),
      }
    }
    Ok(out)
  }
}
