#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 8443;
const ROOT = __dirname;
const BIND_MODE = process.env.BIND || 'lan';

function getNetworkIPs() {
  const ips = ['127.0.0.1'];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces).sort()) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return [...new Set(ips)];
}

const NET_IPS = getNetworkIPs();
const LAN_IP = NET_IPS.find(ip => ip !== '127.0.0.1') || null;
const HOST = BIND_MODE === 'all' ? '0.0.0.0' : (LAN_IP || '127.0.0.1');

function log(msg) {
  console.log('[vidit]', msg);
}

// ── Self-signed cert (ECDSA P-384, 10yr) ──────────────────────────────────
function ensureCert(extraIPs) {
  const keyFile = path.join(ROOT, 'key.pem');
  const certFile = path.join(ROOT, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) return;
  const san = ['DNS:localhost', 'IP:127.0.0.1'];
  for (const ip of (extraIPs || [])) {
    if (ip !== '127.0.0.1') san.push(`IP:${ip}`);
  }
  log('Generating self-signed ECDSA P-384 certificate (10yr)...');
  execSync(
    `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp384r1 ` +
    `-days 3650 -nodes -keyout "${keyFile}" -out "${certFile}" ` +
    `-subj "/CN=Vidit" ` +
    `-addext "subjectAltName=${san.join(',')}"`,
    { stdio: 'inherit' }
  );
  log('Certificate ready: cert.pem + key.pem');
}

// ── Secure TLS options (TLS 1.3 only) ─────────────────────────────────────
function tlsOptions() {
  return {
    key: fs.readFileSync(path.join(ROOT, 'key.pem')),
    cert: fs.readFileSync(path.join(ROOT, 'cert.pem')),
    secureOptions:
      crypto.constants.SSL_OP_NO_SSLv2 |
      crypto.constants.SSL_OP_NO_SSLv3 |
      crypto.constants.SSL_OP_NO_TLSv1 |
      crypto.constants.SSL_OP_NO_TLSv1_1,
    honorCipherOrder: true,
    ecdhCurve: 'auto',
    minVersion: 'TLSv1.3',
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown; charset=utf-8',
};

// ── Rate limiter ──────────────────────────────────────────────────────────
const RATE_WINDOW = 60_000;
const RATE_MAX = 100;
const rateMap = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, entries] of rateMap) {
    const valid = entries.filter(t => now - t < RATE_WINDOW);
    if (valid.length) rateMap.set(ip, valid);
    else rateMap.delete(ip);
  }
}, 30_000);

function isRateLimited(ip) {
  const now = Date.now();
  let entries = rateMap.get(ip);
  if (!entries) {
    entries = [];
    rateMap.set(ip, entries);
  }
  entries.push(now);
  return entries.filter(t => now - t < RATE_WINDOW).length > RATE_MAX;
}

// ── Security headers applied to every response ────────────────────────────
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=self, microphone=self, geolocation=self',
};

const MAX_BODY = 10 * 1024 * 1024;

function serve(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(k, v);
  }

  // Rate limit
  const ip = req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Too many requests');
    return;
  }

  // Body size limit
  const cl = parseInt(req.headers['content-length'], 10);
  if (cl > MAX_BODY) {
    res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Request too large');
    return;
  }

  // Log request
  log(`${req.method} ${req.url} from ${ip}`);

  // Normalise path — default to index.html
  let p = req.url.split('?')[0].split('#')[0];
  if (p === '/') p = '/index.html';
  const filePath = path.normalize(path.join(ROOT, p));

  // Only allow known extensions
  const ext = path.extname(filePath).toLowerCase();
  if (!MIME[ext]) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  // Prevent directory traversal
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] });
    res.end(data);
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
ensureCert(NET_IPS);

const server = https.createServer(tlsOptions(), serve);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${PORT} is already in use`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const hostDisplay = HOST === '0.0.0.0' ? 'localhost' : HOST;
  log(`Mode: ${BIND_MODE}${BIND_MODE === 'lan' ? ' (use BIND=all for all interfaces)' : ''}`);
  log(`Server running at https://${hostDisplay}:${PORT}`);
  if (BIND_MODE === 'all' && LAN_IP) {
    log(`LAN access:  https://${LAN_IP}:${PORT}`);
  }
});

function shutdown() {
  log('Shutting down...');
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
