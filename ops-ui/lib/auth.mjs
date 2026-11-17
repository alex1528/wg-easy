// 登录认证：单一运维口令 + HMAC 签名的会话 Cookie + 按来源 IP 的失败锁定。
// 口令修改后旧会话自动失效（签名密钥里混入了口令摘要）。
import crypto from 'node:crypto';

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function createAuth({
  password,
  secret,
  ttlSec = 12 * 3600,
  cookieName = 'ops_sess',
  cookiePath = '/ops/',
  secureCookie = true,
  maxFails = 5,
  failWindowSec = 600,
  lockSec = 900,
} = {}) {
  const enabled = !!password;
  const pwDigest = enabled ? sha256(password) : null;
  // 没设 OPS_UI_SECRET 时每次启动随机生成：重启后需要重新登录，安全上没问题
  const base = secret ? String(secret) : crypto.randomBytes(32).toString('hex');
  const key = sha256('ops-ui:' + base + ':' + (pwDigest ? pwDigest.toString('hex') : ''));
  const fails = new Map(); // ip -> { n, first, lockUntil }
  const revoked = new Map(); // nonce -> exp

  const sign = (s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
  const now = () => Date.now() / 1000;

  function issue() {
    const exp = Math.floor(now() + ttlSec);
    const nonce = crypto.randomBytes(12).toString('base64url');
    const body = exp + '.' + nonce;
    return body + '.' + sign(body);
  }

  function verify(token) {
    if (!enabled || !token) return false;
    const parts = String(token).split('.');
    if (parts.length !== 3) return false;
    const [exp, nonce, sig] = parts;
    const want = Buffer.from(sign(exp + '.' + nonce));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
    if (!(Number(exp) > now())) return false;
    if (revoked.has(nonce)) return false;
    return true;
  }

  function cookie(value, maxAge) {
    const attrs = [
      cookieName + '=' + value,
      'Path=' + cookiePath,
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=' + maxAge,
    ];
    if (secureCookie) attrs.push('Secure');
    return attrs.join('; ');
  }

  function sessionFrom(req) {
    return parseCookies(req.headers.cookie)[cookieName] || '';
  }

  function isAuthed(req) {
    return verify(sessionFrom(req));
  }

  function lockState(ip) {
    const f = fails.get(ip);
    if (!f) return { locked: false, retryAfter: 0 };
    const t = now();
    if (f.lockUntil > t) return { locked: true, retryAfter: Math.ceil(f.lockUntil - t) };
    if (t - f.first > failWindowSec) fails.delete(ip);
    return { locked: false, retryAfter: 0 };
  }

  /** 校验口令；返回 { ok, locked, retryAfter, remaining } */
  function login(ip, given) {
    if (!enabled) return { ok: false, disabled: true };
    const ls = lockState(ip);
    if (ls.locked) return { ok: false, locked: true, retryAfter: ls.retryAfter };
    const ok = crypto.timingSafeEqual(sha256(given || ''), pwDigest);
    if (ok) {
      fails.delete(ip);
      return { ok: true, token: issue() };
    }
    const t = now();
    const f = fails.get(ip) || { n: 0, first: t, lockUntil: 0 };
    if (t - f.first > failWindowSec) { f.n = 0; f.first = t; }
    f.n++;
    if (f.n >= maxFails) { f.lockUntil = t + lockSec; f.n = 0; f.first = t; }
    fails.set(ip, f);
    return f.lockUntil > t
      ? { ok: false, locked: true, retryAfter: Math.ceil(f.lockUntil - t) }
      : { ok: false, remaining: maxFails - f.n };
  }

  function logout(req) {
    const parts = sessionFrom(req).split('.');
    if (parts.length === 3) revoked.set(parts[1], Number(parts[0]) || 0);
  }

  // 定期清理过期的失败记录 / 注销记录
  const gc = setInterval(() => {
    const t = now();
    for (const [ip, f] of fails) if (f.lockUntil < t && t - f.first > failWindowSec) fails.delete(ip);
    for (const [n, exp] of revoked) if (exp < t) revoked.delete(n);
  }, 60_000);
  gc.unref();

  return {
    enabled,
    login,
    logout,
    isAuthed,
    loginCookie: (token) => cookie(token, ttlSec),
    clearCookie: () => cookie('', 0),
  };
}
