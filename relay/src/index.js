/* Hóng Sub relay: carries subtitles from the computer / phone (Hóng Sub) to the TV apps by TV code.
   Replaces the relay on honggame.store (wp-json/hgs-sub/v1/push + pull), which every TV asked twice a second and
   which loaded the shop's website. Here each TV keeps ONE WebSocket open and gets every line the moment it is sent.

   One Durable Object per room (a TV code, or the TV's own back room: code + "T").
     GET  /ws?room=CODE[&listen=0]   WebSocket. Every text message the client sends is a push into CODE.
                                     listen=1 (default): gets every push made by others into CODE.
                                     listen=0: send only (the computer sending to the TV); it is told how many
                                     listeners (TVs) the room has: {"listeners":n}.
                                     "ping" is answered "pong" without waking the room (keep-alive).
     POST /push   {room, vi, en, who, size, pos, kind, mid, speak, zid, x, y, w, h, hold, name}   same as before
     GET  /pull?room=CODE[&since=SEQ]                                                        same as before
   Messages are cleaned the same way honggame.store did (same fields, same limits), so the apps need no changes in
   what they send. seq is a millisecond time, so it only ever goes up, even after the room was asleep. */
import { DurableObject } from 'cloudflare:workers';

const KINDS = { notice: 1, hello: 1, alive: 1, ctl: 1, zone: 1 };
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function roomOf(r) {
  r = String(r == null ? '' : r).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return r.length >= 4 && r.length <= 10 ? r : '';
}
function clean(s, max) {
  s = String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim();
  return Array.from(s).slice(0, max).join('');
}
function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; }
function int(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

/* the same message honggame.store kept: anything else is dropped */
export function cleanMsg(p) {
  const kind = KINDS[p.kind] ? p.kind : 'sub';
  const d = {
    vi: clean(p.vi, 600),
    en: clean(p.en, 1500),          /* the apps pack their extra settings here (HSX1:...): a little more room */
    who: clean(p.who, 40),
    size: Math.max(0, Math.min(90, int(p.size))),
    pos: p.pos === 'top' || p.pos === 'bottom' ? p.pos : '',
    kind,
    t: Math.floor(Date.now() / 1000),
  };
  if (p.speak !== undefined && p.speak !== null) d.speak = !!p.speak && p.speak !== '0' && p.speak !== 'false';
  const mid = String(p.mid == null ? '' : p.mid).replace(/[^a-z0-9]/gi, '');
  if (mid) d.mid = mid.slice(0, 24);
  if (kind === 'zone') {
    d.zid = String(p.zid == null ? '' : p.zid).replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
    for (const k of ['x', 'y', 'w', 'h']) { const v = num(p[k]); if (v !== null) d[k] = Math.max(0, Math.min(1, v)); }
    d.hold = Math.max(0, Math.min(600, int(p.hold)));
    d.name = clean(p.name, 40);
  }
  if (p.via === 'wp') d.via = 'wp';   /* sent through honggame.store by an older app */
  return d;
}

function json(o, status) {
  return new Response(JSON.stringify(o), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '' || path === '/') return json({ ok: true, app: 'hongsub-relay' });

    if (path === '/ws') {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ ok: false, error: 'websocket' }, 426);
      const room = roomOf(url.searchParams.get('room'));
      if (!room) return json({ ok: false, error: 'room' }, 400);
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(req);
    }

    if (path === '/push' && req.method === 'POST') {
      let p = {};
      try { p = JSON.parse(await req.text()); } catch (e) { p = {}; }
      if (!p || typeof p !== 'object') p = {};
      for (const [k, v] of url.searchParams) if (p[k] === undefined) p[k] = v;
      const room = roomOf(p.room);
      if (!room) return json({ ok: false, error: 'room' }, 400);
      const r = await env.ROOM.get(env.ROOM.idFromName(room)).push(room, cleanMsg(p));
      return json(r, r.ok ? 200 : 429);
    }

    if (path === '/pull') {
      const room = roomOf(url.searchParams.get('room'));
      if (!room) return json({ ok: false, error: 'room' }, 400);
      const since = url.searchParams.has('since') ? int(url.searchParams.get('since')) : null;
      return json(await env.ROOM.get(env.ROOM.idFromName(room)).pull(since));
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.seq = 0;
    this.items = [];       /* the last 12 messages, for /pull?since= (kept while the room is awake) */
    this.rl = { b: 0, n: 0 };
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  listeners(except) {
    return this.ctx.getWebSockets('L').filter((w) => w !== except && w.readyState === 1);
  }

  tellSenders(except) {
    const n = this.listeners(except).length;
    const m = JSON.stringify({ listeners: n });
    for (const w of this.ctx.getWebSockets('S')) if (w !== except && w.readyState === 1) { try { w.send(m); } catch (e) { /* gone */ } }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const room = roomOf(url.searchParams.get('room'));
    const listen = url.searchParams.get('listen') !== '0';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [listen ? 'L' : 'S']);
    server.serializeAttachment({ room, listen });
    if (listen) {
      server.send(JSON.stringify({ seq: this.seq, hello: 1 }));
      this.tellSenders(null);
    } else {
      server.send(JSON.stringify({ seq: this.seq, hello: 1, listeners: this.listeners(null).length }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  push(room, d, from) {
    const b = Math.floor(Date.now() / 10000);
    if (this.rl.b !== b) this.rl = { b, n: 0 };
    if (++this.rl.n > 40) return { ok: false, error: 'slow' };
    this.seq = Math.max(this.seq + 1, Date.now());
    d.seq = this.seq;
    this.items.push(d);
    if (this.items.length > 12) this.items = this.items.slice(-12);
    const out = JSON.stringify(Object.assign({}, d, { items: [d] }));
    let n = 0;
    for (const w of this.listeners(from)) { try { w.send(out); n++; } catch (e) { /* gone */ } }
    return { ok: true, seq: this.seq, tv: n };
  }

  pull(since) {
    if (!this.items.length) return { seq: this.seq };
    const last = this.items[this.items.length - 1];
    const out = Object.assign({}, last);
    if (since !== null) out.items = this.items.filter((it) => it.seq > since);
    return out;
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg === 'ping') return;
    let p;
    try { p = JSON.parse(msg); } catch (e) { return; }
    if (!p || typeof p !== 'object') return;
    const a = ws.deserializeAttachment() || {};
    if (!a.room) return;
    const r = this.push(a.room, cleanMsg(p), ws);
    if (!r.ok || p.ack) { try { ws.send(JSON.stringify({ ack: p.mid || '', ok: r.ok, seq: r.seq, tv: r.tv, error: r.error })); } catch (e) { /* gone */ } }
  }

  async webSocketClose(ws, code) {
    const a = ws.deserializeAttachment() || {};
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) { /* already closed */ }
    if (a.listen) this.tellSenders(ws);
  }

  async webSocketError(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.listen) this.tellSenders(ws);
  }
}
