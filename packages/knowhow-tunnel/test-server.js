#!/usr/bin/env node

/**
 * Simple HTTP test server for tunnel testing
 * 
 * Usage:
 *   node test-server.js [port]
 * 
 * Examples:
 *   node test-server.js 3000
 *   node test-server.js 8080
 */

const http = require('http');

const port = parseInt(process.argv[2] || '3000', 10);

const server = http.createServer((req, res) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  
  // Echo endpoint - returns request info
  if (req.url === '/echo') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body || undefined,
        timestamp: new Date().toISOString(),
      }, null, 2));
    });
    return;
  }
  
  // Large response endpoint - tests streaming
  if (req.url === '/large') {
    const size = parseInt(req.headers['x-size'] || '1048576', 10); // 1MB default
    res.writeHead(200, { 
      'Content-Type': 'text/plain',
      'Content-Length': size,
    });
    
    // Stream data in chunks
    let sent = 0;
    const chunkSize = 65536; // 64KB chunks
    const interval = setInterval(() => {
      const remaining = size - sent;
      if (remaining <= 0) {
        clearInterval(interval);
        res.end();
        console.log(`Sent ${sent} bytes`);
        return;
      }
      
      const toSend = Math.min(chunkSize, remaining);
      const chunk = Buffer.alloc(toSend, 'x');
      res.write(chunk);
      sent += toSend;
    }, 10);
    return;
  }
  
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port, timestamp: new Date().toISOString() }));
    return;
  }
  
  // Default response
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>Tunnel Test Server</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
    pre { background: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>🌐 Tunnel Test Server</h1>
  <p>Running on <code>http://localhost:${port}</code></p>
  
  <h2>Available Endpoints:</h2>
  <ul>
    <li><code>GET /</code> - This page</li>
    <li><code>GET /health</code> - Health check (returns JSON)</li>
    <li><code>GET|POST /echo</code> - Echo request details</li>
    <li><code>GET /large</code> - Stream large response (use X-Size header for custom size)</li>
  </ul>
  
  <h2>Test Examples:</h2>
  <pre>
# Health check
curl http://localhost:${port}/health

# Echo request
curl -X POST http://localhost:${port}/echo -d '{"test": true}'

# Large response (5MB)
curl -H "X-Size: 5242880" http://localhost:${port}/large > /dev/null
  </pre>
  
  <p><small>Request: ${req.method} ${req.url}</small></p>
</body>
</html>
  `);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`✓ Test server running at http://127.0.0.1:${port}`);
  console.log(`  - GET  /         → HTML test page`);
  console.log(`  - GET  /health   → Health check`);
  console.log(`  - POST /echo     → Echo request`);
  console.log(`  - GET  /large    → Large response (streaming)`);
  console.log('\nPress Ctrl+C to stop');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
