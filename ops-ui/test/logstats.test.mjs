// 统计口径与 scripts/log-stats.sh --selftest 一致：6 行样本 = 3 组 308+403，扫描 3 次不翻倍
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats, parseLine, sigOf, parseSince, tailRecords, explain } from '../lib/logstats.mjs';
import { parseGoDuration } from '../lib/crowdsec.mjs';
import { matchPublic, validPath } from '../lib/diagnose.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', '..', 'scripts', 'fixtures', 'caddy-access-sample.jsonl');

test('fixture stats match log-stats.sh semantics', async () => {
  const r = await computeStats([FIXTURE], { top: 10, timeZone: 'Asia/Shanghai' });
  assert.deepEqual(r.lines, { total: 6, parsed: 6, unparsed: 0 });
  assert.equal(r.status.c308, 3);
  assert.equal(r.status.c403, 3);
  assert.equal(r.status.c403Gate, 0);
  assert.equal(r.status.c403Crowdsec, 3);
  assert.equal(r.paired308to403, 3);
  assert.equal(r.estimatedRealRequests, 3);
  assert.equal(r.probes.hits, 3);
  assert.equal(r.probes.redirects, 3);
  assert.deepEqual(r.probes.signatures, [{ key: 'WordPress', count: 2 }, { key: 'PHP 文件', count: 1 }]);
  assert.deepEqual(r.hourly, [{ hour: '2026-11-16 13:00', requests: 6, probes: 3 }]);
  assert.equal(r.scanners.count, 1);
  assert.equal(r.scanners.list[0].ip, '203.0.113.9');
});

test('filters', async () => {
  const s403 = await computeStats([FIXTURE], { filter: { status: '403' } });
  assert.equal(s403.lines.parsed, 3);
  const miss = await computeStats([FIXTURE], { filter: { ip: '1.2.3.4' } });
  assert.equal(miss.lines.parsed, 0);
  const q = await computeStats([FIXTURE], { filter: { q: '.php' } });
  assert.equal(q.lines.parsed, 4);
  const future = await computeStats([FIXTURE], { filter: { since: 4102444800 } });
  assert.equal(future.lines.parsed, 0);
});

test('parseLine tolerates junk and escapes', () => {
  assert.equal(parseLine('not json'), null);
  assert.equal(parseLine('{"ts":"x"}'), null);
  const bs = String.fromCharCode(92);
  const line = JSON.stringify({ ts: 1, status: 403, request: { client_ip: '1.1.1.1', uri: '/a' + bs + 'b"c.php?x=1' }, resp_headers: { 'X-Wg-Gate': ['admin-only'] } });
  const r = parseLine(line);
  assert.equal(r.path, '/a' + bs + 'b"c.php');
  assert.equal(r.gate, true);
  assert.match(explain(r), /管理员/);
});

test('signatures', () => {
  assert.equal(sigOf('/wp-admin/maint/'), 'WordPress');
  assert.equal(sigOf('/wp/wp-content/plugins/x/geido.php'), 'WordPress');
  assert.equal(sigOf('/myy.php'), 'PHP 文件');
  assert.equal(sigOf('/.env'), '敏感文件');
  assert.equal(sigOf('/phpmyadmin/index'), '管理入口');
  assert.equal(sigOf('/api/livewireguard/config'), '');
});

test('parseSince', () => {
  assert.equal(parseSince('', 1000), 0);
  assert.equal(parseSince('2h', 10000), 10000 - 7200);
  assert.equal(parseSince('30m', 10000), 10000 - 1800);
  assert.throws(() => parseSince('abc'));
});

test('tailRecords returns newest last', async () => {
  const t = await tailRecords(FIXTURE, { n: 2 });
  assert.equal(t.length, 2);
  assert.equal(t[1].path, '/myy.php');
  assert.equal(t[1].status, 403);
});

test('helpers', () => {
  assert.equal(Math.round(parseGoDuration('3h59m50.5s')), 14391);
  assert.equal(parseGoDuration('-1.5s'), -1.5);
  const pp = '/api/livewireguard/* /api/auth/oidc /api/auth/oidc/* /cnf/*';
  assert.equal(matchPublic('/api/livewireguard/config', pp), '/api/livewireguard/*');
  assert.equal(matchPublic('/api/auth/oidcx', pp), '');
  assert.equal(validPath('/ok'), true);
  assert.equal(validPath('/a b'), false);
});
