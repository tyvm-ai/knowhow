// Tiny fake knowhow-computer-host speaking the NDJSON protocol (for tests).
const net = require("net");
const fs = require("fs");
const path = require("path");

async function startFakeHost(dir) {
  const sock = path.join(dir, "host.sock");
  const received = []; // every parsed client message
  const conns = [];
  // Optional per-type overrides: handlers[type] = (msg) => ({ ok, result } | { ok:false, error })
  const handlers = {};
  const status = { version: "0", pid: 1, killSwitch: "ctrl+alt+esc", killSwitchArmed: true, platform: "test" };
  const server = net.createServer((c) => {
    const conn = { c, role: null };
    conns.push(conn);
    c.setEncoding("utf8");
    let buf = "";
    const reply = (reqId, ok, body) =>
      reqId !== undefined && c.write(JSON.stringify(ok ? { reqId, ok, result: body } : { reqId, ok, error: body }) + "\n");
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        received.push(msg);
        if (msg.type === "hello") {
          conn.role = msg.role;
          reply(msg.reqId, true, msg.role === "worker" ? { ...status, workerId: msg.workerId } : status);
        } else if (handlers[msg.type]) {
          const r = handlers[msg.type](msg);
          reply(msg.reqId, r.ok !== false, r.ok !== false ? r.result : r.error);
        } else if (msg.type === "silent") {
          /* never answers: for timeout tests */
        } else if (msg.type === "status") reply(msg.reqId, true, status);
        else if (msg.type === "list") reply(msg.reqId, true, { workers: [] });
        else if (msg.type === "registerHotkey") {
          if (msg.chord === "ctrl+alt+escape") reply(msg.reqId, false, "reserved for the kill switch");
          else reply(msg.reqId, true, { id: msg.id });
        } else reply(msg.reqId, true, {});
      }
    });
    c.on("error", () => {});
  });
  await new Promise((r) => server.listen(sock, r));
  return {
    sock,
    received,
    handlers,
    status,
    ofType: (t) => received.filter((m) => m.type === t),
    /** Push a host->worker event to every worker connection. */
    push: (ev) => conns.filter((x) => x.role === "worker").forEach((x) => x.c.write(JSON.stringify(ev) + "\n")),
    async close() {
      conns.forEach((x) => x.c.destroy());
      await new Promise((r) => server.close(r));
      try { fs.unlinkSync(sock); } catch {}
    },
  };
}

module.exports = { startFakeHost };
