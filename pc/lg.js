'use strict';
/* Installs the Hóng Sub app on an LG TV (webOS) the way LG's own tool (ares-install) does, so nobody has to use a
   command line: the TV's Developer Mode app hands out an SSH key (Key Server, port 9991) locked with the passphrase
   shown on the TV; with it we copy the .ipk over SSH (port 9922, user "prisoner") and ask the TV to install it. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const os = require('os');
let ssh2 = null;
const sshLib = () => (ssh2 = ssh2 || require('./vendor/ssh2.js'));   /* loaded only when a TV LG is used */

const APP_ID = 'store.honggame.hongsubtv';
const IPK_URL = 'https://github.com/nvhnhi96-ui/hong-sub-tv/releases/latest/download/hong-sub-lg.ipk';
const TEMP = '/media/developer/temp';
const LUNA = '/usr/bin/luna-send-pub';

function setup({ ipcMain, app, net, getWin, log }) {
  const cfgFile = path.join(app.getPath('userData'), 'lg-tv.json');
  const cfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { return {}; } };
  const saveCfg = (c) => { try { fs.writeFileSync(cfgFile, JSON.stringify(c)); } catch (e) { /* ignore */ } };
  const progress = (t) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('lg-progress', t); if (log) log('lg: ' + t); };

  /* LG TVs answer an SSDP search on the home network */
  function find() {
    return new Promise((resolve) => {
      const found = new Map();
      let sock;
      try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { resolve([]); return; }
      const done = () => { try { sock.close(); } catch (e) { /* ignore */ } resolve([...found.values()]); };
      sock.on('message', (msg, rinfo) => {
        const s = msg.toString();
        if (!/webos|lge|lg electronics|lg smart/i.test(s)) return;
        if (!found.has(rinfo.address)) found.set(rinfo.address, { ip: rinfo.address, name: 'TV LG ' + rinfo.address });
        const loc = /^location:\s*(\S+)/im.exec(s);
        if (loc && !found.get(rinfo.address).loc) {
          found.get(rinfo.address).loc = loc[1];
          http.get(loc[1], { timeout: 1500 }, (res) => {
            let x = ''; res.on('data', d => { x += d; }); res.on('end', () => { const m = /<friendlyName>([^<]+)</i.exec(x); if (m && found.get(rinfo.address)) found.get(rinfo.address).name = m[1].trim(); });
          }).on('error', () => {});
        }
      });
      sock.on('error', done);
      sock.bind(0, () => {
        const q = (st) => Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ' + st + '\r\n\r\n');
        ['urn:lge-com:service:webos-second-screen:1', 'urn:dial-multiscreen-org:service:dial:1', 'ssdp:all'].forEach((st, i) => setTimeout(() => { try { sock.send(q(st), 1900, '239.255.255.250'); } catch (e) { /* ignore */ } }, i * 300));
      });
      setTimeout(done, 3200);
    });
  }

  function getKey(ip) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: ip, port: 9991, path: '/webos_rsa', timeout: 6000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('key')); return; }
        let x = ''; res.on('data', d => { x += d; }); res.on('end', () => resolve(x));
      });
      req.on('timeout', () => req.destroy(new Error('key')));
      req.on('error', () => reject(new Error('key')));
    });
  }

  function connect(ip, key, pass) {
    return new Promise((resolve, reject) => {
      const c = new (sshLib().Client)();
      c.on('ready', () => resolve(c));
      c.on('error', (e) => reject(e));
      try {
        c.connect({
          host: ip, port: 9922, username: 'prisoner', privateKey: key, passphrase: pass, readyTimeout: 20000,
          algorithms: { kex: ['ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] }
        });
      } catch (e) { reject(e); }
    });
  }

  function run(c, cmd, input, onLine, ms) {
    return new Promise((resolve, reject) => {
      c.exec(cmd, (err, st) => {
        if (err) { reject(err); return; }
        let out = '', buf = '', ended = false;
        const fin = (fn) => { if (ended) return; ended = true; clearTimeout(t); try { st.close(); } catch (e) { /* ignore */ } fn(); };
        const t = setTimeout(() => fin(() => reject(new Error('timeout'))), ms || 30000);
        st.on('data', (d) => {
          out += d; buf += d; let i;
          while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line && onLine) { const r = onLine(line); if (r) { fin(() => (r instanceof Error ? reject(r) : resolve(out))); return; } } }
        });
        st.stderr.on('data', (d) => { out += d; });
        st.on('close', () => fin(() => resolve(out)));
        if (input) st.end(input); else if (onLine) { /* luna-send -i keeps reading stdin */ } else st.end();
      });
    });
  }

  /* ---------- straight over the home network: the TV app asks this computer for the next line (long poll) ----------
     Much steadier than going through honggame.store, which stays as the backup. */
  const LAN_PORT = 8767;
  let lanPort = 0;
  const boxes = new Map();            // code -> { seq, msg, waiters: [] }
  const seen = new Map();             // code -> time the TV last said it is open
  const box = (code) => { if (!boxes.has(code)) boxes.set(code, { seq: 0, msg: null, items: [], waiters: [] }); return boxes.get(code); };
  function reply(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  /* everything after what the TV already has: a subtitle and an area translation sent together both arrive */
  /* you: the TV's own address on the home network, so the TV app can show it */
  function answer(res, b, since) { const you = String((res.socket && res.socket.remoteAddress) || '').replace(/^::ffff:/, ''); reply(res, 200, Object.assign({}, b.msg || {}, { seq: b.seq, you, items: since >= 0 ? b.items.filter((m) => m.seq > since) : [] })); }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), code = String(u.searchParams.get('code') || '').toUpperCase();
    if (req.method === 'OPTIONS') { reply(res, 204, {}); return; }
    if (u.pathname === '/ping') { reply(res, 200, { app: 'hongsub-pc', ok: true }); return; }
    if (!/^[A-Z0-9]{4,8}$/.test(code)) { reply(res, 400, { ok: false }); return; }
    if (u.pathname === '/alive') { seen.set(code, Date.now()); reply(res, 200, { ok: true }); return; }
    if (u.pathname === '/tts') { ttsServe(res, u.searchParams.get('q')); return; }
    if (u.pathname === '/sub') {
      seen.set(code, Date.now());
      const b = box(code), since = parseInt(u.searchParams.get('since') || '-1', 10);
      if (since < 0 || b.seq !== since) { answer(res, b, since); return; }
      const w = { res, since, t: setTimeout(() => { b.waiters = b.waiters.filter(x => x !== w); answer(res, b, since); }, 15000) };
      b.waiters.push(w);
      req.on('close', () => { clearTimeout(w.t); b.waiters = b.waiters.filter(x => x !== w); });
      return;
    }
    reply(res, 404, { ok: false });
  });
  /* the Vietnamese voice for the TV, as plain bytes: the TV plays it through Web Audio,
     because an <audio> element on webOS takes the sound away from the game on HDMI */
  const ttsCache = new Map();
  function ttsGoogle(q) {
    return new Promise((resolve) => {
      const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q=' + encodeURIComponent(q);
      const rq = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (r) => {
        if (r.statusCode !== 200) { r.resume(); resolve(null); return; }
        const parts = []; r.on('data', (d) => parts.push(d)); r.on('end', () => resolve(Buffer.concat(parts))); r.on('error', () => resolve(null));
      });
      rq.on('timeout', () => { rq.destroy(); resolve(null); }); rq.on('error', () => resolve(null));
    });
  }
  async function ttsServe(res, q) {
    q = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!q) { reply(res, 400, { ok: false }); return; }
    let buf = ttsCache.get(q);
    if (!buf) { buf = await ttsGoogle(q); if (buf && buf.length > 200) { ttsCache.set(q, buf); if (ttsCache.size > 60) ttsCache.delete(ttsCache.keys().next().value); } }
    if (!buf || buf.length <= 200) { reply(res, 502, { ok: false }); return; }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=3600', 'Content-Length': buf.length });
    res.end(buf);
  }
  server.on('error', (e) => { if (log) log('lg lan: ' + e.message); if (e.code === 'EADDRINUSE' && lanPort === LAN_PORT) { lanPort = LAN_PORT + 1; server.listen(lanPort, '0.0.0.0'); } });
  lanPort = LAN_PORT; try { server.listen(lanPort, '0.0.0.0'); } catch (e) { /* ignore */ }
  function push(code, msg) {
    code = String(code || '').toUpperCase(); if (!/^[A-Z0-9]{4,8}$/.test(code)) return false;
    const b = box(code); b.seq++; b.msg = Object.assign({}, msg, { seq: b.seq });
    b.items.push(b.msg); if (b.items.length > 12) b.items.shift();
    const ws = b.waiters; b.waiters = [];
    ws.forEach((w) => { clearTimeout(w.t); try { answer(w.res, b, w.since); } catch (e) { /* ignore */ } });
    return true;
  }
  /* this computer's address on the same network as the TV */
  function myAddr(tvIp) {
    const all = [];
    Object.values(os.networkInterfaces()).forEach((l) => (l || []).forEach((a) => { if (a.family === 'IPv4' && !a.internal) all.push(a.address); }));
    const pre = String(tvIp || '').split('.').slice(0, 3).join('.') + '.';
    const ip = all.filter((a) => a.startsWith(pre))[0] || all.filter((a) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a))[0] || all[0] || '';
    return ip && lanPort ? ip + ':' + lanPort : '';
  }

  const launchCmd = (code) => { const pc = myAddr(cfg().ip); return LUNA + " -n 1 'luna://com.webos.applicationManager/launch' '" + JSON.stringify({ id: APP_ID, params: code ? Object.assign({ code }, pc ? { pc } : {}) : {} }) + "'"; };

  async function install(ip, pass, code) {
    ip = String(ip || '').trim(); pass = String(pass || '').trim().toUpperCase();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { ok: false, err: 'Nhập địa chỉ IP của TV LG (ví dụ 192.168.1.20).' };
    let c = null;
    try {
      progress('Đang lấy khóa từ TV...');
      let key;
      try { key = await getKey(ip); } catch (e) { return { ok: false, err: 'Không lấy được khóa từ TV. Trên TV mở app Developer Mode, kiểm tra Dev Mode Status đang bật và bật Key Server, rồi thử lại.' }; }
      progress('Đang kết nối với TV...');
      try { c = await connect(ip, key, pass); } catch (e) {
        const m = String(e && e.message || e);
        if (/passphrase|decrypt|bad decrypt|parse/i.test(m)) return { ok: false, err: 'Sai mã Passphrase. Gõ đúng 6 chữ đang hiện trong app Developer Mode trên TV.' };
        return { ok: false, err: 'Không kết nối được TV (' + m.slice(0, 80) + '). Kiểm tra TV và máy tính cùng mạng, Dev Mode Status đang bật.' };
      }
      progress('Đang tải app Hóng Sub cho TV LG...');
      const r = await net.fetch(IPK_URL);
      if (!r.ok) return { ok: false, err: 'Không tải được app (HTTP ' + r.status + '). Kiểm tra mạng của máy tính.' };
      const ipk = Buffer.from(await r.arrayBuffer());
      progress('Đang chép app lên TV...');
      await run(c, '/bin/mkdir -p ' + TEMP, null, null, 15000);
      await run(c, '/bin/cat > "' + TEMP + '/hong-sub-lg.ipk"', ipk, null, 60000);
      progress('TV đang cài app...');
      let state = '';
      await run(c, LUNA + " -i 'luna://com.webos.appInstallService/dev/install' '" + JSON.stringify({ id: APP_ID, ipkUrl: TEMP + '/hong-sub-lg.ipk', subscribe: true }) + "'", null, (line) => {
        let j = null; try { j = JSON.parse(line); } catch (e) { return null; }
        const s = j && j.details && j.details.state ? String(j.details.state) : '';
        if (s) state = s;
        if (/FAILED/i.test(s) || j.returnValue === false) return new Error((j.details && j.details.reason) || j.errorText || s || 'install');
        if (/installed|^SUCCESS/i.test(s)) return true;
        return null;
      }, 120000).catch((e) => { throw new Error('Cài trên TV lỗi: ' + e.message); });
      await run(c, '/bin/rm -f "' + TEMP + '/hong-sub-lg.ipk"', null, null, 10000).catch(() => {});
      progress('Đang mở Hóng Sub trên TV...');
      await run(c, launchCmd(code), null, null, 15000).catch(() => {});
      const old = cfg();
      saveCfg({ ip, key, pass, name: old.ip === ip ? old.name : '', at: Date.now(), auto: old.auto !== false, state });
      return { ok: true };
    } catch (e) {
      return { ok: false, err: String(e && e.message || e).slice(0, 200) };
    } finally { if (c) try { c.end(); } catch (e) { /* ignore */ } }
  }

  async function launch(code) {
    const k = cfg(); if (!k.ip || !k.key) return { ok: false, err: 'no-tv' };
    let c = null;
    try { c = await connect(k.ip, k.key, k.pass); await run(c, launchCmd(code), null, null, 15000); return { ok: true }; }
    catch (e) { return { ok: false, err: String(e && e.message || e).slice(0, 160) }; }
    finally { if (c) try { c.end(); } catch (e) { /* ignore */ } }
  }

  ipcMain.handle('lg-push', (e, code, msg) => push(code, msg));
  ipcMain.handle('lg-seen', (e, code) => seen.get(String(code || '').toUpperCase()) || 0);
  ipcMain.handle('lg-addr', () => myAddr(cfg().ip));
  ipcMain.handle('lg-find', () => find());
  ipcMain.handle('lg-state', () => { const k = cfg(); return { ip: k.ip || '', installed: !!k.key, auto: k.auto !== false, at: k.at || 0 }; });
  ipcMain.handle('lg-install', (e, ip, pass, code) => install(ip, pass, code));
  ipcMain.handle('lg-launch', (e, code) => launch(code));
  ipcMain.handle('lg-auto', (e, on) => { const k = cfg(); k.auto = !!on; saveCfg(k); return true; });
  return { find, install, launch, cfg, push, myAddr };
}
/* self test: the key the TV hands out is a passphrase-locked RSA key; make sure this build can open one */
function selfTest() {
  const crypto = require('crypto');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-128-cbc', passphrase: 'ABC123' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const ok = sshLib().utils.parseKey(privateKey, 'ABC123'), bad = sshLib().utils.parseKey(privateKey, 'WRONG1');
  return { encrypted: /ENCRYPTED/.test(privateKey), opens: !(ok instanceof Error) && !!ok && ok.type === 'ssh-rsa', wrongRejected: bad instanceof Error };
}
module.exports = { setup, APP_ID, selfTest };
