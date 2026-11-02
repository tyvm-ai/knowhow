//! Tray / menu-bar UI (tray-icon + muda, driven by a tao event loop on the
//! main thread). macOS: Accessory activation policy (no Dock icon).

use crate::gui::GuiCommand;
use crate::host::{Host, UiEvent};
use std::collections::HashMap;
use std::sync::Arc;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

enum UserEvent {
    Ui(UiEvent),
    Menu(MenuId),
    /// Native GUI work for the platform backend (runs on this main thread).
    Gui(GuiCommand),
}

#[derive(Clone, Debug)]
enum Action {
    Pause(String),
    Resume(String),
    Suspend(String),
    Restart(String),
    Stop(String),
    ShowLog(String),
    Custom(String, String),
    PauseAll,
    ResumeAll,
    StopAll,
    Rearm,
    Quit,
}

// 44px = 22pt menu-bar height at 2x; the OS downsamples elsewhere (Windows/Linux trays).
const SIZE: u32 = 44;

/// Knowhow "KH" outline badge (same geometry as knowhow-web `brand/knowhow-icon.svg`, 64x64 grid):
/// white rounded tile, dark ring, dark KH strokes, plus an optional status dot (bottom-right).
/// Rendered with 4x4 supersampling so it stays crisp on both light and dark menu bars.
fn make_icon(dot: Option<[u8; 3]>) -> Icon {
    const INK: [f32; 3] = [15.0, 23.0, 42.0]; // #0f172a
    const PAPER: [f32; 3] = [255.0, 255.0, 255.0];
    // KH strokes (64-grid): K stem, K upper arm, K lower arm, H left, H right, H bar.
    const KH: [(f32, f32, f32, f32); 6] = [
        (15.0, 18.0, 15.0, 46.0),
        (29.0, 18.0, 16.5, 32.0),
        (16.5, 32.0, 29.0, 46.0),
        (35.0, 18.0, 35.0, 46.0),
        (49.0, 18.0, 49.0, 46.0),
        (35.0, 32.0, 49.0, 32.0),
    ];
    const RING_HALF: f32 = 2.5; // ring stroke 5 units (thicker than the web 3 for tray legibility)
    const GLYPH_HALF: f32 = 3.25; // glyph stroke 6.5 units
    const DOT: (f32, f32, f32) = (52.0, 52.0, 10.0); // cx, cy, r
    const DOT_BORDER: f32 = 3.5;

    fn seg(x: f32, y: f32, (ax, ay, bx, by): (f32, f32, f32, f32)) -> f32 {
        let (dx, dy) = (bx - ax, by - ay);
        let t = (((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
        ((x - (ax + t * dx)).powi(2) + (y - (ay + t * dy)).powi(2)).sqrt()
    }
    /// Signed distance to the rounded square x,y in [2.75, 61.25], radius 14.
    fn rrect(x: f32, y: f32) -> f32 {
        let (c, half, r) = (32.0, 29.25, 14.0);
        let qx = (x - c).abs() - (half - r);
        let qy = (y - c).abs() - (half - r);
        (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r
    }

    const SS: u32 = 4;
    let scale = 64.0 / SIZE as f32;
    let mut px = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (mut acc, mut alpha) = ([0.0f32; 3], 0.0f32);
            for sy in 0..SS {
                for sx in 0..SS {
                    let gx = (x as f32 + (sx as f32 + 0.5) / SS as f32) * scale;
                    let gy = (y as f32 + (sy as f32 + 0.5) / SS as f32) * scale;
                    let d = rrect(gx, gy);
                    let mut col: Option<[f32; 3]> = None;
                    if d <= RING_HALF {
                        col = Some(if d.abs() <= RING_HALF || KH.iter().any(|&s| seg(gx, gy, s) <= GLYPH_HALF) {
                            INK
                        } else {
                            PAPER
                        });
                    }
                    if let Some(rgb) = dot {
                        let dd = ((gx - DOT.0).powi(2) + (gy - DOT.1).powi(2)).sqrt();
                        if dd <= DOT.2 {
                            col = Some([rgb[0] as f32, rgb[1] as f32, rgb[2] as f32]);
                        } else if dd <= DOT.2 + DOT_BORDER {
                            col = Some(PAPER);
                        }
                    }
                    if let Some(c) = col {
                        for k in 0..3 {
                            acc[k] += c[k];
                        }
                        alpha += 1.0;
                    }
                }
            }
            if alpha > 0.0 {
                let i = ((y * SIZE + x) * 4) as usize;
                for k in 0..3 {
                    px[i + k] = (acc[k] / alpha).round() as u8;
                }
                px[i + 3] = (alpha / (SS * SS) as f32 * 255.0).round() as u8;
            }
        }
    }
    Icon::from_rgba(px, SIZE, SIZE).expect("valid icon buffer")
}

const COLOR_PAUSED: [u8; 3] = [0xf5, 0x9e, 0x0b];
const COLOR_HALTED: [u8; 3] = [0xef, 0x44, 0x44];

fn item(menu: &Submenu, text: &str, enabled: bool, action: Option<Action>, map: &mut HashMap<MenuId, Action>) {
    let it = MenuItem::new(text, enabled, None);
    if let Some(a) = action {
        map.insert(it.id().clone(), a);
    }
    let _ = menu.append(&it);
}

fn top_item(menu: &Menu, text: &str, enabled: bool, action: Option<Action>, map: &mut HashMap<MenuId, Action>) {
    let it = MenuItem::new(text, enabled, None);
    if let Some(a) = action {
        map.insert(it.id().clone(), a);
    }
    let _ = menu.append(&it);
}

/// Build the whole menu from current host state.
fn build_menu(host: &Host) -> (Menu, HashMap<MenuId, Action>) {
    let mut map = HashMap::new();
    let menu = Menu::new();
    let armed = if host.armed.load(std::sync::atomic::Ordering::SeqCst) {
        "armed"
    } else {
        "NOT ARMED"
    };
    top_item(
        &menu,
        &format!("Kill switch: {} ({armed})", host.kill_switch),
        false,
        None,
        &mut map,
    );
    let _ = menu.append(&PredefinedMenuItem::separator());

    let workers: Vec<_> = host.list().into_iter().filter(|w| w.status != "exited").collect();
    if workers.is_empty() {
        top_item(&menu, "No automations running", false, None, &mut map);
    }
    let custom = host.tray_items.lock().unwrap().clone();
    for w in &workers {
        let dot = if w.status == "paused" { "paused" } else { "active" };
        let mut title = format!("{}  ● {dot}", w.name);
        if let Some(t) = &w.tray_status {
            title.push_str(&format!(" — {t}"));
        }
        let sub = Submenu::new(title, true);
        let id = w.id.clone();
        if w.status == "paused" {
            item(&sub, "Resume", true, Some(Action::Resume(id.clone())), &mut map);
        } else {
            item(&sub, "Pause", true, Some(Action::Pause(id.clone())), &mut map);
        }
        let susp = if w.hotkeys_suspended { "Resume hotkeys" } else { "Suspend hotkeys" };
        item(&sub, susp, true, Some(Action::Suspend(id.clone())), &mut map);
        item(&sub, "Restart", true, Some(Action::Restart(id.clone())), &mut map);
        item(&sub, "Stop", true, Some(Action::Stop(id.clone())), &mut map);
        item(&sub, "Show log…", true, Some(Action::ShowLog(w.log_path.clone())), &mut map);
        if let Some(items) = custom.get(&w.id) {
            let _ = sub.append(&PredefinedMenuItem::separator());
            for (item_id, label) in items {
                item(&sub, label, true, Some(Action::Custom(id.clone(), item_id.clone())), &mut map);
            }
        }
        let _ = menu.append(&sub);
    }
    let _ = menu.append(&PredefinedMenuItem::separator());
    top_item(&menu, "Pause all", !workers.is_empty(), Some(Action::PauseAll), &mut map);
    top_item(&menu, "Resume all", !workers.is_empty(), Some(Action::ResumeAll), &mut map);
    top_item(
        &menu,
        &format!("Stop all ({})", host.kill_switch),
        !workers.is_empty(),
        Some(Action::StopAll),
        &mut map,
    );
    let _ = menu.append(&PredefinedMenuItem::separator());
    if host.halted.load(std::sync::atomic::Ordering::SeqCst) {
        top_item(&menu, "Kill switch tripped — re-arm automations…", true, Some(Action::Rearm), &mut map);
    }
    top_item(&menu, "Quit knowhow host (stops all)", true, Some(Action::Quit), &mut map);
    (menu, map)
}



fn live_ids(host: &Host) -> Vec<String> {
    host.sup.select(None, None, true).iter().map(|p| p.id()).collect()
}

fn pause_one(host: &Host, id: &str, paused: bool) {
    if let Some(p) = host.sup.find_by_id(id) {
        match host.sup.set_paused(&p, paused) {
            Ok(()) => host.set_suspended(id, paused),
            Err(e) => eprintln!("knowhow-computer-host: {e}"),
        }
    }
}

fn open_path(path: &str) {
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(target_os = "windows")]
    let prog = "explorer";
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let prog = "xdg-open";
    let _ = std::process::Command::new(prog).arg(path).spawn();
}

async fn perform(host: Arc<Host>, action: Action) {
    match action {
        Action::Pause(id) => pause_one(&host, &id, true),
        Action::Resume(id) => pause_one(&host, &id, false),
        Action::Suspend(id) => {
            let now = host.is_suspended(&id);
            host.set_suspended(&id, !now);
        }
        Action::Restart(id) => {
            if let Err(e) = host.restart(None, Some(&id)).await {
                eprintln!("knowhow-computer-host: restart failed: {e}");
            }
        }
        Action::Stop(id) => {
            let sel = host.sup.select(None, Some(&id), false);
            host.sup.stop_many(sel).await;
        }
        Action::ShowLog(path) => open_path(&path),
        Action::Custom(wid, item_id) => {
            host.sup.send(&wid, &crate::proto::ev_tray_menu(&item_id));
        }
        Action::PauseAll => {
            for id in live_ids(&host) {
                pause_one(&host, &id, true);
            }
        }
        Action::ResumeAll => {
            for id in live_ids(&host) {
                pause_one(&host, &id, false);
            }
        }
        Action::StopAll => host.sup.stop_all().await,
        Action::Rearm => {
            if let Err(e) = host.rearm().await {
                eprintln!("knowhow-computer-host: re-arm failed: {e}");
            }
        }
        Action::Quit => {
            host.sup.stop_all().await;
            host.emit(UiEvent::Quit);
            host.shutdown.notify_one();
        }
    }
}

fn refresh(tray: &TrayIcon, host: &Host, halted: bool, actions: &mut HashMap<MenuId, Action>) {
    let (menu, map) = build_menu(host);
    *actions = map;
    tray.set_menu(Some(Box::new(menu)));
    let workers: Vec<_> = host.list().into_iter().filter(|w| w.status != "exited").collect();
    let any_paused = workers.iter().any(|w| w.status == "paused");
    // Same KH badge in every state; a status dot signals paused (amber) / halted (red).
    let dot = if halted {
        Some(COLOR_HALTED)
    } else if any_paused {
        Some(COLOR_PAUSED)
    } else {
        None
    };
    let _ = tray.set_icon(Some(make_icon(dot)));
    let tip = if halted {
        "knowhow: kill switch tripped — automations blocked until re-armed".to_string()
    } else {
        format!("knowhow host — {} running", workers.len())
    };
    let _ = tray.set_tooltip(Some(tip));
    #[cfg(target_os = "macos")]
    tray.set_title(Some(if halted {
        "■".to_string()
    } else if workers.is_empty() {
        String::new()
    } else {
        workers.len().to_string()
    }));
}

/// Run the tao event loop on the calling (main) thread. Never returns.
/// With `with_tray` the tray icon / menu is created; without it (`--no-tray`)
/// the loop still runs so native GUI windows work. GUI commands from
/// [`Host::gui`] are executed here against [`crate::gui::platform_backend`].
pub fn run(host: Arc<Host>, rt: tokio::runtime::Handle, with_tray: bool) -> ! {
    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    let proxy = event_loop.create_proxy();
    host.set_ui(Arc::new(move |e| {
        let _ = proxy.send_event(UserEvent::Ui(e));
    }));
    let gui_proxy = event_loop.create_proxy();
    host.gui.set_dispatcher(Arc::new(move |cmd| {
        if let Err(tao::event_loop::EventLoopClosed(UserEvent::Gui(cmd))) = gui_proxy.send_event(UserEvent::Gui(cmd)) {
            cmd.fail("GUI event loop is closed");
        }
    }));
    let mut backend = crate::gui::platform_backend();
    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
        let _ = menu_proxy.send_event(UserEvent::Menu(e.id));
    }));

    let mut tray: Option<TrayIcon> = None;
    let mut actions: HashMap<MenuId, Action> = HashMap::new();
    let mut halted = false;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            // The tray icon must be created once the loop is running (macOS).
            Event::NewEvents(StartCause::Init) if with_tray => {
                let (menu, map) = build_menu(&host);
                actions = map;
                match TrayIconBuilder::new()
                    .with_menu(Box::new(menu))
                    .with_tooltip("knowhow host")
                    .with_icon(make_icon(None))
                    .build()
                {
                    Ok(t) => {
                        refresh(&t, &host, halted, &mut actions);
                        tray = Some(t);
                    }
                    Err(e) => eprintln!("knowhow-computer-host: tray unavailable: {e}"),
                }
            }
            Event::UserEvent(UserEvent::Ui(ev)) => match ev {
                UiEvent::StateChanged => {
                    if let Some(t) = &tray {
                        refresh(t, &host, halted, &mut actions);
                    }
                }
                UiEvent::Halted(h) => {
                    halted = h;
                    if let Some(t) = &tray {
                        refresh(t, &host, halted, &mut actions);
                    }
                }
                UiEvent::Quit => {
                    host.gui.destroy_all();
                    #[cfg(unix)]
                    let _ = std::fs::remove_file(crate::config::socket_path());
                    *control_flow = ControlFlow::Exit
                }
            },
            Event::UserEvent(UserEvent::Gui(cmd)) => cmd.execute(&mut *backend),
            Event::UserEvent(UserEvent::Menu(id)) => {
                if let Some(a) = actions.get(&id).cloned() {
                    rt.spawn(perform(host.clone(), a));
                }
            }
            _ => {}
        }
    })
}
