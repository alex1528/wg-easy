// 连通性诊断：在 ops-ui 容器里能做的检查（对应 diagnose-public.sh 的第 1-9 步中不需要 docker exec 的部分）。
// 不挂 docker.sock：看不到其他容器内部，只从网络侧验证。需要宿主机 root 的检查（--lines/--trace/--capture）只给出命令。
// 注意：本文件正则不用反斜杠转义（见 logstats.mjs 说明）。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import { tailRecords } from './logstats.mjs';

const UA = 'ops-ui-diagnose';
const R = (status, title, detail, hint = '') => ({ status, title, detail, hint });

/** Caddy path 匹配器的简化版：exact、prefix*、*suffix、*sub* */
export function matchPublic(p, patterns) {
  for (const pat of String(patterns || '').split(' ').filter(Boolean)) {
    const s = pat.startsWith('*');
    const e = pat.endsWith('*') && pat.length > 1;
    const core = pat.slice(s ? 1 : 0, e ? -1 : undefined);
    if (s && e ? p.includes(core) : e ? p.startsWith(core) : s ? p.endsWith(core) : p === core) return pat;
  }
  return '';
}

/** wg-easy 的 404 不一定是镜像缺接口：LiveWireGuard 功能关闭，或 OIDC 服务地址 / Client ID 没配置时，
 *  /api/livewireguard/config 自己返回 404 {"error":"not_found","error_description":"Endpoint not available"}
 *  （见 src/server/api/livewireguard/config.get.ts 第 2 步），客户端会当作暂时不可用 */
export function featureOff(body) {
  return /Endpoint not available/.test(String(body || ''));
}

export function validPath(p) {
  return typeof p === 'string' && p.length <= 200 && /^[/][!-~]*$/.test(p);
}

function errText(e) {
  return e?.cause?.code || e?.cause?.message || e?.code || e?.message || e?.name || String(e);
}

async function httpStatus(url, timeoutMs) {
  const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text().catch(() => '');
  return { status: res.status, body: body.slice(0, 2000) };
}

/** 直连 Caddy 容器的 51821 端口，按 WG_WEB_HOST 发 SNI 和 Host，拿状态码、X-Wg-Gate 和证书。
 *  useTls=false（CADDY_TLS=off，纯 HTTP 测试）时走明文 HTTP，cert 为 null */
function caddyProbe({ host, port, webHost, path, timeoutMs, useTls = true }) {
  return new Promise((resolve, reject) => {
    const isIp = net.isIP(webHost) !== 0;
    const opts = {
      host, port, path, method: 'GET', agent: false, timeout: timeoutMs,
      headers: { Host: `${webHost}:${port}`, 'User-Agent': UA },
    };
    const onRes = (res) => {
      const out = { status: res.statusCode, gate: res.headers['x-wg-gate'] || '', cert: null };
      if (useTls) {
        const sock = res.socket;
        const cert = sock.getPeerCertificate?.() || {};
        let idErr = '';
        if (!isIp && cert.subject) idErr = tls.checkServerIdentity(webHost, cert)?.message || '';
        out.cert = {
          subject: cert.subject?.CN || '', issuer: cert.issuer?.O || cert.issuer?.CN || '',
          validTo: cert.valid_to || '', san: cert.subjectaltname || '',
          authorized: !!sock.authorized, authError: String(sock.authorizationError || ''), idErr,
        };
      }
      res.resume();
      resolve(out);
    };
    const req = useTls
      ? https.request({ ...opts, rejectUnauthorized: false, ...(isIp ? {} : { servername: webHost }) }, onRes)
      : http.request(opts, onRes);
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    req.end();
  });
}

async function resolveBoth(name, servers) {
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
  if (servers?.length) r.setServers(servers);
  const [a, aaaa] = await Promise.allSettled([r.resolve4(name), r.resolve6(name)]);
  return {
    a: a.status === 'fulfilled' ? a.value : [],
    aaaa: aaaa.status === 'fulfilled' ? aaaa.value : [],
    err: a.status === 'rejected' && aaaa.status === 'rejected' ? errText(a.reason) : '',
  };
}

export function createDiagnose(cfg) {
  const {
    webHost = '', wgUrl = 'http://wg-easy:51821', caddyHost = 'caddy', caddyPort = 51821,
    publicPaths = '/api/livewireguard/* /api/auth/oidc /api/auth/oidc/* /cnf/*', adminGate = 'on',
    oidcServer = '', dnsServers = ['119.29.29.29', '223.5.5.5'], crowdsec = null, logFile = '',
    timeoutMs = 8000, tls: tlsOn = true,
  } = cfg;

  // CADDY_TLS=off：没有证书可查，单独给一条提醒，免得忘了改回 HTTPS
  const plainHttp = () => R('warn', 'HTTPS 证书', 'CADDY_TLS=off：Caddy 以纯 HTTP 提供服务，不加载证书（CADDY_TLS_MODE 被忽略）',
    '只用于测试：口令和 Cookie 都是明文传输。测完把 .env 的 CADDY_TLS 改回 on，再重建 caddy、wg-easy、ops-ui');

  async function checkConfig(p) {
    const hit = matchPublic(p, publicPaths);
    const gate = adminGate === 'off' ? 'off（所有 IP 都能访问登录页和后台）' : `${adminGate}（非管理员 IP 只能访问公开路径）`;
    if (adminGate === 'off' || hit) return R('ok', '配置：管理员 IP 开关与公开路径', `WG_ADMIN_GATE=${gate}；WG_PUBLIC_PATHS=[${publicPaths}]${hit ? `，${p} 匹配 ${hit}` : ''}`);
    return R('warn', '配置：管理员 IP 开关与公开路径', `WG_ADMIN_GATE=${gate}；WG_PUBLIC_PATHS=[${publicPaths}] 不包含 ${p}`,
      '非管理员 IP 访问这个路径会被 Caddy 拦成 403（带 X-Wg-Gate）。客户端需要它时加进 .env 的 WG_PUBLIC_PATHS，然后重建 caddy 和 ops-ui');
  }

  async function checkWg(p) {
    const title = 'wg-easy 直连（不经过 Caddy）';
    try {
      const res = await httpStatus(wgUrl + p, timeoutMs);
      if (res.status === 404 && featureOff(res.body)) {
        return R('bad', title, `${wgUrl}${p} 返回 404 Endpoint not available：接口存在，但 LiveWireGuard 功能未启用，或 OIDC 服务地址 / Client ID 没配置`,
          '到 wg-easy 管理后台启用 LiveWireGuard，并配好 OIDC 的服务地址和 Client ID；配好后不带令牌访问这个接口应返回 400 Missing headers。在此之前客户端同步会一直拿到 404 并反复重试');
      }
      if (res.status === 404) return R('bad', title, `${wgUrl}${p} 返回 404`, '返回的不是接口自己的 Endpoint not available：当前 wg-easy 镜像没有这个接口，问题在镜像，不在 Caddy');
      if (res.status >= 500) return R('bad', title, `返回 ${res.status}`, '看 docker logs --tail 60 wg-easy');
      return R('ok', title, `返回 HTTP ${res.status}（不带客户端令牌时 400/401 都正常）`);
    } catch (e) {
      return R('bad', title, `连不上 ${wgUrl}：${errText(e)}`, 'wg-easy 没起来或不在同一个 Docker 网络：docker ps；docker logs --tail 60 wg-easy');
    }
  }

  async function checkCaddy(p) {
    const title = '经过 Caddy（模拟普通客户端，来源是 ops-ui 容器的内网 IP）';
    if (!webHost) return { route: R('skip', title, '未设置 WG_WEB_HOST'), cert: null };
    try {
      const r = await caddyProbe({ host: caddyHost, port: caddyPort, webHost, path: p, timeoutMs, useTls: tlsOn });
      let route;
      if (r.status === 403 && r.gate) route = R(matchPublic(p, publicPaths) ? 'bad' : 'warn', title, `403，X-Wg-Gate: ${r.gate}：被管理员 IP 规则拦下`, '路径没匹配上 WG_PUBLIC_PATHS；若 caddy 用的 .env 和 ops-ui 不一致，以 caddy 为准（docker compose up -d --force-recreate caddy）');
      else if (r.status === 403) route = R('bad', title, '403，没有 X-Wg-Gate 头', '多半是 CrowdSec 封禁了来源 IP，见“封禁列表”页');
      else if (r.status === 429) route = R('warn', title, '429：触发限流', '调大 RL_PUBLIC_PER_MIN 或稍后再试');
      else if (r.status === 404) route = R('warn', title, '404：请求已经过 Caddy 到了 wg-easy，是 wg-easy 返回的 404', '原因见上一项“wg-easy 直连”');
      else if (r.status === 502 || r.status === 504) route = R('bad', title, `${r.status}：Caddy 连不上 wg-easy`, '见上一项 wg-easy 直连');
      else route = R('ok', title, `HTTP ${r.status}：请求已到 wg-easy，Caddy 这一层没有问题`);
      return { route, cert: r.cert ? certResult(r.cert) : plainHttp() };
    } catch (e) {
      return { route: R('bad', title, `连不上 ${caddyHost}:${caddyPort}（${tlsOn ? 'HTTPS' : 'HTTP'}）：${errText(e)}`,
        'caddy 容器没起来，或 TLS 握手失败：docker logs --tail 60 wg-easy-caddy；caddy 和 ops-ui 的 CADDY_TLS 必须一致（改完两个都要重建）'), cert: null };
    }
  }

  function certResult(c) {
    const title = 'HTTPS 证书';
    const to = Date.parse(c.validTo);
    const days = Number.isNaN(to) ? NaN : Math.floor((to - Date.now()) / 86400000);
    const base = `签发者 ${c.issuer || '?'}，主体 ${c.subject || '?'}，到期 ${c.validTo || '?'}${Number.isNaN(days) ? '' : `（剩 ${days} 天）`}`;
    if (days < 0) return R('bad', title, base + '，已过期', 'file 模式不会自动续期：换证书后 docker restart wg-easy-caddy');
    if (c.idErr) return R('bad', title, `${base}；证书不包含 ${webHost}：${c.idErr}`, '检查 CADDY_TLS_CERT_FILE 是否用错了证书');
    if (!c.authorized) return R('warn', title, `${base}；不被公共 CA 信任（${c.authError}）`, 'internal 模式下正常：客户端需导入 Caddy 根证书；正式域名建议改用 http / tencentcloud / alidns 模式');
    if (days < 15) return R('warn', title, base, '快到期了：ACME 模式会自动续期，file 模式要手动换');
    return R('ok', title, base);
  }

  async function checkCrowdsec() {
    const title = 'CrowdSec 本地 API';
    if (!crowdsec?.configured) return R('skip', title, '未配置 bouncer key');
    try {
      const r = await crowdsec.ping();
      return R('ok', title, `${crowdsec.url} 可访问，${crowdsec.keySource} 有效（${r.ms} ms）`);
    } catch (e) {
      return R('bad', title, e.message, 'docker ps 看 wg-easy-crowdsec 是否在运行；docker logs --tail 60 wg-easy-crowdsec');
    }
  }

  async function checkLog(sinceMs) {
    const title = '访问日志';
    let st;
    try { st = await fs.promises.stat(logFile); } catch (e) {
      return R('bad', title, `读不到 ${logFile}：${errText(e)}`, 'compose 里给 ops-ui 只读挂载 ./caddy/logs:/var/log/caddy:ro');
    }
    const recs = await tailRecords(logFile, { n: 200, maxBytes: 1024 * 1024 });
    const last = recs.at(-1);
    const age = last ? Math.round(Date.now() / 1000 - last.ts) : -1;
    const mine = recs.some((r) => r.ua === UA && r.ts * 1000 >= sinceMs - 2000);
    const detail = `${logFile}，${(st.size / 1048576).toFixed(1)} MiB，最后一条 ${age < 0 ? '无' : `${age} 秒前`}`;
    if (mine) return R('ok', title, detail + '；刚才的自检请求已写入日志');
    return R('warn', title, detail + '；没找到刚才的自检请求', 'Caddy 可能还没刷盘，稍后重跑；或 Caddy 的日志没写到这个目录');
  }

  async function checkDns(name, title) {
    if (!name) return R('skip', title, '未设置');
    if (net.isIP(name)) return R('info', title, `${name} 是 IP，不需要解析`);
    const sys = await resolveBoth(name, null);
    const pub = await resolveBoth(name, dnsServers);
    const fmt = (x) => (x.err ? `解析失败(${x.err})` : `A=[${x.a.join(' ')}] AAAA=[${x.aaaa.join(' ')}]`);
    const detail = `容器 DNS：${fmt(sys)}；公共 DNS(${dnsServers.join(' ')})：${fmt(pub)}`;
    if (sys.err && pub.err) return R('bad', title, detail, '域名解析不到');
    const diff = sys.a.slice().sort().join() !== pub.a.slice().sort().join();
    if (sys.aaaa.length || pub.aaaa.length) return R('warn', title, detail, '有 AAAA 记录：4G 客户端可能优先走 IPv6，IPv6 不通时同步会超时；不需要就删掉 AAAA');
    if (diff) return R('info', title, detail, '不同 DNS 返回不同地址（智能解析 / 双线），确认每条线路都放行了 51821/tcp');
    return R('ok', title, detail);
  }

  async function checkOidc() {
    const title = 'OIDC 服务（客户端同步前要先登录）';
    if (!oidcServer) return R('skip', title, '未设置 OAUTH_OIDC_SERVER');
    const disc = oidcServer.replace(/[/]+$/, '') + '/.well-known/openid-configuration';
    try {
      const res = await httpStatus(disc, timeoutMs);
      if (res.status === 200) return R('ok', title, `${disc} 返回 200`, `客户端网络也要能访问它：在手机 4G 下打开 ${disc}`);
      return R('bad', title, `${disc} 返回 ${res.status}`, '检查 OAUTH_OIDC_SERVER 地址（Authentik 应用 slug）');
    } catch (e) {
      return R('bad', title, `从服务器访问 ${disc} 失败：${errText(e)}`, 'OIDC 服务只对内网开放时客户端拿不到令牌，同步会超时');
    }
  }

  function hostOnly() {
    return R('info', '只能在宿主机执行的检查', '容器里看不到宿主机网卡、策略路由和抓包，请在服务器 wg-easy 目录下执行：',
      [
        'sudo bash scripts/diagnose-public.sh --lines        # 双线：每条线路的入口与回程路由',
        'sudo bash scripts/diagnose-public.sh --trace 30     # 逐层计数 SYN / rp_filter / SYN-ACK',
        'sudo bash scripts/diagnose-public.sh --capture <IP> # 抓 TCP 新连接，区分没到服务器 / TLS 失败',
        'bash scripts/diagnose-public.sh                     # 含 docker exec 的完整检查（Caddyfile 是否新版等）',
      ].join(String.fromCharCode(10)));
  }

  /** 跑一轮全部检查 */
  async function run(p = '/api/livewireguard/config') {
    if (!validPath(p)) throw new Error('路径必须以 / 开头，不含空格，200 字符以内');
    const t0 = Date.now();
    const oidcHost = (() => { try { return oidcServer ? new URL(oidcServer).hostname : ''; } catch { return ''; } })();
    const [config, wg, caddy, cs, dnsWeb, dnsOidc, oidc] = await Promise.all([
      checkConfig(p), checkWg(p), checkCaddy(p), checkCrowdsec(),
      checkDns(webHost, `DNS：${webHost || 'WG_WEB_HOST'}`),
      checkDns(oidcHost, `DNS：${oidcHost || 'OIDC 服务'}`), checkOidc(),
    ]);
    await new Promise((r) => setTimeout(r, 1200)); // 给 Caddy 一点时间把自检请求写进日志
    const log = await checkLog(t0);
    const checks = [config, wg, caddy.route, caddy.cert, cs, log, dnsWeb, oidc, dnsOidc, hostOnly()].filter(Boolean);
    const summary = { ok: 0, warn: 0, bad: 0, info: 0, skip: 0 };
    for (const c of checks) summary[c.status]++;
    return { path: p, webHost, startedAt: Math.floor(t0 / 1000), ms: Date.now() - t0, summary, checks };
  }

  return { run };
}
