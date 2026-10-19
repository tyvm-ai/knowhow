//! Unsupported platforms (Linux for this milestone): the hook reports that
//! the kill switch cannot be armed.

use super::HookCtx;
use crate::chord::Key;
use crate::hotkeys::Kind;

pub fn start(_ctx: HookCtx) -> Result<(), String> {
    Err("global keyboard hook is not supported on this platform yet".into())
}

pub fn release_input(_codes: &[u32]) {}

pub fn classify(_code: u32) -> Kind {
    Kind::Other
}

pub fn code_for_key(_key: Key) -> Option<u32> {
    None
}

pub fn mod_code(_bit: u8) -> u32 {
    0
}
