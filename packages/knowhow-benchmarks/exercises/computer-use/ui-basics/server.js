#!/usr/bin/env node
// Deterministic, dependency-free UI Basics benchmark server.
const http = require('http');
const fs = require('fs');
const path = require('path');
// The shared computer-use runner probes port 7432 by default.
const PORT = Number(process.env.BENCH_PORT || 7432);
const results = [];
function cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
function json(res, value, status = 200) { cors(res); res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(value)); }
function body(req) { return new Promise((resolve, reject) => { let s=''; req.on('data', c => s += c); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); req.on('error', reject); }); }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/health') return json(res, { ok: true, exercise: 'ui-basics', submissions: results.length });
  if (req.method === 'GET' && url.pathname === '/api/results') return json(res, { exercise: 'ui-basics', results: results.slice() });
  // Keep the same collection shape used by the existing computer-use runner.
  if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, results.slice());
  if (req.method === 'POST' && url.pathname === '/api/results') {
    try { const value = await body(req); const result = { ...value, receivedAt: new Date().toISOString() }; results.push(result); return json(res, { ok: true, result }); }
    catch (_) { return json(res, { ok: false, error: 'Invalid JSON' }, 400); }
  }
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try { const html = fs.readFileSync(path.join(__dirname, 'index.html')); cors(res); res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return res.end(html); }
    catch (_) { res.writeHead(404); return res.end('Not found'); }
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(PORT, '0.0.0.0', () => console.log(`UI Basics server listening on http://localhost:${PORT}`));
server.on('error', err => { console.error(err.message); process.exit(1); });
