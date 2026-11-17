// 解析 / 统计 Caddy JSON 访问日志。口径与 scripts/log-stats.sh 一致：
//   一次扫描 = 308(明文跳 HTTPS) + 403(拦下) 两条日志；扫描特征分布只按“结果行”(非 308)计一次，不翻倍。
//   403 带 X-Wg-Gate: admin-only = 管理员 IP 规则；不带 = CrowdSec 封禁 / 不公开路径。
// 注意：本文件的正则一律用 [/] [.] [0-9] 写法、不用反斜杠转义，避免经工具/编辑器转写时反斜杠丢失。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const NL = String.fromCharCode(10);
const first = (v) => (Array.isArray(v) ? String(v[0] ?? '') : v == null ? '' : String(v));

/** 解析一行 Caddy 访问日志；不是 Caddy JSON 时返回 null（调用方单独计数，不静默丢弃） */
export function parseLine(line) {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return null;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const ts = Number(o.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const rq = o.request || {};
  const rh = o.resp_headers || {};
  const uri = String(rq.uri ?? '');
  const gateHdr = rh['X-Wg-Gate'];
  return {
    ts,
    ip: String(rq.client_ip || rq.remote_ip || ''),
    method: String(rq.method || ''),
    host: String(rq.host || ''),
    uri,
    path: uri.split('?')[0],
    status: Number(o.status) || 0,
    duration: Number(o.duration) || 0,
    size: Number(o.size) || 0,
    https: !!rq.tls,
    gate: Array.isArray(gateHdr) ? gateHdr.includes('admin-only') : gateHdr === 'admin-only',
    ua: first((rq.headers || {})['User-Agent']),
    location: first(rh.Location),
  };
}

const RE_WP = /^[/]wp-|[/]wp-content[/]|[/]wp-includes[/]|[/]wordpress[/]|[/]xmlrpc[.]php|[/]wp-login[.]php/;
const RE_ADMIN = /^[/](admin|administrator|phpmyadmin|pma|myadmin|cpanel|webmail)[/]/;
const RE_COMP = /[/](actuator|solr|jenkins|druid|hudson|boaform)[/]/;
const RE_SENS = /[.](env|git|svn|aws|htpasswd|htaccess)$|^[/][.]|[/][.](env|git)/;
const RE_PHP = /[.](php|phps|phtml)$/;
const RE_BACK = /[/](cgi-bin|shell|cmd|eval|bak|backup|old|sql|zip|tar|gz)/;

/** 扫描 / 探测特征：与 log-stats.sh 的 sig_of() 相同 */
export function sigOf(p) {
  const u = String(p || '').toLowerCase();
  if (RE_WP.test(u)) return 'WordPress';
  if (RE_ADMIN.test(u)) return '管理入口';
  if (RE_COMP.test(u)) return '组件探测';
  if (RE_SENS.test(u)) return '敏感文件';
  if (RE_PHP.test(u)) return 'PHP 文件';
  if (RE_BACK.test(u)) return '后门/备份';
  return '';
}

/** 给单条请求一句话解释（实时流 / 最近请求用） */
export function explain(r) {
  const s = r.status;
  if (s === 308) return '明文 HTTP 跳 HTTPS（后面同路径那条才是结果）';
  if (s === 403) return r.gate ? '管理员 IP 规则拦下（X-Wg-Gate）' : 'CrowdSec 封禁 / 不公开路径';
  if (s === 429) return '触发限流';
  if (s === 0) return '处理完之前连接已断开（客户端放弃）';
  if (s === 502 || s === 504) return 'Caddy 连不上 / 等不到 wg-easy';
  if (s >= 500) return '后端错误';
  if (s === 400 || s === 401) return '已到 wg-easy（未带令牌时正常）';
  if (s === 404) return '已到 wg-easy，路径不存在';
  if (s >= 200 && s < 400) return '正常';
  return '';
}

/** 解析时间范围：30m / 2h / 7d，或 Date 能解析的时间；返回秒级时间戳，空值返回 0 */
export function parseSince(v, nowSec = Date.now() / 1000) {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const m = /^([0-9]+)[ ]*([mhd])$/i.exec(s);
  if (m) return nowSec - Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`无法解析时间范围 ${s}（示例：30m / 2h / 7d / 2026-11-16）`);
  return t / 1000;
}

/** 按时区格式化：hourKey -> 'YYYY-MM-DD HH:00'，fmtTime -> 'YYYY-MM-DD HH:MM:SS' */
export function makeTimeFmt(timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = (ts) => Object.fromEntries(f.formatToParts(new Date(ts * 1000)).map((p) => [p.type, p.value]));
  return {
    hourKey: (ts) => { const p = parts(ts); return `${p.year}-${p.month}-${p.day} ${p.hour}:00`; },
    fmtTime: (ts) => { const p = parts(ts); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`; },
  };
}

const inc = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);
/** Map -> [{key,count}]，按次数降序、键升序；用数组而不是对象，避免数字键（状态码）被 JSON 重排 */
export function topList(map, top = 0) {
  const arr = [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  return (top > 0 ? arr.slice(0, top) : arr).map(([key, count]) => ({ key, count }));
}

/** 统计累加器。filter: { since, ip, status, q } */
export function createStats({ top = 10, timeZone = 'Asia/Shanghai', filter = {} } = {}) {
  const { hourKey } = makeTimeFmt(timeZone);
  const st = {
    total: 0, parsed: 0, unparsed: 0, minTs: 0, maxTs: 0,
    c308: 0, httpRedirects: 0, c403: 0, c403Gate: 0, c403Crowdsec: 0, c429: 0, c5xx: 0, c0: 0,
    probeRedirect: 0, probeBlocked: 0, probeBlockedGate: 0, probeBlockedCrowdsec: 0,
  };
  const M = {
    status: new Map(), ip: new Map(), path: new Map(), host: new Map(), method: new Map(), ua: new Map(),
    hour: new Map(), hourProbe: new Map(), probeIp: new Map(), probeSig: new Map(), probePath: new Map(),
    probeOther: new Map(), ipSigs: new Map(), ipStatus: new Map(), ipLast: new Map(),
  };
  const q = String(filter.q || '').toLowerCase();

  function addLine(line) {
    st.total++;
    const r = parseLine(line);
    if (!r) { st.unparsed++; return; }
    add(r);
  }
  function add(r) {
    if (filter.since && r.ts < filter.since) return;
    if (filter.ip && r.ip !== filter.ip) return;
    if (filter.status && r.status !== Number(filter.status)) return;
    if (q && !r.path.toLowerCase().includes(q)) return;
    st.parsed++;
    if (!st.minTs || r.ts < st.minTs) st.minTs = r.ts;
    if (r.ts > st.maxTs) st.maxTs = r.ts;
    const hk = hourKey(r.ts);
    const sig = sigOf(r.path);
    inc(M.hour, hk); inc(M.status, r.status); inc(M.ip, r.ip); inc(M.path, r.path);
    inc(M.host, r.host); inc(M.method, r.method); if (r.ua) inc(M.ua, r.ua);
    if (!M.ipStatus.has(r.ip)) M.ipStatus.set(r.ip, new Map());
    inc(M.ipStatus.get(r.ip), r.status);
    if ((M.ipLast.get(r.ip) || 0) < r.ts) M.ipLast.set(r.ip, r.ts);

    const s = r.status;
    if (s === 308) { st.c308++; if (!r.https) st.httpRedirects++; }
    if (s === 403) { st.c403++; if (r.gate) st.c403Gate++; else st.c403Crowdsec++; }
    if (s === 429) st.c429++;
    if (s >= 500 && s < 600) st.c5xx++;
    if (s === 0) st.c0++;

    if (sig) {
      if (s === 308) {
        st.probeRedirect++; // 只记跳转，不计入事件分布
      } else {
        inc(M.hourProbe, hk); inc(M.probeIp, r.ip); inc(M.probeSig, sig); inc(M.probePath, r.path);
        if (!M.ipSigs.has(r.ip)) M.ipSigs.set(r.ip, new Set());
        M.ipSigs.get(r.ip).add(sig);
        if (s === 403) { st.probeBlocked++; if (r.gate) st.probeBlockedGate++; else st.probeBlockedCrowdsec++; }
        else inc(M.probeOther, s);
      }
    }
  }

  function result() {
    const probeHits = [...M.probeSig.values()].reduce((a, b) => a + b, 0);
    const hours = [...M.hour.keys()].sort();
    // 可疑来源：有扫描特征，或撞到 403 / 429
    const noisy = [...M.ipStatus].filter(([ip, sm]) => M.probeIp.has(ip) || sm.has(403) || sm.has(429));
    const scanners = noisy
      .map(([ip, sm]) => ({
        ip,
        total: M.ip.get(ip) || 0,
        probes: M.probeIp.get(ip) || 0,
        blocked403: sm.get(403) || 0,
        limited429: sm.get(429) || 0,
        sigs: [...(M.ipSigs.get(ip) || [])],
        lastTs: M.ipLast.get(ip) || 0,
      }))
      .sort((a, b) => b.probes - a.probes || b.total - a.total || a.ip.localeCompare(b.ip));
    return {
      window: { from: st.minTs, to: st.maxTs, timeZone },
      lines: { total: st.total, parsed: st.parsed, unparsed: st.unparsed },
      status: {
        codes: topList(M.status),
        c308: st.c308, httpRedirects: st.httpRedirects, c403: st.c403, c403Gate: st.c403Gate,
        c403Crowdsec: st.c403Crowdsec, c429: st.c429, c5xx: st.c5xx, c0: st.c0,
      },
      paired308to403: Math.min(st.c308, st.c403),
      estimatedRealRequests: st.parsed - st.c308,
      probes: {
        hits: probeHits, redirects: st.probeRedirect, blocked: st.probeBlocked,
        blockedGate: st.probeBlockedGate, blockedCrowdsec: st.probeBlockedCrowdsec,
        other: topList(M.probeOther), signatures: topList(M.probeSig),
        paths: topList(M.probePath, top), ips: topList(M.probeIp, top),
      },
      top: {
        ips: topList(M.ip, top), paths: topList(M.path, top), hosts: topList(M.host, top),
        methods: topList(M.method), userAgents: topList(M.ua, top),
      },
      hourly: hours.map((h) => ({ hour: h, requests: M.hour.get(h) || 0, probes: M.hourProbe.get(h) || 0 })),
      scanners: { count: scanners.length, list: scanners.slice(0, Math.max(top, 1) * 5) },
    };
  }
  return { addLine, add, result };
}

/** 日志文件 + 轮转文件（Caddy 轮转名：access-<时间>.log 或 .log.gz），按修改时间从旧到新 */
export function listLogFiles(logFile, includeRotated) {
  const files = [];
  if (includeRotated) {
    const dir = path.dirname(logFile);
    const baseName = path.basename(logFile);
    const base = baseName.replace(/[.]log$/, '');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* 目录不存在 */ }
    for (const n of names) {
      if (n === baseName) continue;
      if (!n.startsWith(base + '-') || !/[.]log([.]gz)?$/.test(n)) continue;
      const full = path.join(dir, n);
      try { files.push({ file: full, mtime: fs.statSync(full).mtimeMs }); } catch { /* 刚被删 */ }
    }
    files.sort((a, b) => a.mtime - b.mtime);
  }
  if (fs.existsSync(logFile)) files.push({ file: logFile, mtime: fs.statSync(logFile).mtimeMs });
  return files.map((f) => f.file);
}

/** 逐行读取（自动解压 .gz）；onLine 返回 false 时提前停止 */
export async function readLines(file, onLine) {
  let stream = fs.createReadStream(file);
  if (file.endsWith('.gz')) stream = stream.pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) if (onLine(line) === false) break;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** 统计一组日志文件 */
export async function computeStats(files, opts) {
  const acc = createStats(opts);
  for (const f of files) await readLines(f, (l) => { if (l) acc.addLine(l); });
  return { files, ...acc.result() };
}

/** 读文件末尾最多 maxBytes 字节，返回最后 n 条已解析请求（新的在后） */
export async function tailRecords(file, { n = 200, maxBytes = 8 * 1024 * 1024, filter = () => true } = {}) {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return []; }
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split(NL);
    if (start > 0) lines.shift(); // 第一行可能被截断
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      const r = parseLine(lines[i].trim());
      if (r && filter(r)) out.push(r);
    }
    return out.reverse();
  } finally {
    await fh.close();
  }
}
