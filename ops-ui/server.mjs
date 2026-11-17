// wg-easy 运维页面（ops-ui）：访问日志统计、CrowdSec 封禁列表、实时请求、连通性诊断。
// 零第三方依赖，只用 Node 内置模块。由 Caddy 反代在 https://<WG_WEB_HOST>:51821/ops/ 下，
// 所以同样受管理员 IP 开关、CrowdSec 封禁和 HTTPS 保护；本服务自己再加一层运维口令。
// 注意：本文件正则不用反斜杠转义（见 lib/logstats.mjs 说明）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats, listLogFiles, parseSince, makeTimeFmt, explain, sigOf } from './lib/logstats.mjs';
import { createAuth } from './lib/auth.mjs';
import { createCrowdsec } from './lib/crowdsec.mjs';
import { createTailer } from './lib/live.mjs';
import { createDiagnose, validPath } from './lib/diagnose.mjs';

const NL = String.fromCharCode(10);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const list = (v) => String(v || '').split(/[ ,]+/).filter(Boolean);

export function loadConfig(e = env) {
  const base = ('/' + String(e.OPS_UI_BASE || '/ops').replace(/^[/]+|[/]+$/g, '')).replace(/^[/]$/, '');
  return {
    port: Number(e.OPS_UI_PORT || 8080),
    host: e.OPS_UI_HOST || '0.0.0.0',
    base, // 如 /ops；空串表示挂在根路径
    password: e.OPS_UI_PASSWORD || '',
    secret: e.OPS_UI_SECRET || '',
    secureCookie: String(e.OPS_UI_INSECURE_COOKIE || '') !== 'true',
    sessionHours: Number(e.OPS_UI_SESSION_HOURS || 12),
    logFile: e.OPS_UI_LOG || '/var/log/caddy/access.log',
    timeZone: e.TZ || 'Asia/Shanghai',
    trustedProxies: list(e.OPS_UI_TRUSTED_PROXIES || '10.42.42.43 fdcc:ad94:bacf:61a3::2b 127.0.0.1 ::1'),
    crowdsecUrl: e.CROWDSEC_LAPI_URL || 'http://crowdsec:8080',
    bouncerKey: e.OPS_UI_BOUNCER_KEY || e.CROWDSEC_BOUNCER_KEY || '',
    webHost: e.WG_WEB_HOST || '',
    wgUrl: e.OPS_UI_WG_URL || 'http://wg-easy:51821',
    caddyHost: e.OPS_UI_CADDY_HOST || 'caddy',
    caddyPort: Number(e.OPS_UI_CADDY_PORT || 51821),
    adminGate: e.WG_ADMIN_GATE || 'on',
    publicPaths: e.WG_PUBLIC_PATHS || '/api/livewireguard/* /api/auth/oidc /api/auth/oidc/* /cnf/*',
    oidcServer: e.OAUTH_OIDC_SERVER || '',
    dnsServers: list(e.CADDY_DNS_RESOLVERS || '119.29.29.29 223.5.5.5'),
    maxSseClients: Number(e.OPS_UI_MAX_LIVE || 10),
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'Cache-Control': 'no-store',
};

export function createApp(cfg = loadConfig()) {
  const auth = createAuth({
    password: cfg.password, secret: cfg.secret, ttlSec: cfg.sessionHours * 3600,
    cookiePath: (cfg.base || '') + '/', secureCookie: cfg.secureCookie,
  });
  const crowdsec = createCrowdsec({ url: cfg.crowdsecUrl, key: cfg.bouncerKey });
  const tailer = createTailer({ file: cfg.logFile });
  const diag = createDiagnose({ ...cfg, crowdsec });
  const { fmtTime } = makeTimeFmt(cfg.timeZone);
  const statsCache = new Map(); // key -> { at, promise }
  let sseClients = 0;
  let diagRunning = null;

  const pub = (r) => ({ ...r, time: fmtTime(r.ts), sig: sigOf(r.path), note: explain(r) });

  function clientIp(req) {
    const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (cfg.trustedProxies.includes(peer)) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return peer;
  }

  function send(res, code, body, headers = {}) {
    const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
    const data = isObj ? JSON.stringify(body) : body;
    res.writeHead(code, { ...SEC_HEADERS, ...(isObj ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
    res.end(data);
  }
  const fail = (res, code, msg, extra = {}) => send(res, code, { error: msg, ...extra });

  async function readJson(req, limit = 16 * 1024) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error('请求体太大'), { code: 413 });
      chunks.push(c);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('不是合法 JSON'), { code: 400 }); }
  }

  // 防 CSRF：写操作必须是 JSON 且同源（Cookie 另有 SameSite=Strict）
  function sameOrigin(req) {
    const ct = String(req.headers['content-type'] || '');
    if (!ct.startsWith('application/json')) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
      return o.host === host;
    } catch { return false; }
  }

  function serveStatic(res, rel) {
    const safe = path.normalize(rel).replace(/^([.][.][/]?)+/, '');
    const file = path.join(HERE, 'public', safe);
    if (!file.startsWith(path.join(HERE, 'public'))) return fail(res, 404, 'not found');
    fs.readFile(file, (err, data) => {
      if (err) return fail(res, 404, 'not found');
      send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    });
  }

  async function stats(q) {
    let since;
    try { since = parseSince(q.get('since') || ''); } catch (e) { throw Object.assign(e, { code: 400 }); }
    const status = q.get('status') || '';
    if (status && !/^[0-9]{1,3}$/.test(status)) throw Object.assign(new Error('状态码必须是数字'), { code: 400 });
    const top = Math.min(Math.max(Number(q.get('top') || 10) || 10, 1), 100);
    const rotated = q.get('rotated') === '1';
    const filter = { since, ip: (q.get('ip') || '').trim().slice(0, 64), status, q: (q.get('q') || '').trim().slice(0, 200) };
    const key = JSON.stringify({ ...filter, since: q.get('since') || '', top, rotated });
    const hit = statsCache.get(key);
    if (hit && Date.now() - hit.at < 10_000) return hit.promise;
    const files = listLogFiles(cfg.logFile, rotated);
    if (!files.length) throw Object.assign(new Error(`找不到访问日志 ${cfg.logFile}：compose 里给 ops-ui 只读挂载 ./caddy/logs:/var/log/caddy:ro`), { code: 404 });
    const promise = computeStats(files, { top, timeZone: cfg.timeZone, filter }).then((r) => ({
      ...r,
      files: files.map((f) => path.basename(f)),
      generatedAt: Math.floor(Date.now() / 1000),
      window: { ...r.window, fromText: r.window.from ? fmtTime(r.window.from) : '', toText: r.window.to ? fmtTime(r.window.to) : '' },
      scanners: { ...r.scanners, list: r.scanners.list.map((s) => ({ ...s, lastText: s.lastTs ? fmtTime(s.lastTs) : '' })) },
    }));
    statsCache.set(key, { at: Date.now(), promise });
    promise.catch(() => statsCache.delete(key));
    if (statsCache.size > 50) statsCache.delete(statsCache.keys().next().value);
    return promise;
  }

  function live(req, res, ip) {
    if (sseClients >= cfg.maxSseClients) return fail(res, 429, '实时连接太多，关掉其他标签页再试');
    sseClients++;
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (event, data) => res.write('event: ' + event + NL + 'data: ' + JSON.stringify(data) + NL + NL);
    write('hello', { ip, file: cfg.logFile });
    const unsub = tailer.subscribe((r) => { if (!ip || r.ip === ip) write('req', pub(r)); });
    const ping = setInterval(() => {
      const s = tailer.status();
      write('ping', { t: Math.floor(Date.now() / 1000), error: s.lastError });
    }, 15_000);
    req.on('close', () => { clearInterval(ping); unsub(); sseClients--; });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    let p = url.pathname;
    if (p === '/healthz' || p === cfg.base + '/healthz') return send(res, 200, { ok: true });
    if (cfg.base) {
      if (p === cfg.base) return send(res, 308, '', { Location: cfg.base + '/' });
      if (!p.startsWith(cfg.base + '/')) return fail(res, 404, 'not found');
      p = p.slice(cfg.base.length);
    }
    const ip = clientIp(req);

    if (!p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
      return serveStatic(res, p === '/' ? 'index.html' : p.slice(1));
    }

    const route = req.method + ' ' + p;
    if (req.method === 'POST' && !sameOrigin(req)) return fail(res, 403, '跨站请求被拒绝');

    if (route === 'GET /api/session') {
      return send(res, 200, { authed: auth.isAuthed(req), passwordSet: auth.enabled, webHost: cfg.webHost, timeZone: cfg.timeZone, ip });
    }
    if (route === 'POST /api/login') {
      if (!auth.enabled) return fail(res, 503, '未设置 OPS_UI_PASSWORD，运维页面不可登录：在 .env 中设置后重建 ops-ui');
      const body = await readJson(req);
      const r = auth.login(ip, String(body.password || ''));
      if (r.ok) {
        console.log(`[ops-ui] 登录成功 ${ip}`);
        return send(res, 200, { ok: true }, { 'Set-Cookie': auth.loginCookie(r.token) });
      }
      console.log(`[ops-ui] 登录失败 ${ip}${r.locked ? '（已锁定）' : ''}`);
      if (r.locked) return fail(res, 429, `失败次数过多，${Math.ceil(r.retryAfter / 60)} 分钟后再试`, { retryAfter: r.retryAfter });
      return fail(res, 401, `口令错误，还可尝试 ${r.remaining} 次`);
    }
    if (route === 'POST /api/logout') {
      auth.logout(req);
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
    }

    if (!auth.isAuthed(req)) return fail(res, 401, '未登录或会话已过期');

    if (route === 'GET /api/stats') return send(res, 200, await stats(url.searchParams));
    if (route === 'GET /api/bans') {
      const r = await crowdsec.decisions({
        ip: (url.searchParams.get('ip') || '').trim().slice(0, 64),
        includeCommunity: url.searchParams.get('community') === '1',
      });
      return send(res, 200, { ...r, list: r.list.map((d) => ({ ...d, untilText: fmtTime(d.until) })) });
    }
    if (route === 'GET /api/recent') {
      const n = Math.min(Math.max(Number(url.searchParams.get('n') || 100) || 100, 1), 500);
      const fip = (url.searchParams.get('ip') || '').trim();
      const recs = await tailer.recent(n, (r) => !fip || r.ip === fip);
      return send(res, 200, { file: cfg.logFile, list: recs.map(pub) });
    }
    if (route === 'GET /api/live') return live(req, res, (url.searchParams.get('ip') || '').trim().slice(0, 64));
    if (route === 'POST /api/diagnose') {
      const body = await readJson(req);
      const target = String(body.path || '/api/livewireguard/config').trim();
      if (!validPath(target)) return fail(res, 400, '路径必须以 / 开头，不含空格，200 字符以内');
      if (diagRunning) return fail(res, 429, '上一轮诊断还没结束');
      diagRunning = diag.run(target);
      try { return send(res, 200, await diagRunning); } finally { diagRunning = null; }
    }
    return fail(res, 404, 'not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const code = Number(e.code) >= 400 && Number(e.code) < 600 ? Number(e.code) : 500;
      if (code === 500) console.error('[ops-ui]', e);
      if (!res.headersSent) fail(res, code, e.message || '内部错误');
      else res.end();
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  return { server, cfg };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { server, cfg } = createApp();
  if (!cfg.password) console.warn('[ops-ui] ⚠ 未设置 OPS_UI_PASSWORD：页面能打开但无法登录');
  if (!cfg.bouncerKey) console.warn('[ops-ui] ⚠ 未设置 OPS_UI_BOUNCER_KEY / CROWDSEC_BOUNCER_KEY：封禁列表不可用');
  server.listen(cfg.port, cfg.host, () => console.log(`[ops-ui] 监听 ${cfg.host}:${cfg.port}${cfg.base}/，日志 ${cfg.logFile}`));
  const bye = () => server.close(() => process.exit(0));
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
