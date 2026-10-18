//
// service/wsprobe.mjs — see what each indexer WebSocket session actually does.
//
// The wallet SDK opens one graphql-ws socket per subscription and, by design,
// disposes and re-opens it from a cursor when its buffer fills. A sync that
// "reconnects every 30 s" is either that (each session resumes where the last
// stopped) or a loop that restarts from the beginning. This wraps the global
// WebSocket and logs, per session: the subscription it carried, the cursor it
// asked for, the first and last event id received, the tip (maxId) the indexer
// reported, how many events and bytes, and how it closed. It never logs a URL
// with a token: only the path. Enabled by WS_PROBE=1.
//
const SUB = /subscription\s+(\w+)\s*\(([^)]*)\)/;
export const installWsProbe = ({ log = console.log, onProgress = () => {}, redact = (s) => s } = {}) => {
  const Real = globalThis.WebSocket;
  if (!Real || Real.__probed) return { sessions: [] };
  const sessions = [];
  let seq = 0;
  class Probed extends Real {
    constructor(url, protocols) {
      super(url, protocols);
      const s = { n: ++seq, path: redact(String(url)).replace(/^wss?:\/\/[^/]+/, '').replace(/\?.*$/, ''), openedAt: null, subs: {}, msgs: 0, bytes: 0, closed: false };
      sessions.push(s);
      this.addEventListener('open', () => { s.openedAt = Date.now(); });
      this.addEventListener('message', (ev) => {
        const d = typeof ev.data === 'string' ? ev.data : '';
        s.msgs++; s.bytes += d.length;
        if (!d.startsWith('{"id"') && !d.startsWith('{"type":"next"')) return;
        const id = /^\{"id":"(\w+)"/.exec(d)?.[1];
        const sub = s.subs[id] ?? (s.subs[id] = { name: '?', from: null, first: null, last: null, tip: null, count: 0 });
        // event cursor: zswap/dust ledger events carry id and maxId; shielded progress carries end indexes
        const m = /"(?:zswapLedgerEvents|dustLedgerEvents)":\{"id":(\d+)/.exec(d);
        if (m) {
          const ev = Number(m[1]);
          if (sub.first === null) sub.first = ev;
          sub.last = ev; sub.count++;
          const t = /"maxId":(\d+)/.exec(d);
          if (t) sub.tip = Number(t[1]);
          onProgress(sub.name, sub.last, sub.tip);
        } else {
          const p = /"highestCheckedEndIndex":(\d+)/.exec(d);
          if (p) { sub.last = Number(p[1]); if (sub.first === null) sub.first = sub.last; onProgress(sub.name, sub.last, Number(/"highestEndIndex":(\d+)/.exec(d)?.[1] ?? 0) || null); }
          sub.count++;
        }
      });
      const send = this.send.bind(this);
      this.send = (data) => {
        try {
          const o = typeof data === 'string' && data.startsWith('{') ? JSON.parse(data) : null;
          if (o?.type === 'subscribe') {
            const q = SUB.exec(o.payload?.query ?? '');
            s.subs[o.id] = { name: q?.[1] ?? '?', from: o.payload?.variables ?? null, first: null, last: null, tip: null, count: 0 };
          }
        } catch { /* not JSON */ }
        return send(data);
      };
      this.addEventListener('close', (ev) => {
        s.closed = true;
        const dur = s.openedAt ? ((Date.now() - s.openedAt) / 1000).toFixed(1) : 'never opened';
        const subs = Object.values(s.subs).filter((x) => x.name !== '?' || x.count).map((x) => `${x.name} asked ${JSON.stringify(x.from)} got ${x.first}..${x.last} of tip ${x.tip} (${x.count})`).join('; ');
        log(`[ws ${s.n}] closed code=${ev.code} reason=${JSON.stringify(redact(ev.reason ?? ''))} after ${dur}s, ${s.msgs} msgs ${(s.bytes / 1e6).toFixed(1)} MB | ${subs || 'no subscription'}`);
      });
    }
  }
  Probed.__probed = true;
  globalThis.WebSocket = Probed;
  return { sessions };
};
