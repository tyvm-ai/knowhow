//! Local IPC server: newline-delimited JSON over a unix socket
//! (`~/.knowhow/run/host.sock`) or a Windows named pipe.

use crate::chord::Chord;
use crate::host::{Host, UiEvent};
use crate::hotkeys::HotkeyReg;
use crate::proto::{self, ClientMsg};
use crate::supervisor::{Proc, SingleInstance, StartSpec};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

enum Role {
    Unknown,
    Control,
    Worker(String),
}

/// Serve one client connection until EOF.
pub async fn serve_conn<S>(host: Arc<Host>, stream: S)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (rd, mut wr) = tokio::io::split(stream);
    let (tx, mut rx) = unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if wr.write_all(line.as_bytes()).await.is_err()
                || wr.write_all(b"\n").await.is_err()
                || wr.flush().await.is_err()
            {
                break;
            }
        }
    });

    let mut role = Role::Unknown;
    let mut lines = BufReader::new(rd).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let (req_id, msg) = match proto::parse_line(&line) {
            Ok(x) => x,
            Err(e) => {
                // keep the reqId (if any) so the sender's request fails instead of hanging
                let rid = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|v| v.get("reqId").cloned())
                    .unwrap_or(Value::Null);
                let _ = tx.send(proto::response_err(&rid, &e));
                continue;
            }
        };
        // GUI messages are answered asynchronously (dialogs wait for the user).
        if let (Role::Worker(id), true) = (&role, msg.is_gui()) {
            handle_gui(&host, id, msg, req_id, tx.clone());
            continue;
        }
        let reply = match (&role, msg) {
            (Role::Unknown, ClientMsg::Hello { role: r, worker_id, name }) => {
                match r.as_str() {
                    "control" => {
                        role = Role::Control;
                        Ok(json!(host.status()))
                    }
                    "worker" => match worker_id {
                        Some(id) if !id.is_empty() => {
                            let _ = name;
                            host.sup.set_conn(&id, tx.clone());
                            role = Role::Worker(id.clone());
                            // Workers learn kill-switch arming from the hello reply
                            // (they cannot send `status`): result = status + workerId.
                            let mut res = json!(host.status());
                            res["workerId"] = json!(id);
                            Ok(res)
                        }
                        _ => Err("worker hello requires workerId (env KNOWHOW_HOST_WORKER_ID)".to_string()),
                    },
                    other => Err(format!("unknown role '{other}'")),
                }
            }
            (Role::Unknown, _) => Err("send hello first".to_string()),
            (_, ClientMsg::Hello { .. }) => Err("already said hello".to_string()),
            (Role::Control, m) => handle_control(&host, m).await,
            (Role::Worker(id), m) => handle_worker(&host, id, m),
        };
        let wants_reply = !req_id.is_null() || matches!(role, Role::Control);
        if wants_reply {
            let line = match &reply {
                Ok(v) => proto::response_ok(&req_id, v.clone()),
                Err(e) => proto::response_err(&req_id, e),
            };
            let _ = tx.send(line);
        }
    }

    if let Role::Worker(id) = &role {
        host.sup.remove_conn(id);
        host.worker_gone(id);
    }
    drop(tx);
    let _ = writer.await;
}

fn pick(
    host: &Host,
    name: &Option<String>,
    id: &Option<String>,
    all: &Option<bool>,
) -> Result<Vec<Arc<Proc>>, String> {
    let all = all.unwrap_or(false);
    if !all && name.is_none() && id.is_none() {
        return Err("specify name, id or all".into());
    }
    let sel = host.sup.select(name.as_deref(), id.as_deref(), all);
    if sel.is_empty() && !all {
        return Err("no matching running worker".into());
    }
    Ok(sel)
}

fn ids(procs: &[Arc<Proc>]) -> Vec<String> {
    procs.iter().map(|p| p.id()).collect()
}

async fn handle_control(host: &Arc<Host>, msg: ClientMsg) -> Result<Value, String> {
    match msg {
        ClientMsg::List => Ok(json!({ "workers": host.list() })),
        ClientMsg::Status => Ok(json!(host.status())),
        ClientMsg::Shutdown => {
            let h = host.clone();
            tokio::spawn(async move {
                h.sup.stop_all().await;
                h.emit(UiEvent::Quit);
                h.shutdown.notify_one();
            });
            Ok(json!({ "shuttingDown": true }))
        }
        ClientMsg::Start { name, argv, cwd, env, single_instance } => {
            let spec = StartSpec {
                name,
                argv,
                cwd,
                env: env.unwrap_or_default(),
                single_instance: SingleInstance::parse(single_instance.as_deref())?,
            };
            let (info, started) = host.sup.start(spec).await?;
            Ok(json!({ "worker": info, "started": started }))
        }
        ClientMsg::Stop { name, id, all } => {
            let sel = pick(host, &name, &id, &all)?;
            let stopped = ids(&sel);
            host.sup.stop_many(sel).await;
            Ok(json!({ "stopped": stopped }))
        }
        ClientMsg::Pause { name, id, all } => pause_resume(host, &name, &id, &all, true),
        ClientMsg::Resume { name, id, all } => pause_resume(host, &name, &id, &all, false),
        ClientMsg::SuspendHotkeys { name, id, all, suspended } => {
            let sel = pick(host, &name, &id, &all)?;
            for p in &sel {
                let wid = p.id();
                let target = suspended.unwrap_or(!host.is_suspended(&wid));
                host.set_suspended(&wid, target);
            }
            Ok(json!({ "workers": ids(&sel) }))
        }
        ClientMsg::Restart { name, id } => {
            let info = host.restart(name.as_deref(), id.as_deref()).await?;
            Ok(json!({ "worker": info }))
        }
        ClientMsg::Logs { name, id, tail } => {
            let path = host
                .sup
                .log_path_for(id.as_deref(), name.as_deref())
                .ok_or_else(|| "no such worker".to_string())?;
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let n = tail.unwrap_or(50);
            let all: Vec<&str> = text.lines().collect();
            let from = all.len().saturating_sub(n);
            Ok(json!({ "path": path, "tail": all[from..].join("\n") }))
        }
        _ => Err("not a control request".into()),
    }
}

/// Cooperative pause/resume; hotkeys are suspended while paused.
fn pause_resume(
    host: &Arc<Host>,
    name: &Option<String>,
    id: &Option<String>,
    all: &Option<bool>,
    paused: bool,
) -> Result<Value, String> {
    let sel = pick(host, name, id, all)?;
    let mut errors = Vec::new();
    for p in &sel {
        match host.sup.set_paused(p, paused) {
            Ok(()) => host.set_suspended(&p.id(), paused),
            Err(e) => errors.push(e),
        }
    }
    Ok(json!({ "workers": ids(&sel), "errors": errors }))
}


/// Route a GUI worker message to the [`crate::gui::GuiManager`]. The reply
/// (`{reqId, ok, result|error}`) is sent from the callback when `reqId` is
/// present; errors of fire-and-forget messages are logged.
fn handle_gui(host: &Arc<Host>, wid: &str, msg: ClientMsg, req_id: Value, tx: Tx) {
    let wid_owned = wid.to_string();
    let reply: crate::gui::Reply = Box::new(move |r| {
        if req_id.is_null() {
            if let Err(e) = r {
                eprintln!("[worker {wid_owned}] gui error: {e}");
            }
            return;
        }
        let _ = tx.send(match r {
            Ok(v) => proto::response_ok(&req_id, v),
            Err(e) => proto::response_err(&req_id, &e),
        });
    });
    match msg.into_gui_request() {
        Some(Ok(req)) => host.gui.handle(wid, req, reply),
        Some(Err(e)) => reply(Err(e)),
        None => reply(Err("not a gui message".into())),
    }
}

fn handle_worker(host: &Arc<Host>, wid: &str, msg: ClientMsg) -> Result<Value, String> {
    match msg {
        ClientMsg::RegisterHotkey { id, chord, any_modifiers, consume, no_repeat, concurrency } => {
            let c = Chord::parse(&chord)?;
            let any = any_modifiers.unwrap_or(false);
            if let Ok(kill) = Chord::parse(&host.kill_switch) {
                let shadows = c.key == kill.key
                    && (c.mods.contains(kill.mods) || (any && kill.mods.contains(c.mods)));
                if shadows {
                    return Err(format!("'{chord}' is reserved for the kill switch ({})", host.kill_switch));
                }
            }
            let mut reg = HotkeyReg::new(wid, &id, c);
            reg.any_modifiers = any;
            reg.consume = consume.unwrap_or(false);
            reg.no_repeat = no_repeat.unwrap_or(false);
            reg.drop_while_busy = concurrency.as_deref() == Some("drop");
            host.register_hotkey(reg);
            Ok(json!({ "id": id }))
        }
        ClientMsg::UnregisterHotkey { id } => {
            host.unregister_hotkey(wid, &id);
            Ok(json!({}))
        }
        ClientMsg::HotkeyDone { id } => {
            host.table.read().unwrap().done(wid, &id);
            Ok(json!({}))
        }
        ClientMsg::HeldKeys { keys } => {
            let mut m = host.held_reported.lock().unwrap();
            if keys.is_empty() {
                m.remove(wid);
            } else {
                m.insert(wid.to_string(), keys);
            }
            Ok(json!({}))
        }
        ClientMsg::TrayStatus { text } => {
            host.sup.set_tray_status(wid, if text.is_empty() { None } else { Some(text) });
            Ok(json!({}))
        }
        ClientMsg::TrayMenuItem { id, label } => {
            {
                let mut m = host.tray_items.lock().unwrap();
                let items = m.entry(wid.to_string()).or_default();
                items.retain(|(i, _)| *i != id);
                items.push((id, label));
            }
            host.sup.notify_changed();
            Ok(json!({}))
        }
        ClientMsg::Log { level, message } => {
            eprintln!(
                "[worker {wid}] {}: {}",
                level.unwrap_or_else(|| "info".into()),
                message.unwrap_or_default()
            );
            Ok(json!({}))
        }
        _ => Err("not a worker message".into()),
    }
}

// ---------------------------------------------------------------- listeners

/// Accept loop. Returns an error if the endpoint can't be bound.
#[cfg(unix)]
pub async fn listen(host: Arc<Host>) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let path = crate::config::socket_path();
    std::fs::create_dir_all(path.parent().unwrap())?;
    let _ = std::fs::remove_file(&path); // stale socket (caller probed first)
    let listener = tokio::net::UnixListener::bind(&path)?;
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    loop {
        let (stream, _) = listener.accept().await?;
        tokio::spawn(serve_conn(host.clone(), stream));
    }
}

#[cfg(windows)]
pub async fn listen(host: Arc<Host>) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = crate::config::pipe_name();
    let mut server = ServerOptions::new().first_pipe_instance(true).create(&name)?;
    loop {
        server.connect().await?;
        let connected = server;
        server = ServerOptions::new().create(&name)?;
        tokio::spawn(serve_conn(host.clone(), connected));
    }
}

#[cfg(not(any(unix, windows)))]
pub async fn listen(_host: Arc<Host>) -> std::io::Result<()> {
    std::future::pending().await
}

/// If a host already answers `status`, return its status result.
pub async fn probe_existing() -> Option<Value> {
    let fut = async {
        #[cfg(unix)]
        let stream = tokio::net::UnixStream::connect(crate::config::socket_path()).await.ok()?;
        #[cfg(windows)]
        let stream = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(crate::config::pipe_name())
            .ok()?;
        #[cfg(not(any(unix, windows)))]
        let stream: tokio::io::DuplexStream = return None;

        let (rd, mut wr) = tokio::io::split(stream);
        wr.write_all(b"{\"type\":\"hello\",\"role\":\"control\",\"reqId\":0}\n").await.ok()?;
        wr.write_all(b"{\"type\":\"status\",\"reqId\":1}\n").await.ok()?;
        let mut lines = BufReader::new(rd).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let v: Value = serde_json::from_str(&line).ok()?;
            if v.get("reqId") == Some(&json!(1)) && v.get("ok") == Some(&json!(true)) {
                return v.get("result").cloned();
            }
        }
        None
    };
    tokio::time::timeout(std::time::Duration::from_millis(800), fut).await.ok().flatten()
}

type Tx = UnboundedSender<String>;
