import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { createDeclareServer } from '../server/index.js';
import {
  clientIp, isPrivateAddress, isLocalHost, originAllowed, Hits, Bucket,
} from '../server/guard.js';

// ---------------------------------------------------------------- helpers

async function boot(opts = {}) {
  const app = createDeclareServer({ port: 0, host: '127.0.0.1', fast: true, ...opts });
  const port = await app.listen();
  return { app, port };
}

function get(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Opens a socket and resolves with { ws } once open, or { status } if the handshake was refused. */
function open(port, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    const inbox = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.on('error', () => {});
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextOf = async (inbox, pred, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = inbox.find(pred);
    if (hit) return hit;
    await sleep(10);
  }
  throw new Error('timed out waiting for a message');
};

// ---------------------------------------------------------------- guard helpers

test('clientIp believes X-Forwarded-For only from a private proxy', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(req('10.1.2.3', '203.0.113.9, 10.1.2.3')), '203.0.113.9');
  assert.equal(clientIp(req('::ffff:172.16.0.5', '198.51.100.4')), '198.51.100.4');
  assert.equal(clientIp(req('10.1.2.3')), '10.1.2.3');
  assert.equal(clientIp(req('10.1.2.3', 'not-an-ip, 192.168.1.1')), '10.1.2.3');
  // A client on the open internet cannot claim to be someone else.
  assert.equal(clientIp(req('203.0.113.50', '198.51.100.4')), '203.0.113.50');
  assert.equal(clientIp(req('::ffff:203.0.113.50', '198.51.100.4')), '203.0.113.50');
});

test('private address and local host detection', () => {
  for (const a of ['10.0.0.1', '127.0.0.1', '192.168.1.20', '172.20.1.1', '100.64.0.9', '::1', 'fd12::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.1', '2001:db8::1']) assert.ok(!isPrivateAddress(a), a);
  assert.ok(isLocalHost('localhost:3000'));
  assert.ok(isLocalHost('192.168.1.7:3000'));
  assert.ok(isLocalHost('[::1]:3000'));
  assert.ok(!isLocalHost('declare.onrender.com'));
  assert.ok(!isLocalHost('203.0.113.5:3000'));
  assert.ok(!isLocalHost(undefined));
});

test('origin check: same host, listed hosts, and no Origin pass; others do not', () => {
  const req = (origin, host = 'declare.example.com') => ({ headers: { origin, host } });
  assert.ok(originAllowed(req(undefined)));
  assert.ok(originAllowed(req('https://declare.example.com')));
  assert.ok(!originAllowed(req('https://evil.example')));
  assert.ok(!originAllowed(req('not a url')));
  assert.ok(originAllowed(req('https://play.example'), ['https://play.example']));
  assert.ok(originAllowed(req('https://play.example'), ['play.example']));
  assert.ok(originAllowed(req('https://anything.example'), ['*']));
});

test('Hits and Bucket enforce their windows', () => {
  const h = new Hits(2, 1000);
  assert.ok(h.take('a', 0)); assert.ok(h.take('a', 10)); assert.ok(!h.take('a', 20));
  assert.ok(h.take('b', 20));
  assert.ok(h.full('a', 500));
  assert.ok(!h.full('a', 1011)); // the first use has aged out
  const b = new Bucket(10, 3);
  const t0 = b.at;
  assert.ok(b.take(t0)); assert.ok(b.take(t0)); assert.ok(b.take(t0)); assert.ok(!b.take(t0));
  assert.ok(b.take(t0 + 150)); // 1.5 tokens refilled
});

// ---------------------------------------------------------------- HTTP

test('health check, security headers, compression and revalidation', async () => {
  const { app, port } = await boot();
  try {
    const health = await get(port, '/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body.toString(), 'ok');

    const page = await get(port, '/', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['content-encoding'], 'gzip');
    assert.match(zlib.gunzipSync(page.body).toString(), /<title>Declare<\/title>/);
    assert.equal(page.headers['strict-transport-security'], undefined);

    const plain = await get(port, '/');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.match(plain.body.toString(), /<title>Declare<\/title>/);

    const again = await get(port, '/', { headers: { 'if-none-match': page.headers.etag } });
    assert.equal(again.status, 304);

    const https = await get(port, '/healthz', { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(https.headers['strict-transport-security'], /max-age=/);

    const head = await get(port, '/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal((await get(port, '/', { method: 'POST' })).status, 405);
  } finally { await app.close(); }
});

test('bad paths are refused without crashing the server', async () => {
  const { app, port } = await boot();
  try {
    assert.equal((await get(port, '/%E0%A4%A')).status, 400); // malformed escape
    assert.equal((await get(port, '/..%2f..%2fpackage.json')).status, 404);
    assert.equal((await get(port, '/%2e%2e/server/index.js')).status, 404);
    assert.equal((await get(port, '/engine/round.js')).status, 404);
    assert.equal((await get(port, '/engine/cards.js')).status, 200);
    assert.equal((await get(port, '/.git/config')).status, 404);
    assert.equal((await get(port, '/nope.js')).status, 404);
    assert.equal((await get(port, '/healthz')).status, 200); // still alive
  } finally { await app.close(); }
});

test('LAN addresses are only revealed when the page is opened locally', async () => {
  const { app, port } = await boot();
  try {
    const local = JSON.parse((await get(port, '/api/info', { headers: { host: `localhost:${port}` } })).body);
    assert.ok(Array.isArray(local.lan));
    const remote = JSON.parse((await get(port, '/api/info', { headers: { host: 'declare.example.com' } })).body);
    assert.deepEqual(remote.lan, []);
  } finally { await app.close(); }
});

// ---------------------------------------------------------------- WebSocket guards

test('a WebSocket from another website is refused, the site itself is not', async () => {
  const { app, port } = await boot();
  try {
    const evil = await open(port, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const own = await open(port, { origin: `http://127.0.0.1:${port}` });
    assert.ok(own.ws);
    own.ws.close();
  } finally { await app.close(); }
  const listed = await boot({ allowedOrigins: ['https://play.example'] });
  try {
    const ok = await open(listed.port, { origin: 'https://play.example' });
    assert.ok(ok.ws);
    ok.ws.close();
  } finally { await listed.app.close(); }
});

test('tables per network address are capped, using the forwarded address behind a proxy', async () => {
  const { app, port } = await boot({ limits: { createsPerHour: 2 } });
  const made = [];
  try {
    const create = async (ip) => {
      const c = await open(port, { 'x-forwarded-for': ip });
      c.ws.send(JSON.stringify({ t: 'create', name: 'Ana' }));
      const m = await nextOf(c.inbox, (x) => x.t === 'joined' || x.t === 'error');
      made.push(c.ws);
      return m;
    };
    assert.equal((await create('203.0.113.1')).t, 'joined');
    assert.equal((await create('203.0.113.1')).t, 'joined');
    const third = await create('203.0.113.1');
    assert.equal(third.t, 'error');
    assert.equal(third.code, 'busy');
    assert.equal((await create('203.0.113.2')).t, 'joined'); // a different network is unaffected
  } finally { made.forEach((w) => w.close()); await app.close(); }
});

test('the server refuses new tables when it is full', async () => {
  const { app, port } = await boot({ limits: { maxRooms: 1 } });
  const socks = [];
  try {
    const a = await open(port); socks.push(a.ws);
    a.ws.send(JSON.stringify({ t: 'create', name: 'Ana' }));
    await nextOf(a.inbox, (x) => x.t === 'joined');
    const b = await open(port, { 'x-forwarded-for': '203.0.113.9' }); socks.push(b.ws);
    b.ws.send(JSON.stringify({ t: 'create', name: 'Bo' }));
    const err = await nextOf(b.inbox, (x) => x.t === 'error');
    assert.equal(err.code, 'busy');
  } finally { socks.forEach((w) => w.close()); await app.close(); }
});

test('guessing table codes gets throttled', async () => {
  const { app, port } = await boot({ limits: { wrongCodes: 3 } });
  const c = await open(port);
  try {
    for (let i = 0; i < 3; i++) {
      c.ws.send(JSON.stringify({ t: 'join', room: 'ZZZZ', name: 'Eve' }));
      await sleep(30);
    }
    assert.equal(c.inbox.filter((m) => m.code === 'noroom').length, 3);
    c.ws.send(JSON.stringify({ t: 'join', room: 'ZZZZ', name: 'Eve' }));
    const m = await nextOf(c.inbox, (x) => x.code === 'throttled');
    assert.match(m.msg, /Wait a few minutes/);
  } finally { c.ws.close(); await app.close(); }
});

test('a message flood closes the socket', async () => {
  const { app, port } = await boot({ limits: { msgRate: 1, msgBurst: 5 } });
  const c = await open(port);
  const closed = new Promise((resolve) => c.ws.on('close', (code) => resolve(code)));
  try {
    for (let i = 0; i < 30; i++) c.ws.send('{"t":"ping"}');
    assert.equal(await closed, 1008);
  } finally { await app.close(); }
});

test('too many sockets from one address are refused', async () => {
  const { app, port } = await boot({ limits: { connsPerIp: 2 } });
  const socks = [];
  try {
    for (let i = 0; i < 2; i++) { const c = await open(port, { 'x-forwarded-for': '203.0.113.5' }); assert.ok(c.ws); socks.push(c.ws); }
    const third = await open(port, { 'x-forwarded-for': '203.0.113.5' });
    assert.equal(third.status, 429);
    const other = await open(port, { 'x-forwarded-for': '203.0.113.6' });
    assert.ok(other.ws);
    socks.push(other.ws);
    socks[0].close();
    await sleep(60);
    const retry = await open(port, { 'x-forwarded-for': '203.0.113.5' });
    assert.ok(retry.ws, 'a slot frees up when a socket closes');
    socks.push(retry.ws);
  } finally { socks.forEach((w) => w.close()); await app.close(); }
});
