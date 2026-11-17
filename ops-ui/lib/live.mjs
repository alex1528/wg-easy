// 实时跟踪访问日志（类似 tail -F）：有人订阅时每秒检查一次文件增长，
// 文件被轮转（inode 变化或变小）时从新文件开头读；所有订阅者共享一个读取器。
import fs from 'node:fs';
import { parseLine, tailRecords } from './logstats.mjs';

const NL = String.fromCharCode(10);

export function createTailer({ file, pollMs = 1000, ring = 300, maxChunk = 4 * 1024 * 1024 } = {}) {
  let pos = -1;
  let ino = null;
  let partial = '';
  let timer = null;
  let busy = false;
  let lastError = '';
  const buf = [];
  const subs = new Set();

  function push(r) {
    buf.push(r);
    if (buf.length > ring) buf.splice(0, buf.length - ring);
    for (const fn of subs) {
      try { fn(r); } catch { /* 单个订阅者出错不影响其他 */ }
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      let st;
      try {
        st = await fs.promises.stat(file);
        lastError = '';
      } catch (e) {
        lastError = `读不到 ${file}：${e.code || e.message}`;
        return;
      }
      if (pos < 0) {
        // 首次订阅：先把文件末尾最近的记录装进缓冲区，再从文件末尾开始跟
        const recent = await tailRecords(file, { n: ring, maxBytes: 2 * 1024 * 1024 });
        buf.length = 0;
        buf.push(...recent);
        pos = st.size;
        ino = st.ino;
        return;
      }
      if (st.ino !== ino || st.size < pos) {
        pos = 0;
        ino = st.ino;
        partial = '';
      }
      if (st.size === pos) return;
      const len = Math.min(st.size - pos, maxChunk);
      const fh = await fs.promises.open(file, 'r');
      try {
        const chunk = Buffer.alloc(len);
        await fh.read(chunk, 0, len, pos);
        pos += len;
        const lines = (partial + chunk.toString('utf8')).split(NL);
        partial = lines.pop() || '';
        for (const l of lines) {
          const r = parseLine(l.trim());
          if (r) push(r);
        }
      } finally {
        await fh.close();
      }
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, pollMs);
  }
  function stop() {
    clearInterval(timer);
    timer = null;
    pos = -1;
    partial = '';
  }

  /** 订阅新记录；返回取消订阅函数。最后一个订阅者离开时停止读取 */
  function subscribe(fn) {
    subs.add(fn);
    start();
    return () => {
      subs.delete(fn);
      if (subs.size === 0) stop();
    };
  }

  /** 最近 n 条（新的在后）；没人订阅时直接读文件末尾 */
  async function recent(n = 100, filter = () => true) {
    if (timer && pos >= 0) return buf.filter(filter).slice(-n);
    return tailRecords(file, { n, filter });
  }

  return {
    subscribe,
    recent,
    status: () => ({ subscribers: subs.size, running: !!timer, lastError }),
    _tick: tick,
  };
}
