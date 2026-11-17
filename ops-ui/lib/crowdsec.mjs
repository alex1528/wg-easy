// 只读查询 CrowdSec 本地 API（bouncer 接口）：当前生效的封禁决策。
// 用的是无状态的 GET /v1/decisions，不碰 /v1/decisions/stream，
// 所以即使和 Caddy 共用同一个 bouncer key，也不会打乱 Caddy 的增量拉取。
// bouncer 接口只能读，不能解封；解封仍用 cscli（页面上给出可复制的命令）。

import crypto from 'node:crypto';

// 本地产生的决策来源；CAPI / lists 是社区黑名单，可能有上万条，默认不列出
export const LOCAL_ORIGINS = ['crowdsec', 'cscli', 'console', 'appsec'];

/** 解析 Go 的 time.Duration 字符串（如 3h59m50.5s、-1.2s、155h0m0s），返回秒 */
export function parseGoDuration(s) {
  const str = String(s || '').trim();
  if (!str) return 0;
  const neg = str.startsWith('-');
  const mult = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, 'µs': 1e-6, ns: 1e-9 };
  let total = 0;
  const re = /([0-9.]+)(ms|us|µs|ns|h|m|s)/g;
  let m;
  while ((m = re.exec(str))) total += Number(m[1]) * (mult[m[2]] || 0);
  return neg ? -total : total;
}

/** key 的指纹（sha256 前 8 位）：用来和服务器上 .env 里的值对比，不暴露 key 本身 */
export function keyFingerprint(k) {
  return k ? crypto.createHash('sha256').update(String(k)).digest('hex').slice(0, 8) : '';
}

export function createCrowdsec({ url, key, keySource = '', timeoutMs = 8000 } = {}) {
  const baseUrl = String(url || '').replace(/[/]+$/, '');
  const configured = !!(baseUrl && key);
  const source = keySource || 'bouncer key';

  async function call(pathAndQuery) {
    if (!configured) throw new Error('未配置 CrowdSec（CROWDSEC_LAPI_URL / OPS_UI_BOUNCER_KEY）');
    let res;
    try {
      res = await fetch(baseUrl + pathAndQuery, {
        headers: { 'X-Api-Key': key, 'User-Agent': 'wg-easy-ops-ui' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`连不上 CrowdSec 本地 API ${baseUrl}：${e.cause?.code || e.message}`);
    }
    if (res.status === 401 || res.status === 403) {
      const body = (await res.text().catch(() => '')).replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
      throw new Error(
        `CrowdSec 拒绝了当前使用的 ${source}（HTTP ${res.status}${body ? '：' + body : ''}；`
        + `key 长度 ${String(key).length}，sha256 前 8 位 ${keyFingerprint(key)}）。`
        + '最常见的原因：CrowdSec 只在 bouncer「caddy」第一次注册时读取 CROWDSEC_BOUNCER_KEY，之后改了 .env 里的值，已注册的 key 不会跟着变——'
        + '这时 Caddy 拉取封禁名单同样会被拒，封禁实际没有生效。'
        + '对比：在 wg-easy 目录执行 grep ^CROWDSEC_BOUNCER_KEY= .env | cut -d= -f2- | tr -d "[:space:]" | sha256sum | cut -c1-8；'
        + '修复：docker exec wg-easy-crowdsec cscli bouncers delete caddy && docker restart wg-easy-crowdsec（按 .env 重新注册），'
        + '然后 docker compose -f docker-compose-dirty.yml up -d --force-recreate caddy ops-ui；cscli bouncers list 可看 caddy 最近一次拉取时间');
    }
    if (!res.ok) throw new Error(`CrowdSec 返回 HTTP ${res.status}`);
    const txt = await res.text();
    if (!txt || txt === 'null') return [];
    return JSON.parse(txt);
  }

  /** 当前封禁；includeCommunity=false 时只看本机规则 / cscli 手动产生的 */
  async function decisions({ ip = '', includeCommunity = false, limit = 2000 } = {}) {
    const qs = new URLSearchParams();
    if (ip) qs.set('ip', ip);
    if (!includeCommunity) qs.set('origins', LOCAL_ORIGINS.join(','));
    const q = qs.toString();
    const raw = await call('/v1/decisions' + (q ? '?' + q : ''));
    const nowSec = Date.now() / 1000;
    let list = (Array.isArray(raw) ? raw : []).map((d) => {
      const remaining = parseGoDuration(d.duration);
      return {
        id: d.id,
        value: d.value,
        scope: d.scope,
        type: d.type,
        origin: d.origin,
        scenario: d.scenario || '',
        simulated: !!d.simulated,
        duration: d.duration,
        remainingSec: Math.max(0, Math.round(remaining)),
        until: Math.round(nowSec + Math.max(0, remaining)),
      };
    });
    // 旧版 LAPI 不认 origins 参数时会返回全部，这里再过滤一次
    if (!includeCommunity) list = list.filter((d) => LOCAL_ORIGINS.includes(String(d.origin).toLowerCase()));
    const byOrigin = {};
    const byScenario = {};
    for (const d of list) {
      byOrigin[d.origin] = (byOrigin[d.origin] || 0) + 1;
      const sc = d.scenario || '(无)';
      byScenario[sc] = (byScenario[sc] || 0) + 1;
    }
    list.sort((a, b) => b.remainingSec - a.remainingSec || String(a.value).localeCompare(String(b.value)));
    return {
      total: list.length,
      truncated: list.length > limit,
      byOrigin,
      byScenario: Object.entries(byScenario).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count })),
      list: list.slice(0, limit),
    };
  }

  /** 连通性检查：查一个不会被封的地址，能 200 就说明地址和密钥都对 */
  async function ping() {
    const t0 = Date.now();
    await call('/v1/decisions?ip=127.0.0.1');
    return { ok: true, ms: Date.now() - t0 };
  }

  return { configured, decisions, ping, url: baseUrl, keySource: source };
}
