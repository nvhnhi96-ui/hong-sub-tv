'use strict';
/* Online voices that need no key and no download:
   - Microsoft neural voices (the "Read aloud" voices of Microsoft Edge): Hoài My (female) and Nam Minh (male)
   - the Google voice of Google Translate (female)
   Both return MP3. Used by main.js for voice ids "ms:<name>" and "gg:vi". */
const https = require('https');
const crypto = require('crypto');

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_VER = '140.0.3485.14';
const HOST = 'speech.platform.bing.com';
const PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const WIN_EPOCH = 11644473600;
let skew = 0;   // seconds the server clock is ahead of ours (learned from a 403)

const MS_VOICES = [
  { id: 'ms:vi-VN-HoaiMyNeural', name: 'Microsoft Hoài My (nữ, AI online)', gender: 'female' },
  { id: 'ms:vi-VN-NamMinhNeural', name: 'Microsoft Nam Minh (nam, AI online)', gender: 'male' }
];
const GG_VOICES = [{ id: 'gg:vi', name: 'Google (nữ, online)', gender: 'female' }];

function gec(nowSec) {
  let t = Math.floor((nowSec === undefined ? Date.now() / 1000 : nowSec) + skew) + WIN_EPOCH;
  t -= t % 300;
  return crypto.createHash('sha256').update(String(t) + '0000000' + TRUSTED, 'ascii').digest('hex').toUpperCase();
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function stamp() { return new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)'); }
function uuid() { return crypto.randomBytes(16).toString('hex'); }

/* one masked client frame */
function frame(op, payload) {
  const len = payload.length, mask = crypto.randomBytes(4);
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = 0x80 | len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op;
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/* Reads unmasked server frames out of a growing buffer. Returns [frames, rest]. */
function parse(buf) {
  const out = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    let len = b1 & 0x7f, p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (b1 & 0x80) p += 4;   // servers do not mask, but be safe
    if (buf.length - p < len) break;
    out.push({ fin: !!(b0 & 0x80), op: b0 & 0x0f, data: buf.subarray(p, p + len) });
    off = p + len;
  }
  return [out, buf.subarray(off)];
}

/* text -> MP3 (Buffer) with a Microsoft neural voice. opts: {host,port,path,tls} only for tests. */
function msSpeak(text, voice, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const q = '?TrustedClientToken=' + TRUSTED + '&ConnectionId=' + uuid() + '&Sec-MS-GEC=' + gec() + '&Sec-MS-GEC-Version=1-' + EDGE_VER;
    const mod = opts.tls === false ? require('http') : https;
    const req = mod.request({
      host: opts.host || HOST, port: opts.port || 443, path: (opts.path || PATH) + q, method: 'GET', timeout: 15000,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        Pragma: 'no-cache', 'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + EDGE_VER.split('.')[0] + '.0.0.0 Safari/537.36 Edg/' + EDGE_VER.split('.')[0] + '.0.0.0',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    let done = false, timer = null;
    const fail = (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); };
    req.on('timeout', () => { req.destroy(); fail(new Error('timeout')); });
    req.on('error', fail);
    req.on('response', (res) => {   // no upgrade: the server said no
      if (res.statusCode === 403 && res.headers.date) {   // usually our clock is off: learn the server time and let the caller retry
        const srv = Date.parse(res.headers.date) / 1000; if (srv) skew = srv - Date.now() / 1000;
      }
      res.resume(); fail(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode }));
    });
    req.on('upgrade', (res, sock, head) => {
      const parts = []; let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0), msg = [], msgOp = 0;
      timer = setTimeout(() => { sock.destroy(); fail(new Error('timeout')); }, 25000);
      const send = (s) => sock.write(frame(1, Buffer.from(s, 'utf8')));
      const finish = () => {
        if (done) return; done = true; clearTimeout(timer);
        try { sock.write(frame(8, Buffer.alloc(0))); sock.end(); } catch (e) { /* ignore */ }
        const mp3 = Buffer.concat(parts);
        if (mp3.length < 200) reject(new Error('empty audio')); else resolve(mp3);
      };
      const onMessage = (op, data) => {
        if (op === 1) {
          const t = data.toString('utf8');
          if (/Path:turn\.end/i.test(t)) finish();
        } else if (op === 2 && data.length > 2) {
          const hl = data.readUInt16BE(0), h = data.subarray(2, 2 + hl).toString('utf8');
          if (/Path:audio/i.test(h)) parts.push(data.subarray(2 + hl));
        } else if (op === 8) { if (parts.length) finish(); else fail(new Error('closed')); }
        else if (op === 9) sock.write(frame(10, data));
      };
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const [frames, rest] = parse(buf); buf = Buffer.from(rest);
        for (const f of frames) {
          if (f.op === 0) msg.push(f.data); else { msg = [f.data]; msgOp = f.op; }
          if (f.fin) { const all = Buffer.concat(msg); msg = []; onMessage(f.op === 0 ? msgOp : f.op, all); }
        }
      });
      sock.on('error', fail);
      sock.on('close', () => { if (parts.length) finish(); else fail(new Error('closed')); });
      send('X-Timestamp:' + stamp() + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
      send('X-RequestId:' + uuid() + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + stamp() + 'Z\r\nPath:ssml\r\n\r\n' +
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'><voice name='" + esc(voice) + "'>" +
        "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" + esc(text) + '</prosody></voice></speak>');
    });
    req.end();
  });
}

async function ms(text, voice, opts) {
  try { return await msSpeak(text, voice, opts); }
  catch (e) { if (e.status === 403) return msSpeak(text, voice, opts); throw e; }   // second try with the learned clock
}

/* Google Translate voice: at most ~200 characters per request, so long lines go in pieces (MP3 pieces join end to end) */
function chunks(t, max) {
  const out = []; let s = String(t).replace(/\s+/g, ' ').trim();
  while (s.length > max) {
    let cut = Math.max(s.lastIndexOf('. ', max), s.lastIndexOf(', ', max), s.lastIndexOf('! ', max), s.lastIndexOf('? ', max));
    if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(s.slice(0, cut + 1).trim()); s = s.slice(cut + 1).trim();
  }
  if (s) out.push(s);
  return out;
}
async function gg(text, fetcher) {
  const bufs = [];
  for (const c of chunks(text, 190)) {
    const u = 'https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&q=' + encodeURIComponent(c);
    const r = await fetcher(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://translate.google.com/' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    bufs.push(Buffer.from(await r.arrayBuffer()));
  }
  const mp3 = Buffer.concat(bufs);
  if (mp3.length < 200) throw new Error('empty audio');
  return mp3;
}

module.exports = { MS_VOICES, GG_VOICES, ms, gg, gec, frame, parse, chunks, _skew: () => skew };
