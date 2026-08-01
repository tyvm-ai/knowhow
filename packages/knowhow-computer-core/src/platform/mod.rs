//! Platform backend selection. Compile-time dispatch picks the native backend
//! for the target OS; unsupported targets get the `StubBackend` so the crate
//! always builds and the TS layer can fall back to the CLI-adapter driver.

use crate::backend::Backend;

pub mod stub;

#[cfg(target_os = "macos")]
pub mod macos;

/// Construct the backend for the current platform.
pub fn create_backend() -> Box<dyn Backend> {
  #[cfg(target_os = "macos")]
  {
    return Box::new(macos::MacBackend::new());
  }

  #[cfg(target_os = "windows")]
  {
    return Box::new(stub::StubBackend::new("windows"));
  }

  #[cfg(target_os = "linux")]
  {
    return Box::new(stub::StubBackend::new("linux"));
  }

  #[allow(unreachable_code)]
  Box::new(stub::StubBackend::new("unknown"))
}
