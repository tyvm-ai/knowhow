extern crate napi_build;

fn main() {
    napi_build::setup();

    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/platform/macos_overlay.m")
            .flag("-fobjc-arc")
            .compile("knowhow_macos_overlay");

        cc::Build::new()
            .file("src/platform/macos_stream.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .compile("knowhow_macos_stream");

        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=ScreenCaptureKit");
        println!("cargo:rustc-link-lib=framework=CoreMedia");
        println!("cargo:rustc-link-lib=framework=Accelerate");
        println!("cargo:rerun-if-changed=src/platform/macos_overlay.m");
        println!("cargo:rerun-if-changed=src/platform/macos_stream.m");
    }
}
