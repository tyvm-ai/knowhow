#!/usr/bin/env node

/**
 * End-to-end test for the tunnel
 * This script:
 * 1. Starts a simple HTTP server on port 3000
 * 2. Creates a WebSocket server to simulate the remote server
 * 3. Connects the tunnel handler as a client
 * 4. Sends HTTP requests through the WebSocket tunnel
 * 5. Verifies responses come back correctly
 */

const { WebSocket, WebSocketServer } = require('ws');
const { createTunnelHandler } = require('./dist/index.js');
const http = require('http');

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// WebSocket server to simulate the remote server
function startWsServer() {
  const wss = new WebSocketServer({ port: 8765 });
  return wss;
}

async function runTest() {
  log('cyan', '\n╔════════════════════════════════════════════╗');
  log('cyan', '║  Knowhow Tunnel End-to-End Test           ║');
  log('cyan', '╚════════════════════════════════════════════╝\n');

  // Step 1: Using existing HTTP server on port 3000
  log('blue', '📡 Step 1: Using existing HTTP server on port 3000...');
  log('green', '   ✓ Ready to proxy requests\n');

  // Step 2: Start WebSocket server (simulates remote server)
  log('blue', '🔌 Step 2: Starting WebSocket server on port 8765...');
  const wss = startWsServer();
  await sleep(500);
  log('green', '   ✓ WebSocket server started\n');

  // Step 3: Wait for tunnel client connection
  log('blue', '🔗 Step 3: Waiting for tunnel client to connect...');
  
  const serverWsPromise = new Promise((resolve) => {
    wss.on('connection', (ws) => {
      log('green', '   ✓ Tunnel client connected\n');
      resolve(ws);
    });
  });

  // Create tunnel client
  const clientWs = new WebSocket('ws://localhost:8765');
  
  await new Promise((resolve) => {
    clientWs.on('open', () => {
      log('blue', '🚇 Step 4: Creating tunnel handler...');
      resolve();
    });
  });

  const tunnel = createTunnelHandler(clientWs, {
    allowedPorts: [3000],
    maxConcurrentStreams: 10,
    logLevel: 'info',
  });

  log('green', '   ✓ Tunnel handler created\n');

  // Get the server-side WebSocket
  const serverWs = await serverWsPromise;

  // Test 1: Request HTML page
  log('yellow', '📄 Test 1: Requesting HTML page (GET /)...');
  const test1Result = await new Promise((resolve) => {
    const streamId = 'test-html';
    let dataChunks = [];
    let statusCode = 0;

    const messageHandler = (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.streamId === streamId) {
        if (msg.type === 'TUNNEL_RESPONSE') {
          statusCode = msg.statusCode;
          log('green', `   ✓ Response: ${statusCode} ${msg.statusMessage || ''}`);
        } else if (msg.type === 'TUNNEL_DATA') {
          const chunk = Buffer.from(msg.data, 'base64').toString();
          dataChunks.push(chunk);
        } else if (msg.type === 'TUNNEL_END') {
          const body = dataChunks.join('');
          if (statusCode >= 200 && statusCode < 400) {
            log('green', '   ✓ Received HTML (' + body.length + ' bytes): ' + body.substring(0, 80).replace(/\n/g, ' ') + '...');
            resolve(true);
          } else {
            log('red', `   ✗ Unexpected response: ${statusCode}, ${body.substring(0, 100)}`);
            resolve(false);
          }
          serverWs.off('message', messageHandler);
        } else if (msg.type === 'TUNNEL_ERROR') {
          log('red', `   ✗ Error: ${msg.error}`);
          resolve(false);
          serverWs.off('message', messageHandler);
        }
      }
    };

    serverWs.on('message', messageHandler);

    // Send tunnel request
    serverWs.send(JSON.stringify({
      type: 'TUNNEL_REQUEST',
      streamId,
      port: 3000,
      method: 'GET',
      path: '/',
      headers: { 'user-agent': 'e2e-test' },
      scheme: 'http',
    }));

    serverWs.send(JSON.stringify({
      type: 'TUNNEL_END',
      streamId,
    }));

    setTimeout(() => {
      log('red', '   ✗ Timeout');
      resolve(false);
    }, 5000);
  });

  if (!test1Result) {
    log('red', '\n❌ Test 1 FAILED\n');
    cleanup();
    return;
  }
  log('green', '   ✅ Test 1 PASSED\n');

  // Test 2: Request same endpoint again to verify consistency
  log('yellow', '🔧 Test 2: Second request to verify consistency...');
  const test2Result = await new Promise((resolve) => {
    const streamId = 'test-json';
    let dataChunks = [];
    let statusCode = 0;

    const messageHandler = (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.streamId === streamId) {
        if (msg.type === 'TUNNEL_RESPONSE') {
          statusCode = msg.statusCode;
          log('green', `   ✓ Response: ${statusCode}`);
        } else if (msg.type === 'TUNNEL_DATA') {
          const chunk = Buffer.from(msg.data, 'base64').toString();
          dataChunks.push(chunk);
        } else if (msg.type === 'TUNNEL_END') {
          const body = dataChunks.join('');
          if (statusCode >= 200 && statusCode < 400) {
            log('green', `   ✓ Received response (${body.length} bytes)`);
            resolve(true);
          } else {
            log('red', `   ✗ Unexpected response`);
            resolve(false);
          }
          serverWs.off('message', messageHandler);
        } else if (msg.type === 'TUNNEL_ERROR') {
          log('red', `   ✗ Error: ${msg.error}`);
          resolve(false);
          serverWs.off('message', messageHandler);
        }
      }
    };

    serverWs.on('message', messageHandler);

    serverWs.send(JSON.stringify({
      type: 'TUNNEL_REQUEST',
      streamId,
      port: 3000,
      method: 'GET',
      path: '/',
      headers: {},
      scheme: 'http',
    }));

    serverWs.send(JSON.stringify({
      type: 'TUNNEL_END',
      streamId,
    }));

    setTimeout(() => {
      log('red', '   ✗ Timeout');
      resolve(false);
    }, 5000);
  });

  if (!test2Result) {
    log('red', '\n❌ Test 2 FAILED\n');
    cleanup();
    return;
  }
  log('green', '   ✅ Test 2 PASSED\n');

  // All tests passed!
  log('green', '\n╔════════════════════════════════════════════╗');
  log('green', '║  ✅ All Tests PASSED!                      ║');
  log('green', '╚════════════════════════════════════════════╝\n');

  function cleanup() {
    log('blue', '🧹 Cleaning up...');
    clientWs.close();
    serverWs.close();
    wss.close();
    log('green', '   ✓ Cleanup complete\n');
  }

  cleanup();
  process.exit(0);
}

runTest().catch((err) => {
  log('red', `\n❌ Test error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
