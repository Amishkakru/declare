// Declare server: static files + one WebSocket endpoint. Zero config locally (`npm start`);
// behind a hosting platform it reads PORT and trusts the platform proxy's X-Forwarded-For.

import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room, REAL_TIMING, FAST_TIMING } from './room.js';
import { ROUND_CHOICES, PENALTY_CHOICES } from '../engine/round.js';
import { clientIp, isLocalHost, originAllowed, Hits, Bucket } from './guard.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ENGINE_DIR = path.join(ROOT, 'engine'); // card values and powers are shared with the browser
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json']);
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const IDLE_MS = 20 * 60 * 1000;

// Everything is served from this origin, so the policy can be strict. Inline style attributes are used
// for a few computed widths; WebSockets are listed explicitly because older Safari ignores 'self' for them.
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    + "font-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

const DEFAULT_LIMITS = {
  maxRooms: 300, // tables alive at once
  createsPerHour: 30, // new tables per network address
  connsPerIp: 50, // open sockets per network address (campus and office Wi-Fi share one)
  wrongCodes: 30, // wrong table codes per network address per 10 minutes
  msgRate: 15, msgBurst: 40, // messages per second per socket
};
const FAST_LIMITS = { msgRate: 5000, msgBurst: 5000 };

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

// Static files are read once, compressed once, and re-read only when the file changes on disk.
const assets = new Map();
async function loadAsset(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('not a file');
  const hit = assets.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit;
  const raw = await fs.readFile(file);
  const ext = path.extname(file);
  const entry = {
    mtimeMs: stat.mtimeMs,
    ext,
    raw,
    gz: COMPRESSIBLE.has(ext) && raw.length > 1024 ? zlib.gzipSync(raw) : null,
    etag: `"${crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 22)}"`,
  };
  assets.set(file, entry);
  return entry;
}

function resolveFile(pathname) {
  let rel = decodeURIComponent(pathname); // throws URIError on malformed escapes; the caller answers 400
  if (rel === '/') rel = '/index.html';
  const shared = rel.startsWith('/engine/');
  const base = shared ? ENGINE_DIR : PUBLIC_DIR;
  const file = path.normalize(path.join(base, shared ? rel.slice('/engine/'.length) : rel));
  if (!file.startsWith(base + path.sep)) return null;
  if (path.relative(base, file).split(path.sep).some((part) => part.startsWith('.'))) return null;
  if (shared && path.basename(file) !== 'cards.js') return null; // only the card helpers are public
  return file;
}

export function createDeclareServer({
  port = 3000, host = '0.0.0.0', fast = false, allowedOrigins = [], limits = {},
} = {}) {
  const timing = fast ? FAST_TIMING : REAL_TIMING;
  const L = { ...DEFAULT_LIMITS, ...(fast ? FAST_LIMITS : {}), ...limits };
  const rooms = new Map();
  const creates = new Hits(L.createsPerHour, 60 * 60 * 1000);
  const wrongCodes = new Hits(L.wrongCodes, 10 * 60 * 1000);
  const conns = new Map();
  const loggedOrigins = new Set();

  const newCode = () => {
    for (;;) {
      const code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
      if (!rooms.has(code)) return code;
    }
  };

  async function handleHttp(req, res) {
    const headers = { ...SECURITY_HEADERS };
    if (String(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https') {
      headers['strict-transport-security'] = 'max-age=15552000';
    }
    const reply = (status, type, body, extra = {}) => {
      res.writeHead(status, { ...headers, 'content-type': type, ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'text/plain', 'Method not allowed', { allow: 'GET, HEAD' });
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/healthz') return reply(200, 'text/plain', 'ok', { 'cache-control': 'no-store' });
    if (url.pathname === '/api/info') {
      // LAN addresses only make sense (and are only shared) when the page was opened locally.
      const local = isLocalHost(req.headers.host);
      return reply(200, 'application/json', JSON.stringify({
        lan: local ? lanAddresses() : [], port: server.address()?.port ?? port,
        rounds: ROUND_CHOICES, penalties: PENALTY_CHOICES,
      }), { 'cache-control': 'no-store' });
    }

    const file = resolveFile(url.pathname);
    if (!file) return reply(404, 'text/plain', 'Not found');
    let asset;
    try { asset = await loadAsset(file); } catch { return reply(404, 'text/plain', 'Not found'); }

    const type = MIME[asset.ext] ?? 'application/octet-stream';
    const cache = asset.ext === '.woff2' ? 'public, max-age=2592000' : 'no-cache'; // no-cache = always revalidate, cheaply via ETag
    if (req.headers['if-none-match'] === asset.etag) return reply(304, type, undefined, { etag: asset.etag, 'cache-control': cache });
    const gzip = asset.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const body = gzip ? asset.gz : asset.raw;
    return reply(200, type, body, {
      etag: asset.etag, 'cache-control': cache, vary: 'Accept-Encoding',
      'content-length': body.length, ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    });
  }

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      if (!(err instanceof URIError)) console.error('http error:', err);
      if (!res.headersSent) res.writeHead(err instanceof URIError ? 400 : 500, { 'content-type': 'text/plain' });
      res.end(err instanceof URIError ? 'Bad request' : 'Server error');
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const refuse = (socket, status, text) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (!originAllowed(req, allowedOrigins)) {
      const origin = String(req.headers.origin);
      if (!loggedOrigins.has(origin)) {
        loggedOrigins.add(origin);
        console.warn(`Refused a WebSocket from origin ${origin} (this server is ${req.headers.host}). If that is your own site, add it to ALLOWED_ORIGINS.`);
      }
      return refuse(socket, 403, 'Forbidden');
    }
    const ip = clientIp(req);
    if ((conns.get(ip) ?? 0) >= L.connsPerIp) return refuse(socket, 429, 'Too Many Requests');
    return wss.handleUpgrade(req, socket, head, (ws) => {
      ws.ip = ip;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    conns.set(ws.ip, (conns.get(ws.ip) ?? 0) + 1);
    ws.alive = true;
    ws.ctx = null; // { room, seat }
    ws.bucket = new Bucket(L.msgRate, L.msgBurst);
    ws.on('pong', () => { ws.alive = true; });

    ws.on('message', (raw) => {
      if (!ws.bucket.take()) { ws.close(1008, 'Too many messages'); return; }
      try {
        onMessage(ws, raw);
      } catch (err) {
        console.error('message error:', err);
        send(ws, { t: 'error', msg: 'Something went wrong on the server. Try that again.' });
      }
    });

    ws.on('close', () => {
      const left = (conns.get(ws.ip) ?? 1) - 1;
      if (left > 0) conns.set(ws.ip, left); else conns.delete(ws.ip);
      if (ws.ctx) ws.ctx.room.detach(ws);
    });
    ws.on('error', () => {});
  });

  function onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { t: 'error', msg: 'Malformed message.' }); }
    if (!msg || typeof msg.t !== 'string') return undefined;

    if (msg.t === 'ping') return send(ws, { t: 'pong' });

    if (msg.t === 'create' || msg.t === 'join') {
      if (ws.ctx) return send(ws, { t: 'error', msg: 'You are already at a table.' });
      let room;
      if (msg.t === 'create') {
        if (rooms.size >= L.maxRooms) return send(ws, { t: 'error', code: 'busy', msg: 'The server is full right now. Try again in a few minutes.' });
        if (!creates.take(ws.ip)) return send(ws, { t: 'error', code: 'busy', msg: 'Too many tables started from this network. Try again later.' });
        room = new Room(newCode(), { timing });
        rooms.set(room.code, room);
      } else {
        if (wrongCodes.full(ws.ip)) return send(ws, { t: 'error', code: 'throttled', msg: 'Too many wrong codes from this network. Wait a few minutes and try again.' });
        room = rooms.get(String(msg.room ?? '').toUpperCase().trim());
        if (!room) {
          wrongCodes.add(ws.ip);
          return send(ws, { t: 'error', code: 'noroom', msg: 'No table with that code. Check it with the host. A table also ends when the server restarts.' });
        }
      }
      const joined = room.join(ws, { name: msg.name, token: msg.token });
      if (joined.error) {
        if (msg.t === 'create') rooms.delete(room.code);
        return send(ws, { t: 'error', code: joined.error, msg: joined.msg });
      }
      ws.ctx = { room, seat: joined.seat };
      return send(ws, { t: 'joined', room: room.code, seat: joined.seat, token: joined.token });
    }

    if (!ws.ctx) return send(ws, { t: 'error', msg: 'Join a table first.' });
    const err = ws.ctx.room.handle(ws.ctx.seat, msg);
    if (err) send(ws, { t: 'error', msg: err });
    return undefined;
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
    for (const [code, room] of rooms) {
      if (!room.humansOnline() && Date.now() - room.lastSeen > IDLE_MS) {
        room.dispose();
        rooms.delete(code);
      }
    }
    creates.sweep();
    wrongCodes.sweep();
  }, fast ? 500 : 25_000);
  heartbeat.unref();

  return {
    server, rooms,
    listen: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      rooms.forEach((r) => r.dispose());
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => server.close(() => resolve()));
      server.closeAllConnections?.();
    }),
  };
}

// Run directly: `node server/index.js`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const app = createDeclareServer({
    port,
    host: process.env.HOST ?? '0.0.0.0',
    fast: process.env.DECLARE_FAST === '1',
    allowedOrigins: String(process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  });
  const actual = await app.listen();

  if (process.env.NODE_ENV === 'production') {
    console.log(`Declare is listening on port ${actual}`);
  } else {
    console.log('\n  Declare is running\n');
    console.log(`  This computer         http://localhost:${actual}`);
    lanAddresses().forEach((ip) => console.log(`  Same Wi-Fi            http://${ip}:${actual}`));
    console.log('\n  Open the link, create a table, share the 4-letter code. Ctrl+C to stop.');
    console.log('  To play with friends elsewhere, host it online: see "Put it online" in the README.\n');
  }

  // Hosting platforms send SIGTERM on every deploy. Tables live in memory, so closing is all there is to do.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    setTimeout(() => process.exit(0), 5000).unref();
    app.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
