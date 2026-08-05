// server.js
// Place this file in the same directory as your index.html and run with `node server.js`
// Requirements:
// - Serves static files from the same directory (index.html etc.)
// - Exposes a /keep-alive endpoint
// - Pings SELF_URL (or local URL) every N minutes (5-15, default 10) to prevent sleep
//
// Environment variables:
// - PORT (default: 3000)
// - SELF_URL (recommended in production, e.g. "https://your-app.onrender.com/keep-alive")
// - KEEP_ALIVE_PATH (default: "/keep-alive")
// - PING_INTERVAL_MINUTES (default: 10, clamped to 5-15)

const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');

const app = express();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const KEEP_ALIVE_PATH = process.env.KEEP_ALIVE_PATH || '/keep-alive';

// clamp interval to 5..15 minutes as requested
const DEFAULT_MINUTES = 10;
let pingMinutes = process.env.PING_INTERVAL_MINUTES
  ? parseInt(process.env.PING_INTERVAL_MINUTES, 10)
  : DEFAULT_MINUTES;
if (Number.isNaN(pingMinutes)) pingMinutes = DEFAULT_MINUTES;
pingMinutes = Math.max(5, Math.min(15, pingMinutes));

const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}${KEEP_ALIVE_PATH}`;

// Protect exposing this server file itself: block requests to /server.js
app.use((req, res, next) => {
  const reqPath = req.path.split('?')[0];
  const serverFile = '/' + path.basename(__filename);
  if (reqPath === serverFile || reqPath.endsWith(serverFile)) {
    return res.status(404).send('Not found');
  }
  next();
});

// Serve static files from current directory (where index.html resides)
app.use(express.static(path.join(__dirname)));

// Root fallback: serve index.html if present
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) {
      res.status(404).send('index.html not found. Put your static files in the same folder as server.js.');
    }
  });
});

// keep-alive endpoint
app.get(KEEP_ALIVE_PATH, (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    message: 'keep-alive endpoint'
  });
});

// Lightweight fetch-like GET implementation for Node <18 or when global fetch is absent.
// Returns an object with `status` and `text()` method.
function simpleFetch(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: 'GET',
        timeout
      };
      const req = lib.request(options, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: () => Promise.resolve(body),
            json: () => {
              try {
                return Promise.resolve(JSON.parse(body));
              } catch (e) {
                return Promise.reject(e);
              }
            }
          });
        });
      });
      req.on('error', (err) => reject(err));
      req.on('timeout', () => {
        req.destroy(new Error('Request timed out'));
      });
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

const doFetch = (typeof globalThis.fetch === 'function') ? (url => globalThis.fetch(url)) : simpleFetch;

// Keep-alive loop
let pingCounter = 0;
async function pingSelf() {
  const url = SELF_URL;
  const start = Date.now();
  try {
    const res = await doFetch(url);
    const elapsed = Date.now() - start;
    const status = res && res.status ? res.status : 'unknown';
    pingCounter += 1;
    console.log(`[keep-alive] #${pingCounter} -> ${url} status=${status} time=${elapsed}ms`);
  } catch (err) {
    pingCounter += 1;
    console.error(`[keep-alive] #${pingCounter} -> ${url} error:`, (err && err.message) ? err.message : err);
  }
}

function startKeepAlive() {
  console.log(`[keep-alive] SELF_URL=${SELF_URL}`);
  console.log(`[keep-alive] interval=${pingMinutes} minute(s) (clamped to 5..15)`);

  // initial immediate ping
  pingSelf().catch(() => { /* ignore */ });

  const intervalMs = pingMinutes * 60 * 1000;

  // Add a small random jitter (0-30s) before each scheduled ping to avoid strict synchronization
  setInterval(() => {
    const jitter = Math.floor(Math.random() * 30000);
    setTimeout(() => {
      pingSelf().catch(() => { /* ignore */ });
    }, jitter);
  }, intervalMs);
}

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Serving static files from: ${__dirname}`);
  startKeepAlive();
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  server.close(() => {
    process.exit(0);
  });
  // force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
