extern crate napi_build;

fn main() {
    napi_build::setup();

    // Build scripts are compiled for the HOST, so `cfg(target_os)` here would be
    // the host OS. Use the cargo-provided target OS so cross-checks work.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/platform/macos_overlay.m")
            .flag("-fobjc-arc")
            .compile("knowhow_macos_overlay");

        cc::Build::new()
            .file("src/platform/macos_stream.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .compile("knowhow_macos_stream");

        cc::Build::new()
            .file("src/platform/macos_native.m")
            .flag("-fobjc-arc")
            .compile("knowhow_macos_native");

        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        println!("cargo:rustc-link-lib=framework=Accelerate");
        println!("cargo:rerun-if-changed=src/platform/macos_overlay.m");
        println!("cargo:rerun-if-changed=src/platform/macos_stream.m");
        println!("cargo:rerun-if-changed=src/platform/macos_native.m");
    }
}
