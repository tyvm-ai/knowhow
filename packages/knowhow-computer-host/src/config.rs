//! `~/.knowhow/computer.json` and well-known paths.

use crate::chord::Chord;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DEFAULT_KILL_SWITCH: &str = "ctrl+alt+esc";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_kill")]
    pub kill_switch: String,
}

fn default_kill() -> String {
    DEFAULT_KILL_SWITCH.to_string()
}

impl Default for Config {
    fn default() -> Self {
        Config { kill_switch: default_kill() }
    }
}

pub fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

pub fn knowhow_dir() -> PathBuf {
    home_dir().join(".knowhow")
}

pub fn config_path() -> PathBuf {
    knowhow_dir().join("computer.json")
}

pub fn run_dir() -> PathBuf {
    knowhow_dir().join("run")
}

pub fn logs_dir() -> PathBuf {
    run_dir().join("logs")
}

#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    run_dir().join("host.sock")
}

/// Named pipe path for Windows: `\\.\pipe\knowhow-host-<USERNAME>`.
pub fn pipe_name() -> String {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".into());
    format!(r"\\.\pipe\knowhow-host-{user}")
}

impl Config {
    /// Parse JSON text; missing/invalid file content yields defaults.
    pub fn from_json(text: &str) -> Config {
        serde_json::from_str(text).unwrap_or_default()
    }

    pub fn load() -> Config {
        match std::fs::read_to_string(config_path()) {
            Ok(t) => Config::from_json(&t),
            Err(_) => Config::default(),
        }
    }

    /// The kill-switch chord; an unparseable value falls back to the default
    /// (the second tuple element is the warning to log).
    pub fn kill_chord(&self) -> (Chord, Option<String>) {
        match Chord::parse(&self.kill_switch) {
            Ok(c) => (c, None),
            Err(e) => (
                Chord::parse(DEFAULT_KILL_SWITCH).expect("default chord parses"),
                Some(format!(
                    "invalid killSwitch '{}' ({e}); using {DEFAULT_KILL_SWITCH}",
                    self.kill_switch
                )),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults() {
        assert_eq!(Config::from_json("").kill_switch, "ctrl+alt+esc");
        assert_eq!(Config::from_json("{}").kill_switch, "ctrl+alt+esc");
        assert_eq!(Config::from_json("garbage").kill_switch, "ctrl+alt+esc");
    }

    #[test]
    fn custom_and_invalid() {
        let c = Config::from_json(r#"{"killSwitch":"ctrl+shift+f12","other":1}"#);
        let (chord, warn) = c.kill_chord();
        assert!(warn.is_none());
        assert_eq!(chord.to_string(), "ctrl+shift+f12");

        let c = Config::from_json(r#"{"killSwitch":"nope"}"#);
        let (chord, warn) = c.kill_chord();
        assert!(warn.is_some());
        assert_eq!(chord.to_string(), "ctrl+alt+esc");
    }
}
