//! Windows backend: Win32 `SendInput` for mouse/keyboard, GDI `BitBlt` for
//! capture, `EnumWindows`/DWM for window listing. Mirrors `macos.rs`.
//!
//! Coordinates: the process is made Per-Monitor-V2 DPI aware, so every desktop
//! coordinate we read or write (cursor, monitor rects, window rects, capture
//! regions) is in *physical* pixels, and `Display::scale_factor` is reported
//! separately (dpi / 96).
//!
//! Every injected event carries `dwExtraInfo = INJECT_TAG` ("KNOW") so a future
//! low-level hook can recognise and ignore our own input.

#![cfg(target_os = "windows")]

use std::ffi::c_void;
use std::mem::size_of;
use std::sync::Once;

use napi::{Error, Result, Status};
use ::windows::core::PWSTR;
use ::windows::Win32::Foundation::{
    CloseHandle, BOOL, GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, POINT, RECT, TRUE,
};
use ::windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use ::windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GetDC, GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, HMONITOR, MONITORINFO, SRCCOPY,
};
use ::windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    SetClipboardData,
};
use ::windows::Win32::System::Diagnostics::Debug::Beep;
use ::windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use ::windows::Win32::System::Ole::CF_UNICODETEXT;
use ::windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use ::windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    MDT_EFFECTIVE_DPI,
};
use ::windows::Win32::UI::Input::KeyboardAndMouse::*;
use ::windows::Win32::UI::WindowsAndMessaging::{
    AllowSetForegroundWindow, EnumWindows, GetCursorPos, GetForegroundWindow, GetSystemMetrics,
    GetWindowLongW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, GWL_EXSTYLE, SM_CXVIRTUALSCREEN,
    SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SW_RESTORE, WHEEL_DELTA,
    WS_EX_TOOLWINDOW,
};

use crate::backend::Backend;
use crate::keys::Key;
use crate::types::*;

/// "KNOW" — marks events injected by this crate.
pub const INJECT_TAG: usize = 0x4B4E_4F57;

static DPI_ONCE: Once = Once::new();

fn ensure_dpi_aware() {
    DPI_ONCE.call_once(|| unsafe {
        // Ignore failure (already set by host process / manifest).
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    });
}

fn err(msg: impl Into<String>) -> Error {
    Error::new(Status::GenericFailure, msg.into())
}

fn werr(what: &str, e: ::windows::core::Error) -> Error {
    err(format!("{what} failed: {e}"))
}

pub struct WinBackend;

impl WinBackend {
    pub fn new() -> Self {
        ensure_dpi_aware();
        WinBackend
    }
}

impl Default for WinBackend {
    fn default() -> Self {
        Self::new()
    }
}

// ───────────────────────── input helpers ─────────────────────────

fn send_inputs(inputs: &[INPUT]) -> Result<()> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(err(format!(
            "SendInput injected {sent}/{} events (blocked by UIPI / elevated window?)",
            inputs.len()
        )));
    }
    Ok(())
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: INJECT_TAG,
            },
        },
    }
}

fn key_input_scan(scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: INJECT_TAG,
            },
        },
    }
}

fn key_input_vk(vk: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: INJECT_TAG,
            },
        },
    }
}

/// Resolve a `Key` to `(virtual-key code, is_extended)`.
fn vk_for(key: Key) -> Option<(u16, bool)> {
    let r = match key {
        Key::Char(c) => {
            let mut buf = [0u16; 2];
            let units = c.encode_utf16(&mut buf);
            if units.len() != 1 {
                return None;
            }
            let res = unsafe { VkKeyScanW(units[0]) };
            if res == -1 {
                return None;
            }
            ((res & 0xFF) as u16, false)
        }
        Key::Control => (VK_LCONTROL.0, false),
        Key::Alt => (VK_LMENU.0, false),
        Key::Shift => (VK_LSHIFT.0, false),
        Key::Meta => (VK_LWIN.0, true),
        Key::Enter => (VK_RETURN.0, false),
        Key::Tab => (VK_TAB.0, false),
        Key::Space => (VK_SPACE.0, false),
        Key::Backspace => (VK_BACK.0, false),
        Key::Delete => (VK_DELETE.0, true),
        Key::Escape => (VK_ESCAPE.0, false),
        Key::Insert => (VK_INSERT.0, true),
        Key::CapsLock => (VK_CAPITAL.0, false),
        Key::Left => (VK_LEFT.0, true),
        Key::Right => (VK_RIGHT.0, true),
        Key::Up => (VK_UP.0, true),
        Key::Down => (VK_DOWN.0, true),
        Key::Home => (VK_HOME.0, true),
        Key::End => (VK_END.0, true),
        Key::PageUp => (VK_PRIOR.0, true),
        Key::PageDown => (VK_NEXT.0, true),
        Key::F(n) if (1..=24).contains(&n) => (VK_F1.0 + (n as u16 - 1), false),
        Key::F(_) => return None,
    };
    Some(r)
}

/// Build the INPUT for a key press/release, preferring hardware scancodes so
/// DirectInput / raw-input games see the key; falls back to a VK event.
fn key_event(key: Key, down: bool) -> Result<INPUT> {
    let (vk, ext) = vk_for(key)
        .ok_or_else(|| Error::new(Status::InvalidArg, format!("Unsupported key on Windows: {key:?}")))?;
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut flags = if down { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP };
    if ext {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if scan != 0 {
        Ok(key_input_scan(scan, flags | KEYEVENTF_SCANCODE))
    } else {
        Ok(key_input_vk(vk, flags))
    }
}

// ───────────────────────── displays ─────────────────────────

struct MonitorRec {
    handle: isize,
    rect: RECT,
    primary: bool,
    scale: f64,
}

unsafe extern "system" fn monitor_cb(
    hmon: HMONITOR,
    _hdc: HDC,
    _rc: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<MonitorRec>);
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if GetMonitorInfoW(hmon, &mut info).as_bool() {
        let (mut dx, mut dy) = (96u32, 96u32);
        let scale = match GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) {
            Ok(()) if dx > 0 => dx as f64 / 96.0,
            _ => 1.0,
        };
        out.push(MonitorRec {
            handle: hmon.0 as isize,
            rect: info.rcMonitor,
            primary: info.dwFlags & 1 != 0, // MONITORINFOF_PRIMARY
            scale,
        });
    }
    TRUE
}

fn monitors() -> Result<Vec<MonitorRec>> {
    let mut v: Vec<MonitorRec> = Vec::new();
    let ok = unsafe {
        EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(monitor_cb),
            LPARAM(&mut v as *mut Vec<MonitorRec> as isize),
        )
    };
    if !ok.as_bool() || v.is_empty() {
        return Err(err("EnumDisplayMonitors returned no monitors"));
    }
    Ok(v)
}

fn primary_monitor() -> Result<MonitorRec> {
    let mut v = monitors()?;
    let idx = v.iter().position(|m| m.primary).unwrap_or(0);
    Ok(v.swap_remove(idx))
}

// ───────────────────────── capture ─────────────────────────

/// BitBlt `rect` (desktop coords) into a tightly-packed RGBA buffer.
fn capture_rect(x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>> {
    if w <= 0 || h <= 0 {
        return Err(Error::new(Status::InvalidArg, "capture region must be non-empty"));
    }
    unsafe {
        let screen = GetDC(HWND::default());
        if screen.is_invalid() {
            return Err(err("GetDC(NULL) failed"));
        }
        let mem = CreateCompatibleDC(screen);
        if mem.is_invalid() {
            ReleaseDC(HWND::default(), screen);
            return Err(err("CreateCompatibleDC failed"));
        }
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let bmp: HBITMAP = match CreateDIBSection(screen, &bmi, DIB_RGB_COLORS, &mut bits, HANDLE::default(), 0) {
            Ok(b) if !bits.is_null() => b,
            Ok(b) => {
                let _ = DeleteObject(HGDIOBJ(b.0));
                let _ = DeleteDC(mem);
                ReleaseDC(HWND::default(), screen);
                return Err(err("CreateDIBSection returned no bits"));
            }
            Err(e) => {
                let _ = DeleteDC(mem);
                ReleaseDC(HWND::default(), screen);
                return Err(werr("CreateDIBSection", e));
            }
        };
        let old = SelectObject(mem, HGDIOBJ(bmp.0));
        let blt = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT);

        let mut out = Vec::new();
        if blt.is_ok() {
            let n = (w as usize) * (h as usize) * 4;
            let src = std::slice::from_raw_parts(bits as *const u8, n);
            out = Vec::with_capacity(n);
            for px in src.chunks_exact(4) {
                out.extend_from_slice(&[px[2], px[1], px[0], 255]); // BGRA → RGBA
            }
        }
        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(HWND::default(), screen);
        match blt {
            Ok(()) => Ok(out),
            Err(e) => Err(werr("BitBlt", e)),
        }
    }
}

/// Box-filter downscale of tightly-packed RGBA (scale in (0,1)).
fn downscale(src: &[u8], w: u32, h: u32, nw: u32, nh: u32) -> Vec<u8> {
    let mut out = vec![0u8; (nw as usize) * (nh as usize) * 4];
    for dy in 0..nh {
        let y0 = (dy as u64 * h as u64 / nh as u64) as u32;
        let y1 = (((dy as u64 + 1) * h as u64 + nh as u64 - 1) / nh as u64).clamp(y0 as u64 + 1, h as u64) as u32;
        for dx in 0..nw {
            let x0 = (dx as u64 * w as u64 / nw as u64) as u32;
            let x1 = (((dx as u64 + 1) * w as u64 + nw as u64 - 1) / nw as u64).clamp(x0 as u64 + 1, w as u64) as u32;
            let mut acc = [0u64; 4];
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = ((sy as usize) * (w as usize) + sx as usize) * 4;
                    for c in 0..4 {
                        acc[c] += src[i + c] as u64;
                    }
                }
            }
            let cnt = ((y1 - y0) as u64 * (x1 - x0) as u64).max(1);
            let o = ((dy as usize) * (nw as usize) + dx as usize) * 4;
            for c in 0..4 {
                out[o + c] = (acc[c] / cnt) as u8;
            }
        }
    }
    out
}


// ───────────────────────── windows ─────────────────────────

fn window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }
}

fn window_bounds(hwnd: HWND) -> Option<RECT> {
    unsafe {
        let mut r = RECT::default();
        if DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        )
        .is_ok()
        {
            return Some(r);
        }
        if GetWindowRect(hwnd, &mut r).is_ok() {
            return Some(r);
        }
        None
    }
}

fn is_cloaked(hwnd: HWND) -> bool {
    unsafe {
        let mut cloaked: u32 = 0;
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
        )
        .is_ok()
            && cloaked != 0
    }
}

/// `(pid, exe file stem)` for a window's owning process.
fn window_process(hwnd: HWND) -> (Option<u32>, Option<String>) {
    unsafe {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return (None, None);
        }
        let mut exe = None;
        if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
                .is_ok()
            {
                let path = String::from_utf16_lossy(&buf[..len as usize]);
                exe = path.rsplit(['\\', '/']).next().map(|s| s.to_string());
            }
            let _ = CloseHandle(h);
        }
        (Some(pid), exe)
    }
}

unsafe extern "system" fn window_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    if !IsWindowVisible(hwnd).as_bool() {
        return TRUE;
    }
    if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0 {
        return TRUE;
    }
    if is_cloaked(hwnd) {
        return TRUE;
    }
    let title = window_title(hwnd);
    if title.is_empty() {
        return TRUE;
    }
    let Some(r) = window_bounds(hwnd) else {
        return TRUE;
    };
    let (pid, exe) = window_process(hwnd);
    let app = exe
        .as_deref()
        .map(|e| match e.rsplit_once('.') {
            Some((stem, _)) if !stem.is_empty() => stem.to_string(),
            _ => e.to_string(),
        })
        .unwrap_or_default();
    out.push(WindowInfo {
        id: hwnd.0 as usize as u32,
        title,
        app,
        bounds: Region {
            x: r.left as f64,
            y: r.top as f64,
            width: (r.right - r.left) as f64,
            height: (r.bottom - r.top) as f64,
        },
        active: false,
        pid,
        exe,
        bundle_id: None,
    });
    TRUE
}

impl WinBackend {
    /// Bring a window (by `WindowInfo::id`) to the foreground. Not part of the
    /// `Backend` trait yet; exposed for when the trait grows a focus method.
    #[allow(dead_code)]
    pub fn focus_window(&self, id: u32) -> Result<()> {
        unsafe {
            let hwnd = HWND(id as isize);
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let _ = AllowSetForegroundWindow(pid);
            if SetForegroundWindow(hwnd).as_bool() {
                return Ok(());
            }
            // ALT-tap trick: a synthetic Alt press unlocks SetForegroundWindow.
            let _ = send_inputs(&[
                key_input_vk(VK_MENU.0, KEYBD_EVENT_FLAGS(0)),
                key_input_vk(VK_MENU.0, KEYEVENTF_KEYUP),
            ]);
            if SetForegroundWindow(hwnd).as_bool() {
                Ok(())
            } else {
                Err(err("SetForegroundWindow failed"))
            }
        }
    }

    fn virtual_screen() -> (i32, i32, i32, i32) {
        unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1),
                GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1),
            )
        }
    }
}

// ───────────────────────── clipboard ─────────────────────────

fn open_clipboard() -> Result<()> {
    let mut last = None;
    for _ in 0..10 {
        match unsafe { OpenClipboard(HWND::default()) } {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err(err(format!(
        "OpenClipboard failed after 10 attempts: {}",
        last.map(|e| e.to_string()).unwrap_or_default()
    )))
}

fn vk_for_state(key: Key) -> Option<i32> {
    match key {
        // Generic modifier VKs report either left or right key.
        Key::Control => Some(VK_CONTROL.0 as i32),
        Key::Alt => Some(VK_MENU.0 as i32),
        Key::Shift => Some(VK_SHIFT.0 as i32),
        Key::Meta => None, // handled specially (LWIN | RWIN)
        other => vk_for(other).map(|(vk, _)| vk as i32),
    }
}


// ───────────────────────── Backend ─────────────────────────

impl Backend for WinBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            input: true,
            capture: true,
            windows: true,
            clipboard: Some(true),
            key_state: Some(true),
            reason: None,
        }
    }

    fn permissions_status(&self) -> PermissionsStatus {
        PermissionsStatus {
            platform: "windows".to_string(),
            input_ok: true,
            capture_ok: true,
            fix: Some(
                "Windows has no permission prompts. Input into elevated (admin) windows is blocked by UIPI \
                 unless this process is also elevated."
                    .to_string(),
            ),
        }
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        let mut v: Vec<WindowInfo> = Vec::new();
        unsafe {
            EnumWindows(Some(window_cb), LPARAM(&mut v as *mut Vec<WindowInfo> as isize))
                .map_err(|e| werr("EnumWindows", e))?;
        }
        let fg = unsafe { GetForegroundWindow() };
        let fg_id = fg.0 as usize as u32;
        for w in v.iter_mut() {
            w.active = fg.0 != 0 && w.id == fg_id;
        }
        Ok(v)
    }

    fn get_displays(&self) -> Result<Vec<Display>> {
        Ok(monitors()?
            .into_iter()
            .map(|m| Display {
                id: m.handle as f64,
                x: m.rect.left as f64,
                y: m.rect.top as f64,
                width: (m.rect.right - m.rect.left) as f64,
                height: (m.rect.bottom - m.rect.top) as f64,
                scale_factor: m.scale,
                primary: m.primary,
            })
            .collect())
    }

    fn screen_size(&self) -> Result<Size> {
        let m = primary_monitor()?;
        Ok(Size {
            width: (m.rect.right - m.rect.left) as f64,
            height: (m.rect.bottom - m.rect.top) as f64,
        })
    }

    fn screenshot(&self, opts: &ScreenshotOptions) -> Result<(u32, u32, Vec<u8>)> {
        let scale = opts.scale.unwrap_or(1.0);
        if !scale.is_finite() || scale <= 0.0 || scale > 1.0 {
            return Err(Error::new(
                Status::InvalidArg,
                "capture scale must be finite and in (0, 1]",
            ));
        }

        let (x, y, w, h) = if let Some(r) = opts.region {
            if !r.x.is_finite()
                || !r.y.is_finite()
                || !r.width.is_finite()
                || !r.height.is_finite()
                || r.width <= 0.0
                || r.height <= 0.0
            {
                return Err(Error::new(
                    Status::InvalidArg,
                    "capture region must be finite and non-empty",
                ));
            }
            (
                r.x.round() as i32,
                r.y.round() as i32,
                (r.width.round() as i32).max(1),
                (r.height.round() as i32).max(1),
            )
        } else {
            // Default / display_id: a single monitor (primary by default, like
            // macOS `screencapture`). The primary monitor's origin is (0,0), so
            // image pixel coordinates equal desktop coordinates there.
            let mut mons = monitors()?;
            let idx = opts
                .display_id
                .and_then(|id| mons.iter().position(|m| m.handle as f64 == id))
                .or_else(|| mons.iter().position(|m| m.primary))
                .unwrap_or(0);
            let m = mons.swap_remove(idx);
            (
                m.rect.left,
                m.rect.top,
                m.rect.right - m.rect.left,
                m.rect.bottom - m.rect.top,
            )
        };

        let rgba = capture_rect(x, y, w, h)?;
        let (mut ow, mut oh) = (w as u32, h as u32);
        if scale < 1.0 {
            let nw = ((ow as f64 * scale).round() as u32).max(1);
            let nh = ((oh as f64 * scale).round() as u32).max(1);
            let scaled = downscale(&rgba, ow, oh, nw, nh);
            ow = nw;
            oh = nh;
            return Ok((ow, oh, scaled));
        }
        Ok((ow, oh, rgba))
    }

    fn pixel_color(&self, p: Point) -> Result<String> {
        if !p.x.is_finite() || !p.y.is_finite() {
            return Err(Error::new(Status::InvalidArg, "pixel out of bounds"));
        }
        let data = capture_rect(p.x.floor() as i32, p.y.floor() as i32, 1, 1)?;
        if data.len() < 3 {
            return Err(Error::new(Status::InvalidArg, "pixel out of bounds"));
        }
        Ok(format!("#{:02X}{:02X}{:02X}", data[0], data[1], data[2]))
    }

    fn mouse_position(&self) -> Result<Point> {
        let mut pt = POINT::default();
        unsafe { GetCursorPos(&mut pt).map_err(|e| werr("GetCursorPos", e))? };
        Ok(Point {
            x: pt.x as f64,
            y: pt.y as f64,
        })
    }

    fn move_mouse(&self, p: Point) -> Result<()> {
        let (vx, vy, vw, vh) = Self::virtual_screen();
        let norm = |v: f64, origin: i32, extent: i32| -> i32 {
            let span = (extent - 1).max(1) as f64;
            let n = ((v - origin as f64) * 65535.0 / span).round();
            n.clamp(0.0, 65535.0) as i32
        };
        let nx = norm(p.x, vx, vw);
        let ny = norm(p.y, vy, vh);
        send_inputs(&[mouse_input(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            nx,
            ny,
            0,
        )])
    }

    fn mouse_button(&self, button: Button, down: bool) -> Result<()> {
        let flags = match (button, down) {
            (Button::Left, true) => MOUSEEVENTF_LEFTDOWN,
            (Button::Left, false) => MOUSEEVENTF_LEFTUP,
            (Button::Right, true) => MOUSEEVENTF_RIGHTDOWN,
            (Button::Right, false) => MOUSEEVENTF_RIGHTUP,
            (Button::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
            (Button::Middle, false) => MOUSEEVENTF_MIDDLEUP,
        };
        send_inputs(&[mouse_input(flags, 0, 0, 0)])
    }

    fn scroll(&self, dx: f64, dy: f64) -> Result<()> {
        // Same sign convention as macOS: positive dy scrolls up (WHEEL positive
        // = away from the user = up). macOS wheel2 positive scrolls left, while
        // HWHEEL positive scrolls right, so dx is negated.
        let delta = WHEEL_DELTA as f64;
        let mut inputs = Vec::new();
        let vy = (dy * delta).round() as i32;
        let vx = (-dx * delta).round() as i32;
        if vy != 0 {
            inputs.push(mouse_input(MOUSEEVENTF_WHEEL, 0, 0, vy));
        }
        if vx != 0 {
            inputs.push(mouse_input(MOUSEEVENTF_HWHEEL, 0, 0, vx));
        }
        send_inputs(&inputs)
    }

    fn type_text(&self, text: &str) -> Result<()> {
        for unit in text.encode_utf16() {
            send_inputs(&[
                key_input_scan(unit, KEYEVENTF_UNICODE),
                key_input_scan(unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            ])?;
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
        Ok(())
    }

    fn key(&self, key: Key, down: bool) -> Result<()> {
        send_inputs(&[key_event(key, down)?])
    }

    fn key_state(&self, key: Key, physical: bool) -> Result<bool> {
        let query = |vk: i32| -> bool {
            let s = unsafe {
                if physical {
                    GetAsyncKeyState(vk)
                } else {
                    GetKeyState(vk)
                }
            };
            (s as u16) & 0x8000 != 0
        };
        if key == Key::Meta {
            return Ok(query(VK_LWIN.0 as i32) || query(VK_RWIN.0 as i32));
        }
        let vk = vk_for_state(key)
            .ok_or_else(|| Error::new(Status::InvalidArg, format!("Unsupported key on Windows: {key:?}")))?;
        Ok(query(vk))
    }

    fn clipboard_get_text(&self) -> Result<Option<String>> {
        open_clipboard()?;
        let result = unsafe {
            let h = GetClipboardData(CF_UNICODETEXT.0 as u32);
            match h {
                Err(_) => None,
                Ok(handle) if handle.is_invalid() => None,
                Ok(handle) => {
                    let hg = HGLOBAL(handle.0 as *mut c_void);
                    let ptr = GlobalLock(hg) as *const u16;
                    if ptr.is_null() {
                        None
                    } else {
                        let mut len = 0usize;
                        while *ptr.add(len) != 0 {
                            len += 1;
                        }
                        let s = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                        let _ = GlobalUnlock(hg);
                        Some(s)
                    }
                }
            }
        };
        unsafe {
            let _ = CloseClipboard();
        }
        Ok(result)
    }

    fn clipboard_set_text(&self, text: &str) -> Result<()> {
        let mut wide: Vec<u16> = text.encode_utf16().collect();
        wide.push(0);
        let bytes = wide.len() * 2;
        open_clipboard()?;
        let res = unsafe {
            (|| -> Result<()> {
                EmptyClipboard().map_err(|e| werr("EmptyClipboard", e))?;
                let hg = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| werr("GlobalAlloc", e))?;
                let dst = GlobalLock(hg) as *mut u16;
                if dst.is_null() {
                    let _ = GlobalFree(hg);
                    return Err(err("GlobalLock failed"));
                }
                std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
                let _ = GlobalUnlock(hg);
                // On success the system owns the memory.
                if let Err(e) = SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(hg.0 as isize)) {
                    let _ = GlobalFree(hg);
                    return Err(werr("SetClipboardData", e));
                }
                Ok(())
            })()
        };
        unsafe {
            let _ = CloseClipboard();
        }
        res
    }

    fn clipboard_change_count(&self) -> Result<i64> {
        Ok(unsafe { GetClipboardSequenceNumber() } as i64)
    }

    fn beep(&self, freq: u32, ms: u32) -> Result<()> {
        let freq = freq.clamp(37, 32767);
        unsafe { Beep(freq, ms).map_err(|e| werr("Beep", e)) }
    }
}
