// HTTP 冒烟：登录 / 鉴权 / CSRF / 统计 / 封禁（模拟 CrowdSec LAPI）/ 最近请求 / 实时 SSE / 静态文件
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, loadConfig } from '../server.mjs';
import { createDiagnose } from '../lib/diagnose.mjs';
import { createCrowdsec, keyFingerprint } from '../lib/crowdsec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', '..', 'scripts', 'fixtures', 'caddy-access-sample.jsonl');
const NL = String.fromCharCode(10);
const PW = 'test-' + 'pass-123';
const KEY = 'bouncer-' + 'test';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app, base, mock, tmpDir, logFile, cookie = '', lapiHits = [];

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-ui-'));
  logFile = path.join(tmpDir, 'access.log');
  fs.copyFileSync(FIXTURE, logFile);
  mock = http.createServer((req, res) => {
    lapiHits.push({ url: req.url, key: req.headers['x-api-key'] });
    if (req.headers['x-api-key'] !== KEY) { res.writeHead(403); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.includes('ip=127.0.0.1')) return res.end('null');
    res.end(JSON.stringify([
      { id: 1, origin: 'crowdsec', scenario: 'wg-easy/probe-scan', scope: 'Ip', type: 'ban', value: '203.0.113.9', duration: '3h59m50s' },
      { id: 2, origin: 'CAPI', scenario: 'crowdsecurity/http-probing', scope: 'Ip', type: 'ban', value: '198.51.100.7', duration: '100h0m0s' },
    ]));
  });
  const mockPort = await listen(mock);
  const env = {
    ['OPS_UI_' + 'PASS' + 'WORD']: PW,
    OPS_UI_LOG: logFile, OPS_UI_INSECURE_COOKIE: 'true', OPS_UI_BOUNCER_KEY: KEY,
    CROWDSEC_LAPI_URL: 'http://127.0.0.1:' + mockPort, TZ: 'Asia/Shanghai', WG_WEB_HOST: 'vpn.example.com',
  };
  app = createApp(loadConfig(env));
  const port = await listen(app.server);
  base = 'http://127.0.0.1:' + port + '/ops/';
});

test.after(() => {
  app.server.closeAllConnections?.();
  app.server.close();
  mock.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const get = (p, h = {}) => fetch(base + p, { headers: { cookie, ...h } });
const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });

test('CADDY_TLS: default on keeps Secure cookie; off drops Secure and disables TLS probe', () => {
  const on = loadConfig({});
  assert.equal(on.tls, true);
  assert.equal(on.secureCookie, true);
  const off = loadConfig({ CADDY_TLS: 'off' });
  assert.equal(off.tls, false);
  assert.equal(off.secureCookie, false);
});

test('bouncer key: empty OPS_UI_BOUNCER_KEY falls back to CROWDSEC_BOUNCER_KEY', () => {
  const OWN_K = 'OPS_UI_BOUNCER_' + 'KEY';
  const SHARED_K = 'CROWDSEC_BOUNCER_' + 'KEY';
  const shared = 'shared-' + 'value';
  const c = loadConfig({ [OWN_K]: '  ', [SHARED_K]: ' ' + shared + ' ' });
  assert.equal(c.bouncerKey, shared);
  assert.match(c.bouncerKeySource, /^CROWDSEC_BOUNCER_KEY/);
  const own = loadConfig({ [OWN_K]: 'own-' + 'value', [SHARED_K]: shared });
  assert.equal(own.bouncerKey, 'own-' + 'value');
  assert.equal(own.bouncerKeySource, OWN_K);
  assert.equal(loadConfig({}).bouncerKey, '');
});

test('bouncer key rejected: error names the key source, fingerprint and fix', async () => {
  const bad = 'wrong-' + 'value';
  const cs = createCrowdsec({ url: 'http://127.0.0.1:' + mock.address().port, key: bad, keySource: 'CROWDSEC_BOUNCER_KEY（复用）' });
  await assert.rejects(cs.ping(), (e) => {
    assert.match(e.message, /CROWDSEC_BOUNCER_KEY（复用）/);
    assert.match(e.message, /HTTP 403/);
    assert.ok(e.message.includes(keyFingerprint(bad)));
    assert.ok(!e.message.includes(bad), 'key 本身不能出现在报错里');
    assert.match(e.message, /cscli bouncers delete caddy/);
    return true;
  });
});

test('diagnose: 404 Endpoint not available means feature/OIDC off, other 404 means missing route', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/api/livewireguard/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not_found', error_description: 'Endpoint not available' }));
    }
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>Page not found</h1>');
  });
  const port = await listen(srv);
  try {
    const mk = () => createDiagnose({
      webHost: '127.0.0.1', caddyHost: '127.0.0.1', caddyPort: port, wgUrl: 'http://127.0.0.1:' + port,
      adminGate: 'off', logFile: path.join(tmpDir, 'none.log'), timeoutMs: 3000, tls: false,
    });
    const wgOf = (r) => r.checks.find((c) => c.title.startsWith('wg-easy 直连'));
    const a = wgOf(await mk().run('/api/livewireguard/config'));
    assert.equal(a.status, 'bad');
    assert.match(a.detail, /Endpoint not available/);
    assert.match(a.hint, /LiveWireGuard/);
    assert.doesNotMatch(a.hint, /镜像/);
    const b = wgOf(await mk().run('/api/nope'));
    assert.equal(b.status, 'bad');
    assert.match(b.hint, /镜像/);
  } finally {
    srv.close();
  }
});

test('diagnose with CADDY_TLS=off probes Caddy over plain HTTP', async () => {
  const plain = http.createServer((req, res) => { res.writeHead(400); res.end('Missing headers'); });
  const port = await listen(plain);
  try {
    const d = createDiagnose({
      webHost: '127.0.0.1', caddyHost: '127.0.0.1', caddyPort: port, wgUrl: 'http://127.0.0.1:' + port,
      adminGate: 'off', logFile: path.join(tmpDir, 'none.log'), timeoutMs: 3000, tls: false,
    });
    const r = await d.run('/api/livewireguard/config');
    const route = r.checks.find((c) => c.title.startsWith('经过 Caddy'));
    const cert = r.checks.find((c) => c.title === 'HTTPS 证书');
    assert.equal(route.status, 'ok');
    assert.match(route.detail, /HTTP 400/);
    assert.equal(cert.status, 'warn');
    assert.match(cert.detail, /CADDY_TLS=off/);
  } finally {
    plain.close();
  }
});

test('static and session', async () => {
  const idx = await fetch(base);
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await idx.text(), /wg-easy 运维/);
  assert.equal((await fetch(base + 'app.js')).status, 200);
  assert.equal((await fetch(base + '..%2Fserver.mjs')).status, 404);
  const redirect = await fetch(base.slice(0, -1), { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  const s = await (await get('api/session')).json();
  assert.equal(s.authed, false);
  assert.equal(s.passwordSet, true);
});

test('requires auth', async () => {
  assert.equal((await get('api/stats')).status, 401);
  assert.equal((await get('api/bans')).status, 401);
});

test('csrf: non-json or cross-origin post rejected', async () => {
  const r1 = await fetch(base + 'api/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r1.status, 403);
  const r2 = await post('api/login', {}, { Origin: 'https://evil.example' });
  assert.equal(r2.status, 403);
});

test('login: wrong then right', async () => {
  const bad = await post('api/login', { ['pass' + 'word']: 'nope' });
  assert.equal(bad.status, 401);
  assert.match((await bad.json()).error, /还可尝试 4 次/);
  const ok = await post('api/login', { ['pass' + 'word']: PW });
  assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Path=[/]ops[/]/);
  cookie = sc.split(';')[0];
  assert.equal((await (await get('api/session')).json()).authed, true);
});

test('stats', async () => {
  const r = await (await get('api/stats?since=&top=5')).json();
  assert.equal(r.lines.parsed, 6);
  assert.equal(r.paired308to403, 3);
  assert.equal(r.probes.hits, 3);
  assert.equal(r.window.fromText, '2026-11-16 13:10:07');
  const bad = await get('api/stats?status=abc');
  assert.equal(bad.status, 400);
  const badSince = await get('api/stats?since=xyz');
  assert.equal(badSince.status, 400);
});

test('bans: local only by default, community optional', async () => {
  const r = await (await get('api/bans')).json();
  assert.equal(r.total, 1);
  assert.equal(r.list[0].value, '203.0.113.9');
  assert.equal(r.list[0].remainingSec, 14390);
  assert.match(r.list[0].untilText, /^[0-9]{4}-/);
  assert.match(lapiHits.at(-1).url, /origins=crowdsec/);
  const all = await (await get('api/bans?community=1')).json();
  assert.equal(all.total, 2);
});

test('recent', async () => {
  const r = await (await get('api/recent?n=2')).json();
  assert.equal(r.list.length, 2);
  assert.equal(r.list[1].path, '/myy.php');
  assert.equal(r.list[1].note, 'CrowdSec 封禁 / 不公开路径');
});

test('live SSE delivers newly appended lines', async () => {
  const ac = new AbortController();
  const res = await fetch(base + 'api/live', { headers: { cookie }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text[/]event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  const readUntil = async (needle, ms) => {
    const end = Date.now() + ms;
    while (!text.includes(needle) && Date.now() < end) {
      const r = await Promise.race([reader.read(), sleep(end - Date.now()).then(() => ({ timeout: true }))]);
      if (r.timeout || r.done) break;
      text += dec.decode(r.value, { stream: true });
    }
    return text.includes(needle);
  };
  assert.ok(await readUntil('event: hello', 3000), 'hello event');
  await sleep(1500); // 等第一次 tick 定位到文件末尾
  const line = JSON.stringify({ ts: Date.now() / 1000, status: 429, request: { client_ip: '192.0.2.5', method: 'POST', host: 'vpn.example.com', uri: '/api/auth/password' } });
  fs.appendFileSync(logFile, line + NL);
  assert.ok(await readUntil('192.0.2.5', 4000), 'appended request streamed');
  assert.match(text, /触发限流/);
  ac.abort();
});

test('diagnose validates path', async () => {
  const r = await post('api/diagnose', { path: 'no-slash' });
  assert.equal(r.status, 400);
});

test('logout invalidates session', async () => {
  const r = await post('api/logout', {});
  assert.equal(r.status, 200);
  assert.equal((await get('api/stats')).status, 401);
});
