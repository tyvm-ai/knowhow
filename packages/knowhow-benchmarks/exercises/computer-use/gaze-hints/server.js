#!/usr/bin/env node
/**
 * Gaze-hints benchmark server.
 * Serves index.html and exposes /api/elements for the harness.
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.argv[2] || process.env.PORT || '7436', 10);

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

const clickLog = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/api/click' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try { clickLog.push(JSON.parse(body)); } catch {}
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (url.pathname === '/api/clicks') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(clickLog));
    return;
  }

  // Static files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.join(__dirname, filePath);
  if (!abs.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(abs)) { res.writeHead(404); res.end('Not found'); return; }

  const ext = path.extname(abs);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime });
  fs.createReadStream(abs).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Gaze-hints benchmark server running at http://localhost:${PORT}`);
});

module.exports = { server, PORT };
