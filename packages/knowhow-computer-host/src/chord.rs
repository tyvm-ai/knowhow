//! Chord vocabulary: modifiers + a single non-modifier key, parsed from strings
//! such as `ctrl+alt+esc`, `mod+shift+k`, `f6`.

use std::fmt;

pub const CTRL: u8 = 1;
pub const ALT: u8 = 2;
pub const SHIFT: u8 = 4;
pub const META: u8 = 8;

/// Bit set of modifiers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Mods(pub u8);

impl Mods {
    pub fn has(self, bit: u8) -> bool {
        self.0 & bit != 0
    }
    pub fn insert(&mut self, bit: u8) {
        self.0 |= bit;
    }
    pub fn remove(&mut self, bit: u8) {
        self.0 &= !bit;
    }
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }
    /// True if every modifier in `other` is also in `self`.
    pub fn contains(self, other: Mods) -> bool {
        self.0 & other.0 == other.0
    }
}

/// A non-modifier key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    /// a-z (lowercase) or 0-9
    Char(char),
    F(u8),
    Esc,
    Enter,
    Space,
    Tab,
    Backspace,
    Delete,
    Insert,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
}

impl Key {
    /// Parse a key name (not a modifier). Case-insensitive.
    pub fn parse(name: &str) -> Option<Key> {
        let n = name.trim().to_ascii_lowercase();
        if n.chars().count() == 1 {
            let c = n.chars().next().unwrap();
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                return Some(Key::Char(c));
            }
        }
        if let Some(rest) = n.strip_prefix('f') {
            if let Ok(num) = rest.parse::<u8>() {
                if (1..=24).contains(&num) {
                    return Some(Key::F(num));
                }
            }
        }
        Some(match n.as_str() {
            "esc" | "escape" => Key::Esc,
            "enter" | "return" => Key::Enter,
            "space" | "spacebar" => Key::Space,
            "tab" => Key::Tab,
            "backspace" => Key::Backspace,
            "delete" | "del" => Key::Delete,
            "insert" | "ins" => Key::Insert,
            "left" | "arrowleft" => Key::Left,
            "right" | "arrowright" => Key::Right,
            "up" | "arrowup" => Key::Up,
            "down" | "arrowdown" => Key::Down,
            "home" => Key::Home,
            "end" => Key::End,
            "pgup" | "pageup" => Key::PageUp,
            "pgdn" | "pagedown" => Key::PageDown,
            _ => return None,
        })
    }

    /// Normalized display name (what `--print-keys` prints).
    pub fn name(self) -> String {
        match self {
            Key::Char(c) => c.to_string(),
            Key::F(n) => format!("f{n}"),
            Key::Esc => "esc".into(),
            Key::Enter => "enter".into(),
            Key::Space => "space".into(),
            Key::Tab => "tab".into(),
            Key::Backspace => "backspace".into(),
            Key::Delete => "delete".into(),
            Key::Insert => "insert".into(),
            Key::Left => "left".into(),
            Key::Right => "right".into(),
            Key::Up => "up".into(),
            Key::Down => "down".into(),
            Key::Home => "home".into(),
            Key::End => "end".into(),
            Key::PageUp => "pgup".into(),
            Key::PageDown => "pgdn".into(),
        }
    }
}

/// Parse a modifier token. `mod` resolves per `is_mac`.
pub fn parse_modifier(tok: &str, is_mac: bool) -> Option<u8> {
    match tok {
        "ctrl" | "control" => Some(CTRL),
        "alt" | "option" | "opt" => Some(ALT),
        "shift" => Some(SHIFT),
        "cmd" | "command" | "meta" | "win" | "windows" | "super" => Some(META),
        "mod" => Some(if is_mac { META } else { CTRL }),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Chord {
    pub mods: Mods,
    pub key: Key,
}

impl Chord {
    /// Parse using the current OS for `mod`.
    pub fn parse(s: &str) -> Result<Chord, String> {
        Chord::parse_for(s, cfg!(target_os = "macos"))
    }

    pub fn parse_for(s: &str, is_mac: bool) -> Result<Chord, String> {
        let lower = s.trim().to_ascii_lowercase();
        if lower.is_empty() {
            return Err("empty chord".into());
        }
        // A trailing "+" would mean the key is '+', which we don't support.
        let toks: Vec<&str> = lower.split('+').map(|t| t.trim()).collect();
        let mut mods = Mods::default();
        let mut key: Option<Key> = None;
        for tok in toks {
            if tok.is_empty() {
                return Err(format!("malformed chord '{s}'"));
            }
            if let Some(m) = parse_modifier(tok, is_mac) {
                mods.insert(m);
            } else if let Some(k) = Key::parse(tok) {
                if key.is_some() {
                    return Err(format!("chord '{s}' has more than one non-modifier key"));
                }
                key = Some(k);
            } else {
                return Err(format!("unknown key '{tok}' in chord '{s}'"));
            }
        }
        match key {
            Some(key) => Ok(Chord { mods, key }),
            None => Err(format!("chord '{s}' has no non-modifier key")),
        }
    }
}

impl fmt::Display for Chord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.mods.has(CTRL) {
            write!(f, "ctrl+")?;
        }
        if self.mods.has(ALT) {
            write!(f, "alt+")?;
        }
        if self.mods.has(SHIFT) {
            write!(f, "shift+")?;
        }
        if self.mods.has(META) {
            write!(f, "meta+")?;
        }
        write!(f, "{}", self.key.name())
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_kill_switch() {
        let c = Chord::parse("ctrl+alt+esc").unwrap();
        assert_eq!(c.key, Key::Esc);
        assert!(c.mods.has(CTRL) && c.mods.has(ALT) && !c.mods.has(SHIFT));
    }

    #[test]
    fn aliases_and_case() {
        let c = Chord::parse_for("Control+Option+Escape", true).unwrap();
        assert_eq!(c, Chord::parse("ctrl+alt+esc").unwrap());
        let c = Chord::parse_for("CMD+Shift+K", false).unwrap();
        assert!(c.mods.has(META) && c.mods.has(SHIFT));
        assert_eq!(c.key, Key::Char('k'));
        for n in ["win", "super", "meta", "cmd"] {
            assert_eq!(parse_modifier(n, false), Some(META));
        }
    }

    #[test]
    fn mod_alias_is_per_os() {
        assert!(Chord::parse_for("mod+c", true).unwrap().mods.has(META));
        assert!(Chord::parse_for("mod+c", false).unwrap().mods.has(CTRL));
    }

    #[test]
    fn named_keys() {
        for (s, k) in [
            ("f1", Key::F(1)),
            ("f24", Key::F(24)),
            ("enter", Key::Enter),
            ("space", Key::Space),
            ("tab", Key::Tab),
            ("left", Key::Left),
            ("pgup", Key::PageUp),
            ("pgdn", Key::PageDown),
            ("home", Key::Home),
            ("end", Key::End),
            ("insert", Key::Insert),
            ("delete", Key::Delete),
            ("backspace", Key::Backspace),
            ("7", Key::Char('7')),
        ] {
            assert_eq!(Key::parse(s), Some(k), "{s}");
            assert_eq!(Key::parse(&k.name()), Some(k), "roundtrip {s}");
        }
        assert_eq!(Key::parse("f25"), None);
    }

    #[test]
    fn bare_key_ok_and_errors() {
        let c = Chord::parse("f6").unwrap();
        assert!(c.mods.is_empty());
        assert!(Chord::parse("").is_err());
        assert!(Chord::parse("ctrl+alt").is_err());
        assert!(Chord::parse("ctrl+a+b").is_err());
        assert!(Chord::parse("ctrl+bogus").is_err());
        assert!(Chord::parse("ctrl++a").is_err());
    }

    #[test]
    fn display() {
        assert_eq!(Chord::parse("alt+ctrl+esc").unwrap().to_string(), "ctrl+alt+esc");
    }
}
