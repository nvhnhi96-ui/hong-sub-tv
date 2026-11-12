'use strict';
// PlayStation side of Hóng Sub for Windows: PSN login, finding and waking the console on the
// local network, pairing (via hongsub-rp regist) and the Remote Play stream (via hongsub-rp stream).
// The console protocol itself lives in hongsub-rp, built on chiaki-ng (AGPL-3.0).
const { BrowserWindow, ipcMain, net } = require('electron');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CLIENT_ID = 'ba495a24-818c-472b-b12d-ff231c1b5745';
const CLIENT_SECRET = 'mvaiZkRsAsI1IBkY';
const SCOPE = 'psn:clientapp referenceDataService:countryConfig.read pushNotification:webSocket.desktop.connect sessionManager:remotePlaySession.system.update';
const REDIRECT = 'https://remoteplay.dl.playstation.net/remoteplay/redirect';
const TOKEN_URL = 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token';
function loginUrl() {
  const duid = '0000000700410080' + crypto.randomBytes(16).toString('hex');
  return 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize?service_entity=urn:service-entity:psn&response_type=code&client_id=' + CLIENT_ID +
    '&redirect_uri=' + REDIRECT + '&scope=' + encodeURIComponent(SCOPE) + '&request_locale=en_US&ui=pr&service_logo=ps&layout_type=popup&smcid=remoteplay&prompt=always&PlatformPrivacyWs1=minimal&duid=' + duid + '&';
}
const basic = 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');

function setup(opts) {
  const { userData, helperPath, getWin, log } = opts;
  const file = path.join(userData, 'hongsub-playstation.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { cfg = {}; }
  cfg.hosts = cfg.hosts || {};
  const saveCfg = () => { try { fs.writeFileSync(file, JSON.stringify(cfg, null, 1)); } catch (e) { /* ignore */ } };
  const send = (ch, data) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, data); };

  /* ---------- PSN login (only to read the account id needed for pairing) ---------- */
  async function exchange(code) {
    const body = 'grant_type=authorization_code&code=' + encodeURIComponent(code) + '&scope=' + encodeURIComponent(SCOPE) + '&redirect_uri=' + encodeURIComponent(REDIRECT) + '&';
    const r = await net.fetch(TOKEN_URL, { method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error((j && (j.error_description || j.error)) || ('HTTP ' + r.status));
    const r2 = await net.fetch(TOKEN_URL + '/' + j.access_token, { headers: { Authorization: basic } });
    const j2 = await r2.json().catch(() => ({}));
    if (!r2.ok || !j2.user_id) throw new Error('Không đọc được tài khoản PSN');
    const buf = Buffer.alloc(8); buf.writeBigUInt64LE(BigInt(j2.user_id));
    cfg.account = buf.toString('base64');
    cfg.onlineId = j2.online_id || '';
    saveCfg();
    return { ok: true, onlineId: cfg.onlineId };
  }
  function codeFrom(url) {
    if (!String(url).startsWith(REDIRECT)) return null;
    try { return new URL(url).searchParams.get('code'); } catch (e) { return null; }
  }
  function login() {
    return new Promise((resolve) => {
      const parent = getWin();
      const w = new BrowserWindow({ width: 520, height: 760, parent, modal: false, title: 'Đăng nhập PlayStation Network', autoHideMenuBar: true,
        webPreferences: { partition: 'persist:psn', contextIsolation: true, nodeIntegration: false } });
      w.setMenu(null);
      let done = false;
      const finish = (res) => { if (done) return; done = true; try { w.close(); } catch (e) { /* ignore */ } resolve(res); };
      const check = (e, url) => {
        const code = codeFrom(url);
        if (!code) return;
        if (e && e.preventDefault) e.preventDefault();
        exchange(code).then(finish, (err) => finish({ ok: false, err: String(err.message || err) }));
      };
      w.webContents.on('will-redirect', check);
      w.webContents.on('will-navigate', check);
      w.webContents.on('did-navigate', (e, url) => check(null, url));
      w.on('closed', () => finish({ ok: false, err: 'closed' }));
      const ua = w.webContents.getUserAgent().replace(/ Electron\/\S+/, '').replace(/ HongSub\/\S+/, '').replace(/ hong-sub-pc\/\S+/, '');
      w.loadURL(loginUrl(), { userAgent: ua });
    });
  }

  /* ---------- finding and waking the console (plain UDP, same packets as chiaki-ng) ---------- */
  function broadcasts() {
    const out = new Set(['255.255.255.255']);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
        const ip = a.address.split('.').map(Number), m = a.netmask.split('.').map(Number);
        out.add(ip.map((v, i) => (v & m[i]) | (~m[i] & 255)).join('.'));
      }
    }
    return [...out];
  }
  function parseReply(msg, rinfo) {
    const text = msg.toString('utf8').replace(/\0+$/, '');
    const lines = text.split(/\r?\n/);
    const m = /^HTTP\/1\.1\s+(\d+)/.exec(lines[0] || '');
    if (!m) return null;
    const h = { addr: rinfo.address, state: m[1] === '200' ? 'ready' : m[1] === '620' ? 'standby' : 'unknown' };
    for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
    return { id: h['host-id'] || h.addr, name: h['host-name'] || h.addr, ps5: /PS5/i.test(h['host-type'] || ''), state: h.state, addr: h.addr, app: h['running-app-name'] || '', fw: h['system-version'] || '' };
  }
  function discover(extraIp) {
    return new Promise((resolve) => {
      const found = {};
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', () => {});
      sock.on('message', (msg, rinfo) => { const h = parseReply(msg, rinfo); if (h) found[h.id] = h; });
      sock.bind(0, () => {
        try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
        const pk5 = Buffer.from('SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n\0');
        const pk4 = Buffer.from('SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00020020\n\0');
        const targets = broadcasts(); if (extraIp) targets.push(extraIp);
        for (let k = 0; k < 2; k++) setTimeout(() => {
          for (const t of targets) { sock.send(pk5, 9302, t, () => {}); sock.send(pk4, 987, t, () => {}); }
        }, k * 500);
        setTimeout(() => {
          try { sock.close(); } catch (e) { /* ignore */ }
          const list = Object.values(found).map(h => {
            const reg = cfg.hosts[h.id];
            if (reg && reg.addr !== h.addr) { reg.addr = h.addr; saveCfg(); }
            return Object.assign(h, { registered: !!reg });
          });
          // registered consoles that did not answer (off, or on another network)
          for (const reg of Object.values(cfg.hosts)) if (!found[reg.id]) list.push({ id: reg.id, name: reg.name, ps5: reg.ps5, addr: reg.addr, state: 'offline', registered: true });
          resolve(list);
        }, 1600);
      });
    });
  }
  function wake(id) {
    const h = cfg.hosts[id];
    if (!h) return Promise.resolve({ ok: false, err: 'not registered' });
    const key = Buffer.from(h.regist_key, 'base64').toString('latin1').replace(/\0.*$/, '');
    let cred;
    try { cred = BigInt('0x' + key).toString(10); } catch (e) { return Promise.resolve({ ok: false, err: 'bad key' }); }
    const ver = h.ps5 ? '00030010' : '00020020';
    const pk = Buffer.from('WAKEUP * HTTP/1.1\nclient-type:vr\nauth-type:R\nmodel:w\napp-type:r\nuser-credential:' + cred + '\ndevice-discovery-protocol-version:' + ver + '\n\0');
    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', () => {});
      sock.bind(0, () => {
        try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
        sock.send(pk, h.ps5 ? 9302 : 987, h.addr, (err) => { try { sock.close(); } catch (e) { /* ignore */ } resolve({ ok: !err, err: err ? String(err) : '' }); });
      });
    });
  }

  /* ---------- pairing ---------- */
  function regist(host, pin) {
    return new Promise((resolve) => {
      if (!cfg.account) return resolve({ ok: false, err: 'login' });
      if (!fs.existsSync(helperPath())) return resolve({ ok: false, err: 'missing' });
      const p = spawn(helperPath(), ['regist', host.addr, host.ps5 ? '1' : '0', cfg.account, String(pin).replace(/\D/g, '')], { windowsHide: true });
      let out = '', err = '';
      p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
      p.on('error', (e) => resolve({ ok: false, err: String(e) }));
      p.on('exit', () => {
        const line = out.split(/\r?\n/).filter(l => l.startsWith('{')).pop();
        let j = null; try { j = JSON.parse(line); } catch (e) { /* ignore */ }
        if (j && j.ok) {
          cfg.hosts[host.id] = { id: host.id, name: j.nickname || host.name, ps5: !!host.ps5, addr: host.addr, regist_key: j.regist_key, morning: j.morning, mac: j.mac };
          saveCfg();
          resolve({ ok: true, name: cfg.hosts[host.id].name });
        } else resolve({ ok: false, err: (j && j.err) || 'failed', log: err.slice(-800) });
      });
    });
  }

  /* ---------- stream ---------- */
  let sp = null, buf = Buffer.alloc(0);
  function stop(sleep) {
    if (!sp) return;
    try { sp.stdin.write(sleep ? 's\n' : 'q\n'); } catch (e) { /* ignore */ }
    const p = sp; setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } }, 3000);
  }
  function connect(id, o) {
    const h = cfg.hosts[id];
    if (!h) return { ok: false, err: 'not registered' };
    if (!fs.existsSync(helperPath())) return { ok: false, err: 'missing' };
    if (sp) stop(false);
    const res = String((o && o.res) || (h.ps5 ? 1080 : 720)), fps = String((o && o.fps) || 60);
    const p = spawn(helperPath(), ['stream', h.addr, h.ps5 ? '1' : '0', h.regist_key, h.morning, res, fps], { windowsHide: true });
    sp = p; buf = Buffer.alloc(0);
    p.stdout.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 5) {
        const len = buf.readUInt32LE(1);
        if (buf.length < 5 + len) break;
        const type = buf[0], payload = buf.subarray(5, 5 + len);
        buf = buf.subarray(5 + len);
        if (type === 1) send('ps-v', payload);
        else if (type === 2) send('ps-ah', JSON.parse(payload.toString('utf8')));
        else if (type === 3) send('ps-a', payload);
        else if (type === 9) { let ev = null; try { ev = JSON.parse(payload.toString('utf8')); } catch (e) { /* ignore */ } if (ev) { if (ev.ev === 'log') { if (log && ev.level <= 4) log('rp: ' + ev.msg); } else send('ps-ev', ev); } }
      }
      if (buf.length > 0 && buf.length < 4096) buf = Buffer.from(buf); // detach from big chunk
    });
    p.stderr.on('data', () => {});
    p.on('error', (e) => send('ps-ev', { ev: 'quit', reason: -1, text: String(e), str: '' }));
    p.on('exit', (code) => { if (sp === p) sp = null; send('ps-ev', { ev: 'closed', code }); });
    return { ok: true, name: h.name };
  }

  ipcMain.handle('ps-state', () => ({ helper: fs.existsSync(helperPath()), loggedIn: !!cfg.account, onlineId: cfg.onlineId || '', hosts: Object.values(cfg.hosts).map(h => ({ id: h.id, name: h.name, ps5: h.ps5, addr: h.addr })) }));
  ipcMain.handle('ps-login', () => login());
  ipcMain.handle('ps-login-url', (e, url) => { const c = codeFrom(url); return c ? exchange(c).catch(err => ({ ok: false, err: String(err.message || err) })) : { ok: false, err: 'url' }; });
  ipcMain.handle('ps-logout', () => { delete cfg.account; delete cfg.onlineId; saveCfg(); return true; });
  ipcMain.handle('ps-discover', (e, ip) => discover(ip));
  ipcMain.handle('ps-regist', (e, host, pin) => regist(host, pin));
  ipcMain.handle('ps-forget', (e, id) => { delete cfg.hosts[id]; saveCfg(); return true; });
  ipcMain.handle('ps-wake', (e, id) => wake(id));
  ipcMain.handle('ps-connect', (e, id, o) => connect(id, o));
  ipcMain.on('ps-input', (e, line) => { if (sp) { try { sp.stdin.write(line + '\n'); } catch (x) { /* ignore */ } } });
  ipcMain.on('ps-stop', (e, sleep) => stop(!!sleep));

  return { stop: () => stop(false), discover, cfg: () => cfg };
}

module.exports = { setup };
