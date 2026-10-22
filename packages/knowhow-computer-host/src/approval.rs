//! Automation approvals. The host only starts automations the user knows
//! about. Approval is keyed by the **canonical (realpath) path** of the entry
//! file and comes in two kinds:
//!
//! * **Once**   — allow this single run; never written to disk.
//! * **Always** — persisted in `~/.knowhow/computer-use/approvals.json`
//!   (host-written, 0600) until revoked.
//!
//! Unknown paths trigger a host-owned native dialog ("Allow once" /
//! "Always allow" / "Deny"); no UI / timeout / dismissal means deny.
//!
//! There is deliberately NO content hashing or import tracking: a same-user
//! attacker who can rewrite an approved file can equally rewrite
//! `approvals.json` or the CLI itself, so a hash defends nothing real and only
//! hurts iteration. (That also makes the "file swapped after approval" TOCTOU
//! moot.) The entry file's sha256 is computed at start time for the audit log
//! only — see `audit.rs`.

use crate::security::{sha256_hex, write_private_atomic};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// What the user chose in the dialog.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Once,
    Always,
    Deny,
}

/// How a start was authorized.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Once,
    Always,
}

impl Kind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Once => "once",
            Kind::Always => "always",
        }
    }
}

/// Result of a successful approval check.
#[derive(Clone, Debug, PartialEq)]
pub struct Approved {
    pub real_path: PathBuf,
    pub kind: Kind,
    /// True when the user was just asked (false: already in the store).
    pub prompted: bool,
}

/// Canonical absolute path of an automation entry file.
pub fn canonical(path: &str) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(path).map_err(|e| format!("cannot resolve '{path}': {e}"))?;
    let md = std::fs::metadata(&real).map_err(|e| format!("{}: {e}", real.display()))?;
    if !md.is_file() {
        return Err(format!("{} is not a file", real.display()));
    }
    Ok(real)
}

/// sha256 of the entry file. INFORMATIONAL (audit log) — never enforced.
pub fn file_sha256(p: &Path) -> Result<String, String> {
    let md = std::fs::metadata(p).map_err(|e| format!("{}: {e}", p.display()))?;
    if md.len() > MAX_FILE_BYTES {
        return Err(format!("{} is too large to hash", p.display()));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(sha256_hex(&bytes))
}

// ------------------------------------------------------------------ store

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub approved_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    approvals: BTreeMap<String, Approval>,
}

pub fn load(store: &Path) -> BTreeMap<String, Approval> {
    std::fs::read_to_string(store)
        .ok()
        .and_then(|t| serde_json::from_str::<StoreFile>(&t).ok())
        .map(|s| s.approvals)
        .unwrap_or_default()
}

fn save(store: &Path, approvals: BTreeMap<String, Approval>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&StoreFile { approvals }).map_err(|e| e.to_string())?;
    write_private_atomic(store, text.as_bytes()).map_err(|e| format!("cannot write approvals: {e}"))
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Remove one approval (by path, resolved if it still exists) or all.
/// Returns the revoked keys.
///
/// Callers must hold the host's `approval_lock` (read-modify-write).
pub fn revoke(store: &Path, path: Option<&str>) -> Result<Vec<String>, String> {
    let mut all = load(store);
    let removed: Vec<String> = match path {
        None => all.keys().cloned().collect(),
        Some(p) => {
            let real = std::fs::canonicalize(p)
                .map(|r| r.to_string_lossy().into_owned())
                .unwrap_or_else(|_| p.to_string());
            all.keys().filter(|k| **k == real || **k == p).cloned().collect()
        }
    };
    for k in &removed {
        all.remove(k);
    }
    if !removed.is_empty() {
        save(store, all)?;
    }
    Ok(removed)
}

/// Stamp `lastRunAt` on an existing approval (no-op if it was revoked).
/// Callers must hold the host's `approval_lock`.
pub fn touch_last_run(store: &Path, key: &str) -> Result<(), String> {
    let mut all = load(store);
    match all.get_mut(key) {
        Some(a) => a.last_run_at = Some(now_ms()),
        None => return Ok(()),
    }
    save(store, all)
}

// ------------------------------------------------------------------ prompt

/// Asks a human. Implementations must deny when there is no UI.
pub trait Prompter: Send + Sync {
    /// Plain yes/no (kill-switch re-arm).
    fn confirm(&self, title: &str, message: &str) -> bool;

    /// Once / Always / Deny for an automation. Default: a plain "yes" is a
    /// persistent approval (mocks); the native dialog overrides this.
    fn decide(&self, title: &str, message: &str) -> Decision {
        if self.confirm(title, message) {
            Decision::Always
        } else {
            Decision::Deny
        }
    }
}

/// Always denies (no UI available / `--no-ui`).
pub struct DenyPrompter;
impl Prompter for DenyPrompter {
    fn confirm(&self, _t: &str, _m: &str) -> bool {
        false
    }
}

pub fn prompt_message(name: &str, real_path: &Path) -> String {
    format!(
        "Allow the automation \"{name}\" to control your mouse and keyboard?\n\nPath: {}\n\n\
         \"Allow once\" runs it this one time. \"Always allow\" remembers this path (any later edits \
         to the file are NOT re-checked) until you revoke it.\n\nOnly approve scripts you have read and trust.",
        real_path.display()
    )
}

/// State captured BEFORE the dialog opens; compared again after it closes.
#[derive(Clone, Debug)]
pub struct Prepared {
    pub real_path: PathBuf,
    pub key: String,
    /// The store record for `key` when the prompt started.
    pub existing: Option<Approval>,
}

/// Resolve the path and snapshot its store record.
/// Callers should hold `approval_lock` so the snapshot is consistent.
pub fn prepare(store: &Path, path: &str) -> Result<Prepared, String> {
    let real_path = canonical(path)?;
    let key = real_path.to_string_lossy().into_owned();
    let existing = load(store).get(&key).cloned();
    Ok(Prepared { real_path, key, existing })
}

/// Show the dialog (blocking; up to the prompter's timeout). Touches no state.
pub fn ask(p: &Prepared, prompter: &dyn Prompter) -> Decision {
    let name = p.real_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    prompter.decide("knowhow computer host — approve automation", &prompt_message(&name, &p.real_path))
}

/// Apply a dialog decision with compare-and-set semantics: re-reads the store
/// and refuses if the record for this path changed since [`prepare`] (e.g. it
/// was revoked while the dialog was open). Only this ONE entry is ever
/// written — a stale copy of the whole map is never written back.
/// Callers must hold `approval_lock`.
pub fn settle(store: &Path, p: &Prepared, d: Decision, allow_once: bool) -> Result<Kind, String> {
    match d {
        Decision::Deny => Err("automation not approved: approval was denied, timed out or no UI is available".into()),
        Decision::Once if !allow_once => Err(
            "only \"Always allow\" is recorded by approve; use start to run an automation once".into(),
        ),
        _ => {
            let mut all = load(store);
            if all.get(&p.key) != p.existing.as_ref() {
                return Err(format!(
                    "approval for {} changed while the dialog was open; nothing was recorded, try again",
                    p.key
                ));
            }
            if d == Decision::Once {
                return Ok(Kind::Once);
            }
            all.insert(p.key.clone(), Approval { approved_at: now_ms(), last_run_at: None });
            save(store, all)?;
            Ok(Kind::Always)
        }
    }
}

/// Approval check for `path`, prompting when it is not stored. (The host
/// splits this into prepare / ask / settle around its locks; this is the
/// lock-free composition used by tests and simple callers.)
pub fn ensure_approved(
    store: &Path,
    path: &str,
    prompter: &dyn Prompter,
    allow_once: bool,
) -> Result<Approved, String> {
    let p = prepare(store, path)?;
    if p.existing.is_some() {
        return Ok(Approved { real_path: p.real_path, kind: Kind::Always, prompted: false });
    }
    let d = ask(&p, prompter);
    let kind = settle(store, &p, d, allow_once)?;
    Ok(Approved { real_path: p.real_path, kind, prompted: true })
}

// ----------------------------------------------------------- native dialog

/// OS-native confirmation dialog owned by the host process.
/// macOS: osascript; Windows: PowerShell MessageBox; Linux: zenity / kdialog
/// (denies if neither exists). Text is passed via argv / env, never spliced
/// into a script, so script paths cannot inject code.
pub struct NativePrompter {
    pub timeout: Duration,
}

impl Default for NativePrompter {
    fn default() -> Self {
        NativePrompter { timeout: Duration::from_secs(120) }
    }
}

/// `(exit code, stdout)`; None when it could not run or timed out.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Option<(Option<i32>, String)> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let out = child.wait_with_output().ok()?;
                return Some((out.status.code(), String::from_utf8_lossy(&out.stdout).into_owned()));
            }
            Ok(None) if t0.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn on_path(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
        .unwrap_or(false)
}

impl NativePrompter {
    /// Three-way dialog. Anything unexpected is `Deny`.
    #[allow(unused_variables)]
    fn ask3(&self, title: &str, message: &str) -> Decision {
        let secs = self.timeout.as_secs().max(1);
        #[cfg(target_os = "macos")]
        {
            let mut c = Command::new("osascript");
            c.args([
                "-e",
                "on run argv",
                "-e",
                &format!(
                    "display dialog (item 2 of argv) with title (item 1 of argv) buttons {{\"Deny\", \"Allow once\", \"Always allow\"}} default button \"Deny\" cancel button \"Deny\" with icon caution giving up after {secs}"
                ),
                "-e",
                "end run",
                "--",
                title,
                message,
            ]);
            return match run_with_timeout(c, self.timeout + Duration::from_secs(5)) {
                Some((Some(0), out)) if !out.contains("gave up:true") => {
                    if out.contains("button returned:Always allow") {
                        Decision::Always
                    } else if out.contains("button returned:Allow once") {
                        Decision::Once
                    } else {
                        Decision::Deny
                    }
                }
                _ => Decision::Deny,
            };
        }
        #[cfg(target_os = "windows")]
        {
            // MessageBox has no custom labels: Yes = Allow once, No = Always allow, Cancel = Deny.
            let mut c = Command::new("powershell");
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show($env:KH_MSG,$env:KH_TITLE,'YesNoCancel','Warning','Button3'); [Console]::Out.Write([string]$r)",
            ]);
            let msg = format!("{message}\n\n[Yes] Allow once    [No] Always allow    [Cancel] Deny");
            c.env("KH_MSG", msg).env("KH_TITLE", title);
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
            return match run_with_timeout(c, self.timeout) {
                Some((Some(0), out)) => match out.trim() {
                    "Yes" => Decision::Once,
                    "No" => Decision::Always,
                    _ => Decision::Deny,
                },
                _ => Decision::Deny,
            };
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            if on_path("zenity") {
                let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
                let mut c = Command::new("zenity");
                c.args(["--question", "--title", title, "--text", &esc(message)])
                    .args(["--ok-label", "Allow once", "--cancel-label", "Deny"])
                    .args(["--extra-button", "Always allow"])
                    .arg(format!("--timeout={secs}"));
                // OK => exit 0; the extra button prints its label and exits 1.
                return match run_with_timeout(c, self.timeout + Duration::from_secs(5)) {
                    Some((Some(0), _)) => Decision::Once,
                    Some((_, out)) if out.trim() == "Always allow" => Decision::Always,
                    _ => Decision::Deny,
                };
            }
            if on_path("kdialog") {
                let mut c = Command::new("kdialog");
                c.args(["--title", title, "--warningyesnocancel", message])
                    .args(["--yes-label", "Allow once", "--no-label", "Always allow", "--cancel-label", "Deny"]);
                // yes = 0, no = 1, cancel = 2
                return match run_with_timeout(c, self.timeout) {
                    Some((Some(0), _)) => Decision::Once,
                    Some((Some(1), _)) => Decision::Always,
                    _ => Decision::Deny,
                };
            }
            Decision::Deny
        }
    }

    /// Two-way dialog (kill-switch re-arm).
    #[allow(unused_variables)]
    fn ask2(&self, title: &str, message: &str) -> bool {
        let secs = self.timeout.as_secs().max(1);
        #[cfg(target_os = "macos")]
        {
            let mut c = Command::new("osascript");
            c.args([
                "-e",
                "on run argv",
                "-e",
                &format!(
                    "display dialog (item 2 of argv) with title (item 1 of argv) buttons {{\"Deny\", \"Approve\"}} default button \"Deny\" cancel button \"Deny\" with icon caution giving up after {secs}"
                ),
                "-e",
                "end run",
                "--",
                title,
                message,
            ]);
            return matches!(
                run_with_timeout(c, self.timeout + Duration::from_secs(5)),
                Some((Some(0), out)) if out.contains("button returned:Approve") && !out.contains("gave up:true")
            );
        }
        #[cfg(target_os = "windows")]
        {
            let mut c = Command::new("powershell");
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.MessageBox]::Show($env:KH_MSG,$env:KH_TITLE,'YesNo','Warning','Button2'); if($r -eq 'Yes'){exit 0}else{exit 1}",
            ]);
            c.env("KH_MSG", message).env("KH_TITLE", title);
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
            return matches!(run_with_timeout(c, self.timeout), Some((Some(0), _)));
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            if on_path("zenity") {
                let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
                let mut c = Command::new("zenity");
                c.args(["--question", "--title", title, "--text", &esc(message)])
                    .args(["--ok-label", "Approve", "--cancel-label", "Deny"])
                    .arg(format!("--timeout={secs}"));
                return matches!(run_with_timeout(c, self.timeout + Duration::from_secs(5)), Some((Some(0), _)));
            }
            if on_path("kdialog") {
                let mut c = Command::new("kdialog");
                c.args(["--title", title, "--warningyesno", message]);
                return matches!(run_with_timeout(c, self.timeout), Some((Some(0), _)));
            }
            false
        }
    }
}

impl Prompter for NativePrompter {
    fn confirm(&self, title: &str, message: &str) -> bool {
        self.ask2(title, message)
    }
    fn decide(&self, title: &str, message: &str) -> Decision {
        self.ask3(title, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    struct Mock {
        answer: Decision,
        calls: AtomicUsize,
        last: Mutex<String>,
    }
    impl Mock {
        fn new(answer: Decision) -> Mock {
            Mock { answer, calls: AtomicUsize::new(0), last: Mutex::new(String::new()) }
        }
    }
    impl Prompter for Mock {
        fn confirm(&self, _t: &str, _m: &str) -> bool {
            self.answer != Decision::Deny
        }
        fn decide(&self, _t: &str, m: &str) -> Decision {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.last.lock().unwrap() = m.to_string();
            self.answer
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("khappr-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn deny_once_always_and_edits_are_not_rechecked() {
        let d = tmp("flow");
        let script = d.join("a.ts");
        let store = d.join("cu").join("approvals.json");
        std::fs::write(&script, "sdk.keepAlive();").unwrap();
        let p = script.to_str().unwrap();
        let key = std::fs::canonicalize(&script).unwrap().to_string_lossy().into_owned();

        // denied: nothing recorded
        let deny = Mock::new(Decision::Deny);
        let e = ensure_approved(&store, p, &deny, true).unwrap_err();
        assert!(e.contains("not approved"), "{e}");
        assert!(load(&store).is_empty());
        assert!(deny.last.lock().unwrap().contains("a.ts"));

        // once: runs, NOT persisted, asks again next time
        let once = Mock::new(Decision::Once);
        let a = ensure_approved(&store, p, &once, true).unwrap();
        assert_eq!(a.kind, Kind::Once);
        assert!(a.prompted);
        assert!(load(&store).is_empty());
        ensure_approved(&store, p, &once, true).unwrap();
        assert_eq!(once.calls.load(Ordering::SeqCst), 2);
        // the IPC `approve` (allow_once=false) refuses a once decision
        let e = ensure_approved(&store, p, &once, false).unwrap_err();
        assert!(e.contains("Always allow"), "{e}");

        // always: persisted by canonical path, no more prompts
        let always = Mock::new(Decision::Always);
        let a = ensure_approved(&store, p, &always, true).unwrap();
        assert_eq!(a.kind, Kind::Always);
        assert_eq!(a.real_path, std::fs::canonicalize(&script).unwrap());
        assert!(load(&store).contains_key(&key));
        let a2 = ensure_approved(&store, p, &deny, true).unwrap();
        assert!(!a2.prompted);
        assert_eq!(a2.kind, Kind::Always);

        // editing the file does NOT invalidate the approval (path-based)
        std::fs::write(&script, "sdk.keepAlive(); // edited").unwrap();
        let a3 = ensure_approved(&store, p, &deny, true).unwrap();
        assert!(!a3.prompted);
        assert_eq!(deny.calls.load(Ordering::SeqCst), 1);

        // a symlink resolves to the same canonical key
        #[cfg(unix)]
        {
            let link = d.join("link.ts");
            std::os::unix::fs::symlink(&script, &link).unwrap();
            assert!(!ensure_approved(&store, link.to_str().unwrap(), &deny, true).unwrap().prompted);
        }

        // lastRunAt
        assert!(load(&store)[&key].last_run_at.is_none());
        touch_last_run(&store, &key).unwrap();
        assert!(load(&store)[&key].last_run_at.is_some());

        // revoke
        assert_eq!(revoke(&store, Some(p)).unwrap(), vec![key.clone()]);
        assert!(load(&store).is_empty());
        touch_last_run(&store, &key).unwrap(); // no-op, does not resurrect
        assert!(load(&store).is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn legacy_hash_records_still_load() {
        let d = tmp("legacy");
        let store = d.join("approvals.json");
        std::fs::write(
            &store,
            r#"{"approvals":{"/x/a.ts":{"sha256":"abc","approvedAt":5,"files":[{"path":"/x/a.ts","sha256":"abc"}]}}}"#,
        )
        .unwrap();
        let all = load(&store);
        assert_eq!(all["/x/a.ts"].approved_at, 5);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn settle_is_compare_and_set() {
        let d = tmp("cas");
        let store = d.join("approvals.json");
        let a = d.join("a.ts");
        let b = d.join("b.ts");
        std::fs::write(&a, "x").unwrap();
        std::fs::write(&b, "x").unwrap();
        // A is approved; B's dialog opens (snapshot has no B record)
        ensure_approved(&store, a.to_str().unwrap(), &Mock::new(Decision::Always), true).unwrap();
        let pb = prepare(&store, b.to_str().unwrap()).unwrap();
        // ... meanwhile A is revoked
        revoke(&store, Some(a.to_str().unwrap())).unwrap();
        // B approved afterwards: only B is written, A stays revoked
        assert_eq!(settle(&store, &pb, Decision::Always, true).unwrap(), Kind::Always);
        let all = load(&store);
        assert_eq!(all.len(), 1);
        assert!(all.contains_key(&pb.key));

        // the record for the SAME path changed during the dialog: refuse
        let pa = prepare(&store, a.to_str().unwrap()).unwrap(); // existing: None
        let other = Approval { approved_at: 1, last_run_at: None };
        let mut m = load(&store);
        m.insert(pa.key.clone(), other.clone());
        save(&store, m).unwrap();
        let e = settle(&store, &pa, Decision::Always, true).unwrap_err();
        assert!(e.contains("changed while the dialog was open"), "{e}");
        assert_eq!(load(&store)[&pa.key], other);
        let e = settle(&store, &pa, Decision::Once, true).unwrap_err();
        assert!(e.contains("changed while the dialog was open"), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn audit_hash_is_informational() {
        let d = tmp("hash");
        let f = d.join("a.ts");
        std::fs::write(&f, "sdk.keepAlive();").unwrap();
        assert_eq!(file_sha256(&f).unwrap(), sha256_hex(b"sdk.keepAlive();"));
        assert!(file_sha256(&d.join("nope")).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_file_and_deny_prompter() {
        assert!(canonical("/definitely/not/here.ts").is_err());
        let d = tmp("deny");
        std::fs::write(d.join("a.ts"), "x").unwrap();
        let r = ensure_approved(&d.join("ap.json"), d.join("a.ts").to_str().unwrap(), &DenyPrompter, true);
        assert!(r.is_err());
        // directories are not automations
        assert!(canonical(d.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
