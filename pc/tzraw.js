'use strict';
/* TV Samsung without Tizen Studio: the computer does the same automatic install as the phone apps (TZI in web.html).
   The page makes the key, asks Samsung for the certificates, signs the app and speaks to the TV itself; this side only
   gives it what a web page may not have:
   - a plain TCP connection to the TV's developer service (sdb, port 26101, home network only)
   - a small server on localhost:4794 that catches Samsung's sign-in (Samsung sends it there, as for Tizen Studio)
   - the Samsung sign-in window
   - HTTPS form posts to Samsung's certificate service and the download of the TV app
   The page talks to it with the same lines and events as the phone's core (hsnet.c), so TZI runs unchanged. */
const net = require('net');
const http = require('http');

const HOSTS = /^(svdca\.samsungqbe\.com|github\.com|[\w.-]+\.githubusercontent\.com|honggame\.store)$/i;
/* the TV is on the home network: private addresses only, and only its developer port */
function lanIp(ip) {
  if (!net.isIPv4(ip)) return false;
  const p = ip.split('.').map(Number);
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);
}

function setup({ ipcMain, BrowserWindow, getWin, lanAddr }) {
  const socks = {};
  let servers = [], loginWin = null, loginDone = null;
  const emit = (o) => { const w = getWin && getWin(); if (w && !w.isDestroyed()) w.webContents.send('tzr-ev', o); };

  /* ---- TCP to the TV ---- */
  function tcpOpen(id, ip, port) {
    if (!/^[\w-]{1,24}$/.test(id || '')) return;
    if (!lanIp(ip) || port !== 26101) { emit({ ev: 'tcp', id, ok: false, err: 'arg' }); return; }
    if (socks[id]) { try { socks[id].destroy(); } catch (e) { /* ignore */ } }
    const s = net.connect({ host: ip, port });
    let opened = false, failed = false;
    socks[id] = s;
    s.setTimeout(12000, () => { if (!opened) { failed = true; emit({ ev: 'tcp', id, ok: false, err: 'timeout' }); s.destroy(); } });
    s.on('connect', () => { opened = true; s.setTimeout(0); s.setNoDelay(true); s.setKeepAlive(true, 10000); emit({ ev: 'tcp', id, ok: true }); });
    s.on('data', (b) => emit({ ev: 'tcpdata', id, b64: b.toString('base64') }));
    s.on('error', (e) => { if (!opened && !failed) { failed = true; emit({ ev: 'tcp', id, ok: false, err: e && e.code === 'ECONNREFUSED' ? 'refused' : 'noconnect' }); } });
    s.on('close', () => { if (socks[id] === s) delete socks[id]; if (opened) emit({ ev: 'tcpclose', id }); });
  }
  function tcpSend(id, b64) { const s = socks[id]; if (s && !s.destroyed) s.write(Buffer.from(b64 || '', 'base64')); }
  function tcpClose(id) { const s = socks[id]; if (s) { delete socks[id]; try { s.end(); setTimeout(() => s.destroy(), 1500); } catch (e) { /* ignore */ } } }

  /* ---- Samsung's sign-in comes back to localhost:4794 ---- */
  const PAGE = '<!doctype html><meta charset=utf-8><body style="font:18px sans-serif;background:#111;color:#eee;padding:24px">Đã đăng nhập Samsung. Quay lại Hóng Sub...</body>';
  function catchOff() { servers.forEach((s) => { try { s.close(); } catch (e) { /* ignore */ } }); servers = []; }
  function catchOn(port) {
    catchOff();
    if (port !== 4794) { emit({ ev: 'catchon', ok: false }); return; }
    let left = 2, v4 = false, v6 = false;
    const done = () => { if (--left === 0) emit({ ev: 'catchon', ok: v4 || v6, v4, v6 }); };
    ['127.0.0.1', '::1'].forEach((host) => {
      const srv = http.createServer((req, res) => {
        const chunks = []; let n = 0;
        req.on('data', (c) => { n += c.length; if (n < 262144) chunks.push(c); });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }); res.end(PAGE);
          if (req.method === 'POST') { emit({ ev: 'catch', path: req.url || '', body: Buffer.concat(chunks).toString('utf8') }); catchOff(); }
        });
      });
      srv.on('error', () => done());
      srv.listen(port, host, () => { if (host === '::1') v6 = true; else v4 = true; done(); });
      servers.push(srv);
    });
  }

  /* ---- the sign-in window ---- */
  function loginFinish(json) {
    const d = loginDone; loginDone = null;
    const w = loginWin; loginWin = null;
    if (w && !w.isDestroyed()) { try { w.close(); } catch (e) { /* ignore */ } }
    if (d) d(json);
  }
  function login(url) {
    return new Promise((resolve) => {
      if (loginDone) loginFinish({ ok: false, err: 'again' });
      if (!/^https:\/\/account\.samsung\.com\//.test(url)) { resolve({ ok: false, err: 'url' }); return; }
      loginDone = resolve;
      const parent = getWin && getWin();
      const w = new BrowserWindow({ width: 520, height: 760, title: 'Đăng nhập tài khoản Samsung', parent: parent && !parent.isDestroyed() ? parent : undefined, autoHideMenuBar: true, backgroundColor: '#101216',
        webPreferences: { partition: 'persist:samsung', contextIsolation: true, nodeIntegration: false, sandbox: true } });
      loginWin = w;
      /* a plain Chrome name: Samsung's page may refuse an unknown browser */
      const ua = w.webContents.getUserAgent().replace(/\s+(Electron|[^\s]*Sub|hong-sub[\w-]*)\/\S+/gi, '');
      w.webContents.setUserAgent(ua);
      w.webContents.setWindowOpenHandler(({ url: u }) => { w.loadURL(u); return { action: 'deny' }; });   /* links that open a window stay in this one */
      w.webContents.on('will-navigate', (e, u) => {
        /* Google does not sign in inside an app window: Samsung's own e-mail and password */
        if (/^https:\/\/accounts\.google\.com\//.test(u)) {
          e.preventDefault();
          w.webContents.executeJavaScript('alert("Đăng nhập bằng Google không dùng được ở đây. Dùng email và mật khẩu tài khoản Samsung (đặt mật khẩu trong tài khoản Samsung nếu chưa có).")').catch(() => {});
        }
      });
      const caught = (u) => { if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):4794/.test(u || '')) setTimeout(() => loginFinish({ ok: true }), 400); };
      w.webContents.on('did-navigate', (e, u) => caught(u));
      w.webContents.on('did-finish-load', () => caught(w.webContents.getURL()));
      w.on('closed', () => { if (loginWin === w) { loginWin = null; if (loginDone) loginFinish({ ok: false, err: 'closed' }); } });
      w.loadURL(url).catch(() => {});
    });
  }

  /* ---- HTTPS: Samsung's certificate service (multipart forms) and the TV app download ---- */
  async function request(a) {
    let u;
    try { u = new URL(String(a.url || '')); } catch (e) { return { ok: false, err: 'url' }; }
    if (u.protocol !== 'https:' || !HOSTS.test(u.hostname)) return { ok: false, err: 'host' };
    const method = a.method === 'POST' ? 'POST' : 'GET';
    let body;
    if (method === 'POST' && (a.fields || a.files)) {
      body = new FormData();
      Object.keys(a.fields || {}).forEach((k) => body.append(k, String(a.fields[k])));
      (a.files || []).forEach((f) => body.append(f.name, new Blob([Buffer.from(f.b64 || '', 'base64')], { type: f.type || 'application/octet-stream' }), f.filename || 'file'));
    }
    try {
      const r = await fetch(u.href, { method, body, headers: a.headers || {}, redirect: 'follow', signal: AbortSignal.timeout(90000) });
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, status: r.status, b64: buf.toString('base64') };
    } catch (e) { return { ok: false, err: String((e && (e.cause && e.cause.code || e.message)) || e) }; }
  }

  ipcMain.handle('tzr-call', async (e, cmd) => {
    cmd = String(cmd || '');
    if (cmd.startsWith('http:')) { let a; try { a = JSON.parse(cmd.slice(5)); } catch (x) { return { ok: false, err: 'arg' }; } return request(a); }
    if (cmd.startsWith('samsungLogin:')) return login(cmd.slice(13));
    if (cmd === 'samsungClose') { loginFinish({ ok: true }); return { ok: true }; }
    if (cmd.startsWith('pcaddr:')) { try { return { ok: true, addr: lanAddr ? await lanAddr(cmd.slice(7)) : '' }; } catch (x) { return { ok: false }; } }
    return { ok: false, err: 'cmd' };
  });
  ipcMain.on('tzr-send', (e, line) => {
    const p = String(line || '').split(' ');
    if (p[0] === 'tcpopen') tcpOpen(p[1], p[2], +p[3]);
    else if (p[0] === 'tcpsend') tcpSend(p[1], p[2]);
    else if (p[0] === 'tcpclose') tcpClose(p[1]);
    else if (p[0] === 'catchon') catchOn(+p[1]);
    else if (p[0] === 'catchoff') catchOff();
  });
}

module.exports = { setup, _test: { lanIp } };
