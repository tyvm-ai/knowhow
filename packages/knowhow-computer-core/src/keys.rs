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
    Insert,
    CapsLock,

    // navigation
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,

    // function keys F1..F24
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
            "insert" | "ins" => Key::Insert,
            "capslock" | "caps" => Key::CapsLock,

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

    /// Canonical JS-facing name for this key (round-trips through `parse`).
    pub fn name(&self) -> String {
        match self {
            Key::Char(c) => c.to_string(),
            Key::Control => "control".into(),
            Key::Alt => "alt".into(),
            Key::Shift => "shift".into(),
            Key::Meta => "meta".into(),
            Key::Enter => "enter".into(),
            Key::Tab => "tab".into(),
            Key::Space => "space".into(),
            Key::Backspace => "backspace".into(),
            Key::Delete => "delete".into(),
            Key::Escape => "escape".into(),
            Key::Insert => "insert".into(),
            Key::CapsLock => "capslock".into(),
            Key::Left => "left".into(),
            Key::Right => "right".into(),
            Key::Up => "up".into(),
            Key::Down => "down".into(),
            Key::Home => "home".into(),
            Key::End => "end".into(),
            Key::PageUp => "pageup".into(),
            Key::PageDown => "pagedown".into(),
            Key::F(n) => format!("f{n}"),
        }
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

/// Canonical names of every named (non-character) key, e.g. for docs/validation.
pub fn all_names() -> Vec<String> {
    let mut v: Vec<String> = [
        Key::Control,
        Key::Alt,
        Key::Shift,
        Key::Meta,
        Key::Enter,
        Key::Tab,
        Key::Space,
        Key::Backspace,
        Key::Delete,
        Key::Escape,
        Key::Insert,
        Key::CapsLock,
        Key::Left,
        Key::Right,
        Key::Up,
        Key::Down,
        Key::Home,
        Key::End,
        Key::PageUp,
        Key::PageDown,
    ]
    .iter()
    .map(|k| k.name())
    .collect();
    v.extend((1..=24).map(|n| format!("f{n}")));
    v
}

/// Parse a chord string such as `"ctrl+alt+esc"` or `"cmd+shift+4"` into
/// `(modifiers/leading keys, final key)`. The last `+`-separated token is the
/// main key; everything before it is held first. A literal plus key is written
/// as a trailing `++` (e.g. `"ctrl++"`) or bare `"+"`. Returns `None` when the
/// string is empty or contains an unknown key name.
pub fn parse_chord(s: &str) -> Option<(Vec<Key>, Key)> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (head, last): (&str, &str) = if s == "+" {
        ("", "+")
    } else if let Some(h) = s.strip_suffix("++") {
        (h, "+")
    } else if let Some(idx) = s.rfind('+') {
        (&s[..idx], &s[idx + 1..])
    } else {
        ("", s)
    };
    let last_key = Key::parse(last)?;
    let mut mods = Vec::new();
    if !head.is_empty() {
        for part in head.split('+') {
            mods.push(Key::parse(part)?);
        }
    }
    Some((mods, last_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_chords() {
        assert_eq!(
            parse_chord("ctrl+alt+esc"),
            Some((vec![Key::Control, Key::Alt], Key::Escape))
        );
        assert_eq!(parse_chord("F13"), Some((vec![], Key::F(13))));
        assert_eq!(
            parse_chord("Cmd+Shift+4"),
            Some((vec![Key::Meta, Key::Shift], Key::Char('4')))
        );
    }

    #[test]
    fn parses_plus_key() {
        assert_eq!(parse_chord("ctrl++"), Some((vec![Key::Control], Key::Char('+'))));
        assert_eq!(parse_chord("+"), Some((vec![], Key::Char('+'))));
    }

    #[test]
    fn rejects_bad_chords() {
        assert_eq!(parse_chord(""), None);
        assert_eq!(parse_chord("ctrl+bogus"), None);
        assert_eq!(parse_chord("bogus+a"), None);
        assert_eq!(parse_chord("ctrl+"), None);
    }

    #[test]
    fn names_round_trip() {
        for n in all_names() {
            let k = Key::parse(&n).expect(&n);
            assert_eq!(k.name(), n);
        }
        assert_eq!(Key::parse("insert"), Some(Key::Insert));
        assert_eq!(Key::parse("capslock"), Some(Key::CapsLock));
        assert_eq!(Key::parse("f24"), Some(Key::F(24)));
    }
}
