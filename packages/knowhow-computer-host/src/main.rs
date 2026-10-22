//! knowhow-computer-host [--foreground] [--no-tray] [--print-keys] [--gui-demo]

use knowhow_computer_host::config::{self, Config};
use knowhow_computer_host::host::Host;
use knowhow_computer_host::ipc;
use std::sync::Arc;

struct Args {
    foreground: bool,
    no_tray: bool,
    print_keys: bool,
    gui_demo: bool,
    /// Interpreter / runner script the host spawns for approved automations.
    node: Option<String>,
    runner: Option<String>,
}

fn parse_args() -> Args {
    let mut a = Args { foreground: false, no_tray: false, print_keys: false, gui_demo: false, node: None, runner: None };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--node" => a.node = it.next(),
            "--runner" => a.runner = it.next(),
            "--foreground" => a.foreground = true,
            "--no-tray" => a.no_tray = true,
            "--print-keys" => a.print_keys = true,
            "--gui-demo" => a.gui_demo = true,
            "-h" | "--help" => {
                println!(
                    "knowhow-computer-host [--foreground] [--no-tray] [--print-keys] [--gui-demo]\n\n\
                     --foreground  stay attached to this terminal (default: detach)\n\
                     --no-tray     no tray / menu-bar icon\n\
                     --print-keys  print normalized key names as pressed (Ctrl+C to quit)\n\
                     --gui-demo    show a demo native window (every control kind), print its events\n\
                     --node <exe>  interpreter used to run approved automations\n\
                     --runner <js> runner script (worker.js) used to run approved automations"
                );
                std::process::exit(0);
            }
            other => {
                eprintln!("unknown argument: {other}");
                std::process::exit(2);
            }
        }
    }
    a
}

/// Re-exec ourselves detached (own session/process group, log to host.log).
fn detach() -> std::io::Result<u32> {
    let exe = std::env::current_exe()?;
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    args.push("--foreground".into());
    knowhow_computer_host::security::ensure_private_dir(&config::run_dir())?;
    let log = knowhow_computer_host::security::create_private_file(&config::run_dir().join("host.log"))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    Ok(cmd.spawn()?.id())
}

fn main() {
    let args = parse_args();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    let cfg = Config::load();
    let (kill_chord, warn) = cfg.kill_chord();
    if let Some(w) = warn {
        eprintln!("knowhow-computer-host: {w}");
    }
    let kill_str = kill_chord.to_string();
    let _guard = rt.enter();

    // --print-keys: just the hook, printing key names.
    if args.print_keys {
        let host = Host::new(kill_chord, kill_str);
        host.start_hook(true);
        if let Some(e) = host.hook_error.lock().unwrap().clone() {
            eprintln!("cannot listen for keys: {e}");
            std::process::exit(1);
        }
        eprintln!("listening for keys (Ctrl+C to quit)…");
        rt.block_on(async {
            let _ = tokio::signal::ctrl_c().await;
        });
        return;
    }

    // --gui-demo: just the GUI, no hook / IPC / detaching.
    if args.gui_demo {
        gui_demo(Host::new(kill_chord, kill_str), &rt);
        return;
    }

    // Single host per user.
    if let Some(st) = rt.block_on(ipc::probe_existing()) {
        println!("knowhow-computer-host already running: {st}");
        return;
    }

    if !args.foreground {
        match detach() {
            Ok(pid) => {
                println!("knowhow-computer-host started (pid {pid}); logs: {}", config::run_dir().join("host.log").display());
                return;
            }
            Err(e) => eprintln!("could not detach ({e}); running in foreground"),
        }
    }

    let host = Host::new(kill_chord, kill_str);
    if let (Some(node), Some(script)) = (&args.node, &args.runner) {
        host.set_runner(knowhow_computer_host::host::Runner { node: node.into(), script: script.into() });
    }
    if std::env::var_os("KNOWHOW_CU_NO_UI").is_some() {
        // Headless / test mode: approvals and re-arm are always denied (stricter, never looser).
        host.set_prompter(Arc::new(knowhow_computer_host::approval::DenyPrompter));
    }
    host.start_hook(false);

    {
        let h = host.clone();
        rt.spawn(async move {
            if let Err(e) = ipc::listen(h).await {
                eprintln!("knowhow-computer-host: IPC listener failed: {e}");
                std::process::exit(1);
            }
        });
    }
    {
        let h = host.clone();
        rt.spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            h.sup.stop_all().await;
            cleanup();
            std::process::exit(0);
        });
    }
    #[cfg(unix)]
    {
        let h = host.clone();
        rt.spawn(async move {
            if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                s.recv().await;
                h.sup.stop_all().await;
                cleanup();
                std::process::exit(0);
            }
        });
    }

    eprintln!(
        "knowhow-computer-host {} up (pid {}), kill switch {} ({})",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        host.kill_switch,
        if host.armed.load(std::sync::atomic::Ordering::SeqCst) { "armed" } else { "NOT armed" }
    );

    run_main_loop(host, &rt, args.no_tray);
}

fn cleanup() {
    #[cfg(unix)]
    let _ = std::fs::remove_file(config::socket_path());
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn run_main_loop(host: Arc<Host>, rt: &tokio::runtime::Runtime, no_tray: bool) {
    // Never returns: Quit exits the process. The loop also runs with
    // --no-tray (no icon) so native GUI windows work.
    knowhow_computer_host::tray::run(host, rt.handle().clone(), !no_tray)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn run_main_loop(host: Arc<Host>, rt: &tokio::runtime::Runtime, _no_tray: bool) {
    wait_shutdown(host, rt);
}

#[cfg_attr(any(target_os = "macos", target_os = "windows"), allow(dead_code))]
fn wait_shutdown(host: Arc<Host>, rt: &tokio::runtime::Runtime) {
    rt.block_on(host.shutdown.notified());
    cleanup();
}

/// `--gui-demo`: create the built-in demo window and print its events.
fn gui_demo(host: Arc<Host>, rt: &tokio::runtime::Runtime) {
    use knowhow_computer_host::gui::{demo::DEMO_SPEC, GuiRequest, WindowSpec};
    let spec: WindowSpec = serde_json::from_str(DEMO_SPEC).expect("built-in demo spec");
    let h = host.clone();
    host.gui.set_event_sink(Arc::new(move |ev| {
        println!("{}", ev.to_wire());
        if ev.event == "close" || ev.control_id.as_deref() == Some("closeBtn") {
            h.emit(knowhow_computer_host::host::UiEvent::Quit);
        }
    }));
    let h = host.clone();
    rt.spawn(async move {
        // give the UI loop a moment to start
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let req = GuiRequest::Create { window_id: "demo".into(), spec: Box::new(spec), show: true };
        let h2 = h.clone();
        h.gui.handle(
            "demo",
            req,
            Box::new(move |r| match r {
                Ok(v) => eprintln!("gui-demo: window created: {v}"),
                Err(e) => {
                    eprintln!("gui-demo: cannot create window: {e}");
                    h2.emit(knowhow_computer_host::host::UiEvent::Quit);
                    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                    std::process::exit(1);
                }
            }),
        );
    });
    run_main_loop(host, rt, true);
}
