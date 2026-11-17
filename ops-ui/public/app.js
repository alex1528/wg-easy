// wg-easy 运维页面前端：无框架、无构建。所有接口都用相对路径（api/...），挂在 /ops/ 或根路径下都能用。
// CSP 禁止内联 style 属性：宽高写在 data-w / data-h 上，渲染后由 applySizes() 用 CSSOM 设置。
// 注意：本文件正则不用反斜杠转义。
const $ = (s) => document.querySelector(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const num = (n) => Number(n || 0).toLocaleString('zh-CN');
const PW_FIELD = 'pass' + 'word';

let session = null;
const loaded = { stats: false, bans: false };

// ---------------- 通用 ----------------
async function api(path, opts = {}) {
  const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) };
  const res = await fetch('api/' + path, { credentials: 'same-origin', ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (res.status === 401 && path !== 'login') showLogin();
  if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
  return data;
}

function applySizes(root) {
  root.querySelectorAll('[data-w]').forEach((e) => { e.style.width = e.dataset.w + '%'; });
  root.querySelectorAll('[data-h]').forEach((e) => { e.style.height = e.dataset.h + '%'; });
}

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return d + ' 天 ' + h + ' 小时';
  if (h) return h + ' 小时 ' + m + ' 分';
  if (m) return m + ' 分';
  return sec + ' 秒';
}
const fmtReqDur = (s) => (s < 1 ? Math.round(s * 1000) + ' ms' : s.toFixed(2) + ' s');

function statusClass(s) {
  if (s === 308) return 's-skip';
  if (s === 403 || s === 0 || s >= 500) return 's-bad';
  if (s === 429) return 's-warn';
  if (s >= 400) return 's-info';
  return 's-ok';
}

function copyBtn(text, label = '复制') {
  return '<button type="button" class="copy" data-copy="' + esc(text) + '">' + esc(label) + '</button>';
}
const unbanCmd = (ip) => 'docker exec wg-easy-crowdsec cscli decisions delete --ip ' + ip;

/** 横向条形榜单；clickKind 为 'ip' 时点击按该 IP 筛选 */
function bars(list, { clickKind = '', empty = '（无数据）' } = {}) {
  if (!list || !list.length) return '<p class="muted">' + empty + '</p>';
  const max = Math.max(...list.map((x) => x.count), 1);
  return '<div class="bars">' + list.map((x) => {
    const attr = clickKind ? ' data-' + clickKind + '="' + esc(x.key) + '"' : '';
    return '<div class="barrow' + (clickKind ? ' click' : '') + '"><div class="lab" title="' + esc(x.key) + '"' + attr + '>'
      + '<div class="fill" data-w="' + Math.round((x.count / max) * 100) + '"></div><span>' + esc(x.key === '' ? '(空)' : x.key) + '</span></div>'
      + '<div class="cnt">' + num(x.count) + '</div></div>';
  }).join('') + '</div>';
}
const card = (title, body) => '<div class="card"><h3>' + esc(title) + '</h3>' + body + '</div>';
const kpi = (label, value, cls = '') => '<div class="kpi ' + cls + '"><div class="v">' + value + '</div><div class="l">' + esc(label) + '</div></div>';

// ---------------- 登录 / 布局 ----------------
function showLogin() {
  stopLive();
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#loginHost').textContent = session && session.webHost ? session.webHost : '';
  if (session && !session.passwordSet) $('#loginErr').textContent = '服务器未设置 OPS_UI_PASSWORD，无法登录：在 .env 中设置后执行 docker compose up -d ops-ui';
  setTimeout(() => $('#pw').focus(), 0);
}
function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#hostLabel').textContent = session && session.webHost ? session.webHost : '';
  switchTab(location.hash.slice(1) || 'stats');
}

$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#loginErr').textContent = '';
  try {
    await api('login', { method: 'POST', body: JSON.stringify({ [PW_FIELD]: $('#pw').value }) });
    $('#pw').value = '';
    session = await api('session');
    showApp();
  } catch (e) {
    $('#loginErr').textContent = e.message;
  }
});
$('#logout').addEventListener('click', async () => {
  try { await api('logout', { method: 'POST', body: '{}' }); } catch { /* 忽略 */ }
  loaded.stats = loaded.bans = false;
  showLogin();
});

function switchTab(name) {
  if (!['stats', 'bans', 'live', 'diag'].includes(name)) name = 'stats';
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('hidden', t.id !== 'tab-' + name));
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  if (name === 'stats' && !loaded.stats) loadStats();
  if (name === 'bans' && !loaded.bans) loadBans();
}
$('#tabs').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-tab]'); if (b) switchTab(b.dataset.tab); });

// 全局点击：按 IP 筛选、跳转封禁 / 实时、复制
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-ip],[data-ban],[data-live],[data-copy]');
  if (!t) return;
  if (t.dataset.copy !== undefined) {
    try { await navigator.clipboard.writeText(t.dataset.copy); t.textContent = '已复制'; }
    catch { window.prompt('复制下面的内容', t.dataset.copy); }
    setTimeout(() => { t.textContent = '复制'; }, 1500);
  } else if (t.dataset.ip !== undefined) {
    $('#fIp').value = t.dataset.ip; switchTab('stats'); loadStats();
  } else if (t.dataset.ban !== undefined) {
    $('#bIp').value = t.dataset.ban; switchTab('bans'); loadBans();
  } else if (t.dataset.live !== undefined) {
    $('#lIp').value = t.dataset.live; switchTab('live'); stopLive(); startLive();
  }
});

// ---------------- 访问统计 ----------------
async function loadStats() {
  loaded.stats = true;
  const qs = new URLSearchParams();
  const add = (k, v) => { if (String(v).trim()) qs.set(k, String(v).trim()); };
  add('since', $('#fSince').value); add('ip', $('#fIp').value); add('status', $('#fStatus').value);
  add('q', $('#fQ').value); add('top', $('#fTop').value || 10);
  if ($('#fRotated').checked) qs.set('rotated', '1');
  $('#statsErr').textContent = '';
  $('#statsMeta').textContent = '统计中…';
  try {
    const r = await api('stats?' + qs.toString());
    renderStats(r);
    $('#statsMeta').textContent = '文件 ' + r.files.join(', ') + ' · ' + new Date(r.generatedAt * 1000).toLocaleTimeString('zh-CN');
  } catch (e) {
    $('#statsErr').textContent = e.message;
    $('#statsMeta').textContent = '';
  }
}

function renderStats(r) {
  const s = r.status, p = r.probes;
  const win = r.window.from ? esc(r.window.fromText) + ' ~ ' + esc(r.window.toText) + '（' + esc(r.window.timeZone) + '）' : '无数据';
  let h = '<p class="muted">时间窗口：' + win + ' · 日志 ' + num(r.lines.total) + ' 行，已解析 ' + num(r.lines.parsed)
    + (r.lines.unparsed ? '，<b>无法解析 ' + num(r.lines.unparsed) + '</b>' : '') + '</p>';
  h += '<div class="kpis">'
    + kpi('真实 HTTPS 请求（去掉 308）', num(r.estimatedRealRequests))
    + kpi('308 明文跳转', num(s.c308))
    + kpi('403 拦截', num(s.c403), s.c403 ? 'warn' : '')
    + kpi('403 · 管理员 IP 规则', num(s.c403Gate))
    + kpi('403 · CrowdSec / 不公开路径', num(s.c403Crowdsec))
    + kpi('429 限流', num(s.c429), s.c429 ? 'warn' : '')
    + kpi('5xx 后端问题', num(s.c5xx), s.c5xx ? 'bad' : '')
    + kpi('0 连接提前断开', num(s.c0), s.c0 ? 'warn' : '')
    + kpi('扫描探测（已去重）', num(p.hits), p.hits ? 'warn' : '')
    + kpi('可疑来源 IP', num(r.scanners.count))
    + '</div>';
  h += '<div class="note">一次扫描 = 308（明文跳 HTTPS）+ 403（拦下）两条日志：308 与 403 配对约 ' + num(r.paired308to403)
    + ' 组；扫描探测只按结果行计数（另有 308 前奏 ' + num(p.redirects) + ' 条未重复计入）。被拦下 ' + num(p.blocked)
    + ' 次：管理员 IP 规则 ' + num(p.blockedGate) + '，CrowdSec / 不公开路径 ' + num(p.blockedCrowdsec) + '。403 没有 X-Wg-Gate 头一般说明防护已生效。</div>';

  // 按小时
  const maxH = Math.max(...r.hourly.map((x) => x.requests), 1);
  const cols = r.hourly.map((x) => '<div class="col" title="' + esc(x.hour) + '：请求 ' + x.requests + '，扫描 ' + x.probes + '">'
    + '<div class="r" data-h="' + ((x.requests / maxH) * 100).toFixed(1) + '"></div>'
    + '<div class="p" data-h="' + ((x.probes / maxH) * 100).toFixed(1) + '"></div></div>').join('');
  const first = r.hourly[0], last = r.hourly[r.hourly.length - 1];
  h += '<div class="grid">';
  h += '<div class="card wide"><h3>按小时分布</h3>' + (r.hourly.length ? '<div class="hours">' + cols + '</div>'
    + '<div class="legend"><span><i class="lr"></i>请求</span><span><i class="lp"></i>扫描命中</span><span>' + esc(first.hour) + ' ~ ' + esc(last.hour) + '</span></div>'
    : '<p class="muted">（无数据）</p>') + '</div>';
  h += card('状态码分布', bars(s.codes.map((x) => ({ key: String(x.key), count: x.count }))));
  h += card('扫描特征', bars(p.signatures, { empty: '没有命中扫描特征' }));
  h += card('扫描来源 IP（点击筛选）', bars(p.ips, { clickKind: 'ip', empty: '没有' }));
  h += card('被扫得最多的路径', bars(p.paths, { empty: '没有' }));
  h += card('来源 IP（点击筛选）', bars(r.top.ips, { clickKind: 'ip' }));
  h += card('请求路径', bars(r.top.paths));
  h += card('Host', bars(r.top.hosts));
  h += card('方法', bars(r.top.methods));
  h += card('客户端（User-Agent）', bars(r.top.userAgents));
  h += '</div>';

  // 可疑来源
  h += '<div class="card" id="scannerCard"><h3>可疑来源（有扫描特征或撞到 403 / 429，共 ' + num(r.scanners.count) + ' 个）</h3>';
  if (!r.scanners.list.length) h += '<p class="muted">没有</p>';
  else {
    h += '<div class="tablewrap"><table><thead><tr><th>IP</th><th>总请求</th><th>扫描</th><th>403</th><th>429</th><th>特征</th><th>最后出现</th><th>操作</th></tr></thead><tbody>';
    h += r.scanners.list.map((x) => '<tr><td class="mono"><span class="link" data-ip="' + esc(x.ip) + '">' + esc(x.ip) + '</span></td>'
      + '<td>' + num(x.total) + '</td><td>' + num(x.probes) + '</td><td>' + num(x.blocked403) + '</td><td>' + num(x.limited429) + '</td>'
      + '<td>' + esc(x.sigs.join('、') || '-') + '</td><td>' + esc(x.lastText) + '</td>'
      + '<td><button type="button" class="copy" data-ban="' + esc(x.ip) + '">查封禁</button>'
      + '<button type="button" class="copy" data-live="' + esc(x.ip) + '">实时</button></td></tr>').join('');
    h += '</tbody></table></div>';
  }
  h += '</div>';
  const root = $('#statsBody');
  root.innerHTML = h;
  applySizes(root);
}

$('#statsForm').addEventListener('submit', (ev) => { ev.preventDefault(); loadStats(); });
$('#statsReset').addEventListener('click', () => {
  $('#fIp').value = ''; $('#fStatus').value = ''; $('#fQ').value = ''; $('#fTop').value = 10; $('#fSince').value = '24h';
  loadStats();
});

// ---------------- 封禁列表 ----------------
async function loadBans() {
  loaded.bans = true;
  const qs = new URLSearchParams();
  if ($('#bIp').value.trim()) qs.set('ip', $('#bIp').value.trim());
  if ($('#bCommunity').checked) qs.set('community', '1');
  $('#bansErr').textContent = '';
  $('#bansMeta').textContent = '查询中…';
  try {
    const r = await api('bans?' + qs.toString());
    renderBans(r);
    $('#bansMeta').textContent = new Date().toLocaleTimeString('zh-CN');
  } catch (e) {
    $('#bansErr').textContent = e.message;
    $('#bansMeta').textContent = '';
    $('#bansBody').innerHTML = '';
  }
}

function renderBans(r) {
  const ipq = $('#bIp').value.trim();
  let h = '<div class="kpis">' + kpi(ipq ? ipq + ' 的封禁' : '当前生效的封禁', num(r.total), r.total ? 'warn' : '')
    + Object.entries(r.byOrigin).map(([k, v]) => kpi('来源 ' + k, num(v))).join('') + '</div>';
  if (ipq && !r.total) h += '<div class="note">' + esc(ipq) + ' 当前没有被封禁（没勾选“含社区黑名单”时只查本机规则和 cscli 手动封禁）。</div>';
  h += '<div class="grid">' + card('按触发规则', bars(r.byScenario, { empty: '没有封禁' })) + '</div>';
  if (r.list.length) {
    h += '<div class="card"><h3>封禁明细' + (r.truncated ? '（只显示前 ' + r.list.length + ' 条）' : '') + '</h3><div class="tablewrap"><table><thead><tr>'
      + '<th>IP / 范围</th><th>类型</th><th>触发规则</th><th>来源</th><th>剩余</th><th>到期</th><th>操作</th></tr></thead><tbody>';
    h += r.list.map((d) => '<tr><td class="mono">' + (d.scope === 'Ip' ? '<span class="link" data-ip="' + esc(d.value) + '">' + esc(d.value) + '</span>' : esc(d.scope + ':' + d.value)) + '</td>'
      + '<td>' + esc(d.type) + (d.simulated ? '（模拟）' : '') + '</td><td>' + esc(d.scenario) + '</td><td>' + esc(d.origin) + '</td>'
      + '<td>' + esc(fmtDur(d.remainingSec)) + '</td><td>' + esc(d.untilText) + '</td>'
      + '<td>' + (d.scope === 'Ip' ? copyBtn(unbanCmd(d.value), '复制解封命令') : '') + '</td></tr>').join('');
    h += '</tbody></table></div><p class="muted small">页面只读：解封要在服务器上执行复制的 cscli 命令。管理员 IP 加白名单见 bash scripts/admin-ips.sh。</p></div>';
  }
  const root = $('#bansBody');
  root.innerHTML = h;
  applySizes(root);
}
$('#bansForm').addEventListener('submit', (ev) => { ev.preventDefault(); loadBans(); });

// ---------------- 实时请求 ----------------
let es = null;
let liveRows = [];
const LIVE_MAX = 500;

function liveVisible(r) {
  if ($('#lHide308').checked && r.status === 308) return false;
  if ($('#lOnlyBad').checked && !(r.status === 403 || r.status === 429 || r.status === 0 || r.status >= 500)) return false;
  return true;
}
function liveRow(r, fresh) {
  return '<tr' + (fresh ? ' class="fresh"' : '') + '><td class="mono">' + esc(r.time.slice(5)) + '</td>'
    + '<td class="mono"><span class="link" data-ip="' + esc(r.ip) + '">' + esc(r.ip) + '</span></td>'
    + '<td>' + esc(r.method) + '</td><td><span class="pill ' + statusClass(r.status) + '">' + r.status + '</span></td>'
    + '<td class="path mono" title="' + esc(r.uri) + '">' + esc(r.path) + (r.sig ? ' <span class="pill s-warn">' + esc(r.sig) + '</span>' : '') + '</td>'
    + '<td>' + esc(fmtReqDur(r.duration)) + '</td><td>' + esc(r.note) + '</td>'
    + '<td class="muted" title="' + esc(r.ua) + '">' + esc(r.ua.slice(0, 40)) + '</td></tr>';
}
function renderLive() {
  $('#liveBody').innerHTML = liveRows.filter(liveVisible).slice().reverse().map((r) => liveRow(r, false)).join('')
    || '<tr><td colspan="8" class="muted">暂无请求</td></tr>';
}
function setLiveState(text, cls) {
  const el = $('#liveState');
  el.textContent = text;
  el.className = 'pill ' + (cls || '');
}

async function startLive() {
  const ip = $('#lIp').value.trim();
  $('#liveToggle').textContent = '停止';
  setLiveState('连接中…', 's-info');
  try {
    const r = await api('recent?n=100' + (ip ? '&ip=' + encodeURIComponent(ip) : ''));
    liveRows = r.list;
    renderLive();
  } catch (e) {
    setLiveState(e.message, 's-bad');
  }
  es = new EventSource('api/live' + (ip ? '?ip=' + encodeURIComponent(ip) : ''));
  es.addEventListener('hello', () => setLiveState('实时' + (ip ? '：' + ip : ''), 's-ok'));
  es.addEventListener('ping', (ev) => {
    const d = JSON.parse(ev.data);
    setLiveState(d.error ? d.error : '实时' + (ip ? '：' + ip : ''), d.error ? 's-bad' : 's-ok');
  });
  es.addEventListener('req', (ev) => {
    const r = JSON.parse(ev.data);
    liveRows.push(r);
    if (liveRows.length > LIVE_MAX) liveRows.splice(0, liveRows.length - LIVE_MAX);
    if (!liveVisible(r)) return;
    const body = $('#liveBody');
    if (body.querySelector('td[colspan]')) body.innerHTML = '';
    body.insertAdjacentHTML('afterbegin', liveRow(r, true));
    while (body.rows.length > LIVE_MAX) body.deleteRow(body.rows.length - 1);
  });
  es.onerror = () => setLiveState('连接断开，自动重连中…', 's-warn');
}
function stopLive() {
  if (es) { es.close(); es = null; }
  $('#liveToggle').textContent = '开始';
  setLiveState('未连接', '');
}
$('#liveForm').addEventListener('submit', (ev) => { ev.preventDefault(); if (es) stopLive(); else startLive(); });
$('#liveClear').addEventListener('click', () => { liveRows = []; renderLive(); });
$('#lHide308').addEventListener('change', renderLive);
$('#lOnlyBad').addEventListener('change', renderLive);

// ---------------- 连通性诊断 ----------------
const DIAG_LABEL = { ok: '正常', warn: '注意', bad: '异常', info: '提示', skip: '跳过' };
$('#diagForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#diagRun');
  btn.disabled = true;
  $('#diagErr').textContent = '';
  $('#diagMeta').textContent = '诊断中（约 3~10 秒）…';
  try {
    const r = await api('diagnose', { method: 'POST', body: JSON.stringify({ path: $('#dPath').value.trim() }) });
    renderDiag(r);
    $('#diagMeta').textContent = '用时 ' + (r.ms / 1000).toFixed(1) + ' 秒';
  } catch (e) {
    $('#diagErr').textContent = e.message;
    $('#diagMeta').textContent = '';
  } finally {
    btn.disabled = false;
  }
});

function renderDiag(r) {
  const NL = String.fromCharCode(10);
  let h = '<div class="kpis">' + ['bad', 'warn', 'ok', 'info', 'skip'].map((k) => kpi(DIAG_LABEL[k], num(r.summary[k]), k === 'bad' && r.summary[k] ? 'bad' : k === 'warn' && r.summary[k] ? 'warn' : '')).join('') + '</div>';
  h += '<div class="checks">' + r.checks.map((c) => {
    let hint = '';
    if (c.hint && c.hint.includes(NL)) hint = '<pre class="mono">' + esc(c.hint) + '</pre>' + copyBtn(c.hint.split(NL).map((l) => l.split('#')[0].trim()).join(NL), '复制命令');
    else if (c.hint) hint = '<div class="h">' + esc(c.hint) + '</div>';
    return '<div class="check-item"><div><span class="pill s-' + esc(c.status) + '">' + esc(DIAG_LABEL[c.status] || c.status) + '</span></div>'
      + '<div><div class="t">' + esc(c.title) + '</div><div class="d">' + esc(c.detail) + '</div>' + hint + '</div></div>';
  }).join('') + '</div>';
  $('#diagBody').innerHTML = h;
}

// ---------------- 启动 ----------------
(async () => {
  try {
    session = await api('session');
    if (session.authed) showApp(); else showLogin();
  } catch (e) {
    showLogin();
    $('#loginErr').textContent = '连不上 ops-ui 服务：' + e.message;
  }
})();
