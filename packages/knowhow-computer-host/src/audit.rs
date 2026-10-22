//! Append-only audit trail (`~/.knowhow/computer-use/audit.log`, JSONL, 0600).
//!
//! One JSON object per line: `ts` (ms since epoch), `event`
//! (approve|deny|revoke|start|exit|halt|rearm), and optionally `path`,
//! `sha256` (start only; informational), `workerId`, `pid`, `kind`
//! (once|always), `code` (exit code), `detail`.
//!
//! Best effort: a failure to write is reported on stderr but never changes
//! the outcome of the operation being logged.

use crate::security::{ensure_private_dir, open_private_append};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(default)]
    pub ts: u64,
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Entry {
    pub fn new(event: &str) -> Entry {
        Entry { event: event.to_string(), ..Default::default() }
    }
    pub fn path(mut self, p: impl Into<String>) -> Entry {
        self.path = Some(p.into());
        self
    }
    pub fn sha256(mut self, s: impl Into<String>) -> Entry {
        self.sha256 = Some(s.into());
        self
    }
    pub fn worker(mut self, id: impl Into<String>, pid: Option<u32>) -> Entry {
        self.worker_id = Some(id.into());
        self.pid = pid;
        self
    }
    pub fn kind(mut self, k: impl Into<String>) -> Entry {
        self.kind = Some(k.into());
        self
    }
    pub fn code(mut self, c: Option<i32>) -> Entry {
        self.code = c;
        self
    }
    pub fn detail(mut self, d: impl Into<String>) -> Entry {
        self.detail = Some(d.into());
        self
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Serializes appends within this process so lines never interleave.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Append one entry (a single `write` of one line on an O_APPEND file).
pub fn append(path: &Path, mut e: Entry) -> std::io::Result<()> {
    if e.ts == 0 {
        e.ts = now_ms();
    }
    let mut line = serde_json::to_string(&e).map_err(|x| std::io::Error::new(std::io::ErrorKind::Other, x))?;
    line.push('\n');
    let _g = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(dir) = path.parent() {
        ensure_private_dir(dir)?;
    }
    let mut f = open_private_append(path)?;
    f.write_all(line.as_bytes())
}

/// Best-effort [`append`]: failures go to stderr.
pub fn record(path: &Path, e: Entry) {
    if let Err(err) = append(path, e) {
        eprintln!("knowhow-computer-host: cannot write audit log {}: {err}", path.display());
    }
}

/// The last `limit` entries, oldest first. Malformed lines are skipped.
pub fn read_tail(path: &Path, limit: usize) -> Vec<Entry> {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<Entry> = text.lines().filter_map(|l| serde_json::from_str::<Entry>(l).ok()).collect();
    let skip = all.len().saturating_sub(limit);
    all.into_iter().skip(skip).collect()
}

pub fn default_path() -> PathBuf {
    crate::config::audit_path()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_and_tail() {
        let d = std::env::temp_dir().join(format!("khaudit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        let p = d.join("cu").join("audit.log");
        append(&p, Entry::new("approve").path("/a.ts").kind("always")).unwrap();
        append(&p, Entry::new("start").path("/a.ts").sha256("abc").worker("w1", Some(7))).unwrap();
        append(&p, Entry::new("exit").worker("w1", None).code(Some(0))).unwrap();
        let all = read_tail(&p, 100);
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].event, "approve");
        assert_eq!(all[0].kind.as_deref(), Some("always"));
        assert!(all[0].ts > 0);
        assert_eq!(all[1].sha256.as_deref(), Some("abc"));
        assert_eq!(all[2].code, Some(0));
        let last = read_tail(&p, 2);
        assert_eq!(last.len(), 2);
        assert_eq!(last[0].event, "start");
        // JSONL on disk
        let text = std::fs::read_to_string(&p).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(text.contains("\"workerId\":\"w1\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
