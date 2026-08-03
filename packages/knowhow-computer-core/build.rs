extern crate napi_build;

fn main() {
    napi_build::setup();

    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/platform/macos_overlay.m")
            .flag("-fobjc-arc")
            .compile("knowhow_macos_overlay");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rerun-if-changed=src/platform/macos_overlay.m");
    }
}
