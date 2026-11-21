// Test the relay: node test.mjs [base]   (default http://127.0.0.1:8787, start it with: npx wrangler dev)
const base = process.argv[2] || 'http://127.0.0.1:8787';
const wsBase = base.replace(/^http/, 'ws');
const room = 'T' + Math.random().toString(36).slice(2, 7).toUpperCase();
let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function open(q) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsBase + '/ws?' + q);
    ws.msgs = [];
    ws.onmessage = (e) => ws.msgs.push(e.data);
    ws.onopen = () => res(ws);
    ws.onerror = (e) => rej(new Error('ws error ' + (e.message || '')));
  });
}

const home = await (await fetch(base + '/')).json();
ok(home.ok, 'home answers');

const tv = await open('room=' + room);
const pc = await open('room=' + room + '&listen=0');
await sleep(300);
ok(JSON.parse(tv.msgs[0]).hello === 1, 'TV gets hello on connect');
ok(pc.msgs.some((m) => JSON.parse(m).listeners === 1), 'computer is told 1 TV is listening');

pc.send(JSON.stringify({ vi: 'Xin chào <b>bạn</b>', en: 'Hello', who: 'Arthur', kind: 'sub', mid: 'abc123', speak: true, extra: 'drop me' }));
await sleep(300);
const m1 = JSON.parse(tv.msgs[tv.msgs.length - 1]);
ok(m1.vi === 'Xin chào bạn' && m1.who === 'Arthur' && m1.speak === true && m1.mid === 'abc123', 'TV gets the line, tags removed');
ok(m1.extra === undefined && Array.isArray(m1.items) && m1.items.length === 1 && m1.seq > 0, 'unknown fields dropped, items + seq present');
ok(!pc.msgs.some((m) => JSON.parse(m).vi), 'sender does not get its own line back');

const r = await (await fetch(base + '/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ room: room.toLowerCase(), vi: 'Dòng 2', kind: 'zone', zid: 'z1', x: 1.5, y: 0.2, w: 0.3, h: 0.1, hold: 5 }) })).json();
ok(r.ok && r.tv === 1, 'HTTP push works and reaches 1 TV');
await sleep(300);
const m2 = JSON.parse(tv.msgs[tv.msgs.length - 1]);
ok(m2.vi === 'Dòng 2' && m2.kind === 'zone' && m2.x === 1 && m2.zid === 'z1' && m2.seq > m1.seq, 'zone line via HTTP reaches TV over WebSocket, seq goes up');

const p0 = await (await fetch(base + '/pull?room=' + room)).json();
ok(p0.seq === m2.seq && p0.items === undefined, 'pull without since: latest message');
const p1 = await (await fetch(base + '/pull?room=' + room + '&since=' + m1.seq)).json();
ok(p1.items && p1.items.length === 1 && p1.items[0].vi === 'Dòng 2', 'pull since: only newer lines');
const pe = await (await fetch(base + '/pull?room=ZZZZEMPTY')).json();
ok(pe.seq === 0, 'empty room: seq 0');

tv.send('ping');
await sleep(300);
ok(tv.msgs[tv.msgs.length - 1] === 'pong', 'ping answered with pong');

const bad = await fetch(base + '/push', { method: 'POST', body: JSON.stringify({ room: 'ab', vi: 'x' }) });
ok(bad.status === 400, 'bad room refused');

// rate limit: 40 per 10 s
let last;
for (let i = 0; i < 45; i++) last = await fetch(base + '/push', { method: 'POST', body: JSON.stringify({ room, vi: 'spam ' + i }) });
ok(last.status === 429, 'too many pushes slowed down (429)');

tv.close();
await sleep(500);
ok(pc.msgs.some((m) => JSON.parse(m).listeners === 0), 'computer told when the TV leaves');
pc.close();

const pre = await fetch(base + '/push', { method: 'OPTIONS' });
ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', 'CORS preflight');

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
