//! Embeds an application manifest (comctl32 v6 visual styles + per-monitor-v2
//! DPI awareness) into the Windows MSVC binary via linker arguments. Does
//! nothing on other targets; `cargo check` never links, so cross-checking is
//! unaffected.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=assets/windows.manifest");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os == "windows" && env == "msvc" {
        let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
        println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-bins=/MANIFESTINPUT:{dir}/assets/windows.manifest");
    }
}
