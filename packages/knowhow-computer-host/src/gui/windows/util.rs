//! Small Win32 helpers: wide strings, DPI, fonts, text get/set.

use ::windows::core::PCWSTR;
use ::windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use ::windows::Win32::Graphics::Gdi::{CreateFontIndirectW, DeleteObject, HFONT, HGDIOBJ, LOGFONTW};
use ::windows::Win32::UI::HiDpi::{GetDpiForWindow, SystemParametersInfoForDpi};
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetWindowTextLengthW, GetWindowTextW, SendMessageW, SetWindowTextW, NONCLIENTMETRICSW,
    SPI_GETNONCLIENTMETRICS, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WM_SETFONT,
};

/// UTF-16, NUL-terminated.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn pcwstr(v: &[u16]) -> PCWSTR {
    PCWSTR(v.as_ptr())
}

/// DPI of `hwnd` (96 when unknown).
pub fn dpi_of(hwnd: HWND) -> u32 {
    let d = unsafe { GetDpiForWindow(hwnd) };
    if d == 0 {
        96
    } else {
        d
    }
}

/// Logical points → pixels.
pub fn px(v: f32, dpi: u32) -> i32 {
    (v * dpi as f32 / 96.0).round() as i32
}

/// Create the message font (Segoe UI 9pt-ish from NONCLIENTMETRICS) for `dpi`.
/// `monospace` → Consolas at the same height.
pub fn make_font(dpi: u32, monospace: bool) -> HFONT {
    let mut ncm = NONCLIENTMETRICSW {
        cbSize: std::mem::size_of::<NONCLIENTMETRICSW>() as u32,
        ..Default::default()
    };
    let ok = unsafe {
        SystemParametersInfoForDpi(
            SPI_GETNONCLIENTMETRICS.0,
            ncm.cbSize,
            Some(&mut ncm as *mut _ as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0).0,
            dpi,
        )
    };
    let mut lf: LOGFONTW = if ok.is_ok() { ncm.lfMessageFont } else { LOGFONTW::default() };
    if !ok.is_ok() || lf.lfHeight == 0 {
        lf.lfHeight = -(9 * dpi as i32 / 72);
        let face = "Segoe UI";
        for (i, c) in face.encode_utf16().enumerate() {
            lf.lfFaceName[i] = c;
        }
    }
    if monospace {
        lf.lfFaceName = [0; 32];
        for (i, c) in "Consolas".encode_utf16().enumerate() {
            lf.lfFaceName[i] = c;
        }
        lf.lfPitchAndFamily = 49; // FIXED_PITCH | FF_MODERN
    }
    unsafe { CreateFontIndirectW(&lf) }
}

pub fn delete_font(f: HFONT) {
    if !f.is_invalid() {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(f.0));
        }
    }
}

pub fn set_font(hwnd: HWND, f: HFONT) {
    unsafe {
        SendMessageW(hwnd, WM_SETFONT, WPARAM(f.0 as usize), LPARAM(1));
    }
}

pub fn get_text(hwnd: HWND) -> String {
    unsafe {
        let n = GetWindowTextLengthW(hwnd);
        if n <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; n as usize + 1];
        let got = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..got.max(0) as usize])
    }
}

pub fn set_text(hwnd: HWND, s: &str) {
    let w = wide(s);
    unsafe {
        let _ = SetWindowTextW(hwnd, pcwstr(&w));
    }
}

/// Multi-line edit controls want CRLF.
pub fn to_crlf(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\n', "\r\n")
}

pub fn from_crlf(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// Format a number without a trailing `.0`.
pub fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

/// `windows` 0.56 handles are plain wrappers; give them `is_invalid`.
pub trait NullCheck {
    fn is_invalid(&self) -> bool;
}
impl NullCheck for HWND {
    fn is_invalid(&self) -> bool {
        self.0 == 0
    }
}
impl NullCheck for HFONT {
    fn is_invalid(&self) -> bool {
        self.0 == 0
    }
}
