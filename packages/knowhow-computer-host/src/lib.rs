pub mod approval;
pub mod audit;
pub mod chord;
pub mod config;
pub mod gui;
pub mod hook;
pub mod host;
pub mod hotkeys;
pub mod ipc;
pub mod proto;
pub mod security;
pub mod supervisor;
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub mod tray;
