'use strict';
// Hóng Sub for Windows: wraps the Hóng Sub page (app/index.html) and adds what a browser tab cannot do:
// picks the PS Remote Play window by itself, shows subtitles in a transparent always-on-top bar over the game,
// global hotkeys, Windows voices, tray icon and keeps running while minimised.
const {
  app, BrowserWindow, protocol, net, session, desktopCapturer, ipcMain, globalShortcut,
  Tray, Menu, screen, shell, nativeImage, Notification
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const psModule = require('./ps');

const SELFTEST = process.argv.includes('--selftest') || process.env.HS_SELFTEST === '1';
const ROOT = __dirname;
const UPDATE_API = 'https://api.github.com/repos/nvhnhi96-ui/hong-sub-tv/releases/latest';

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

if (!SELFTEST && !app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('store.honggame.hongsub.pc');

let win = null, overlay = null, tray = null, fakeGame = null, ps = null;
let chosenId = null, quitting = false, moveMode = false;

/* ---------- settings file ---------- */
const cfgFile = () => path.join(app.getPath('userData'), 'hongsub-window.json');
let cfg = {};
function loadCfg() { try { cfg = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch (e) { cfg = {}; } }
function saveCfg() { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg)); } catch (e) { /* ignore */ } }

/* ---------- files served as app://hongsub/... ---------- */
function serveFiles() {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      const h = new Headers(res.headers);
      h.set('Cross-Origin-Opener-Policy', 'same-origin');
      h.set('Cross-Origin-Embedder-Policy', 'credentialless');
      if (file.endsWith('.wasm')) h.set('Content-Type', 'application/wasm');
      else if (file.endsWith('.mjs') || file.endsWith('.js')) h.set('Content-Type', 'text/javascript');
      return new Response(res.body, { status: res.status, headers: h });
    });
  });
}

/* ---------- main window ---------- */
function createMain() {
  const b = cfg.main || {};
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 860, x: b.x, y: b.y,
    minWidth: 900, minHeight: 600,
    title: 'Hóng Sub', backgroundColor: '#0B0B0D',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
      additionalArguments: SELFTEST ? ['--hs-selftest'] : []
    }
  });
  win.setMenu(null);
  win.loadURL('app://hongsub/app/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); shell.openExternal(url); } });
  const remember = () => { if (!win.isMinimized() && !win.isMaximized()) { cfg.main = win.getBounds(); saveCfg(); } };
  win.on('resize', remember); win.on('move', remember);
  win.on('close', (e) => {
    if (quitting || SELFTEST) return;
    e.preventDefault(); win.hide();
    if (!cfg.trayTold && Notification.isSupported()) {
      new Notification({ title: 'Hóng Sub vẫn đang chạy', body: 'Bấm biểu tượng chữ H ở góc phải thanh tác vụ để mở lại, hoặc chọn Thoát để tắt hẳn.' }).show();
      cfg.trayTold = true; saveCfg();
    }
  });
}

/* ---------- floating subtitle bar ---------- */
function overlayBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const def = { width: Math.round(wa.width * 0.8), height: 230 };
  def.x = wa.x + Math.round((wa.width - def.width) / 2);
  def.y = wa.y + wa.height - def.height - Math.round(wa.height * 0.04);
  const o = cfg.overlay;
  if (o && screen.getAllDisplays().some(d => o.x >= d.bounds.x - 50 && o.x < d.bounds.x + d.bounds.width && o.y >= d.bounds.y - 50 && o.y < d.bounds.y + d.bounds.height)) {
    return { x: o.x, y: o.y, width: o.width || def.width, height: o.height || def.height };
  }
  return def;
}
function createOverlay() {
  overlay = new BrowserWindow({
    ...overlayBounds(),
    transparent: true, frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    title: 'Hóng Sub phụ đề',
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true);
  overlay.setContentProtection(true); // never captured, so it cannot be read back as a subtitle
  overlay.loadURL('app://hongsub/overlay.html');
  overlay.once('ready-to-show', () => { if (!cfg.overlayHidden) overlay.showInactive(); sendOverlayState(); });
  overlay.on('moved', () => { cfg.overlay = overlay.getBounds(); saveCfg(); });
}
/* ---------- one floating window per extra area ("Vùng 1", "Vùng 2"...) ----------
   By default each window sits where that area is on the main screen, so the Vietnamese covers the English
   (right when the game runs full screen). Moved or resized windows keep their place. */
const zoneWins = new Map();          // id -> { win, data, key }
function zoneDefault(d) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: Math.round(wa.x + d.x * wa.width), y: Math.round(wa.y + d.y * wa.height),
    width: Math.max(240, Math.round(d.w * wa.width)), height: Math.max(80, Math.round(d.h * wa.height)) };
}
function zoneBounds(d) {
  const s = (cfg.zoneWins || {})[d.id];
  const ok = s && screen.getAllDisplays().some(dp => s.x >= dp.bounds.x - 50 && s.x < dp.bounds.x + dp.bounds.width && s.y >= dp.bounds.y - 50 && s.y < dp.bounds.y + dp.bounds.height);
  return ok ? s : zoneDefault(d);
}
function zoneVisible(z) {
  if (!z || z.win.isDestroyed()) return;
  const show = (!!z.data.vi || moveMode) && !cfg.overlayHidden && !cfg.zonesHidden;
  if (show && !z.win.isVisible()) z.win.showInactive(); else if (!show && z.win.isVisible()) z.win.hide();
}
function zoneMake(d) {
  const b = zoneBounds(d);
  const w = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: true, frame: false, resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    title: 'Hóng Sub ' + d.name,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.setIgnoreMouseEvents(!moveMode);
  w.setFocusable(moveMode);
  w.setContentProtection(true);           // never read back by our own screen capture
  const z = { win: w, data: d, key: [d.x, d.y, d.w, d.h].join(','), quiet: false };
  w.on('moved', () => { if (z.quiet) return; cfg.zoneWins = cfg.zoneWins || {}; cfg.zoneWins[d.id] = w.getBounds(); saveCfg(); });
  w.loadURL('app://hongsub/zone.html');
  w.webContents.once('did-finish-load', () => { w.webContents.send('zone', z.data); w.webContents.send('overlay-state', { move: moveMode }); zoneVisible(z); });
  zoneWins.set(d.id, z);
  return z;
}
function zonesUpdate(list) {
  const ids = new Set();
  for (const d of (Array.isArray(list) ? list : [])) {
    if (!d || !d.id) continue;
    ids.add(d.id);
    let z = zoneWins.get(d.id);
    if (!z || z.win.isDestroyed()) z = zoneMake(d);
    const key = [d.x, d.y, d.w, d.h].join(',');
    if (key !== z.key) {                  // the area was drawn again: follow it unless the user placed the window
      z.key = key;
      if (!(cfg.zoneWins || {})[d.id]) { z.quiet = true; z.win.setBounds(zoneDefault(d)); setTimeout(() => { z.quiet = false; }, 300); }
    }
    z.data = d;
    if (!z.win.webContents.isLoading()) z.win.webContents.send('zone', d);
    zoneVisible(z);
  }
  for (const [id, z] of zoneWins) {
    if (!ids.has(id)) { try { z.win.destroy(); } catch (e) { /* ignore */ } zoneWins.delete(id); if (cfg.zoneWins) { delete cfg.zoneWins[id]; saveCfg(); } }
  }
}
function zonesVisible() { for (const z of zoneWins.values()) zoneVisible(z); }

/* ---------- whole-screen translation: one click-through window over the main screen ----------
   Each translated block is drawn where the English is (positions are shares of the game picture, which is
   right when the game fills the screen). Content protection keeps it out of our own capture. */
let fullWin = null, fullData = null;
function fullMake() {
  const b = screen.getPrimaryDisplay().bounds;
  fullWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: true, frame: false, resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false, show: false,
    title: 'Hóng Sub dịch cả màn hình',
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  fullWin.setAlwaysOnTop(true, 'screen-saver');
  fullWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  fullWin.setIgnoreMouseEvents(true);
  fullWin.setContentProtection(true);
  fullWin.loadURL('app://hongsub/full.html');
  fullWin.webContents.on('did-finish-load', () => { if (fullData) fullWin.webContents.send('full', fullData); });
  fullWin.on('closed', () => { fullWin = null; });
}
function fullShow(d) {
  fullData = d && d.items && d.items.length ? d : null;
  if (!fullData) { if (fullWin && !fullWin.isDestroyed()) { fullWin.webContents.send('full', null); fullWin.hide(); } return; }
  if (!fullWin || fullWin.isDestroyed()) fullMake();
  const b = screen.getPrimaryDisplay().bounds; fullWin.setBounds(b);
  if (!fullWin.webContents.isLoading()) fullWin.webContents.send('full', fullData);
  if (!fullWin.isVisible()) fullWin.showInactive();
}
/* ---------- new versions ---------- */
async function checkUpdate() {
  try {
    const r = await net.fetch(UPDATE_API + '?t=' + Date.now(), { headers: { 'User-Agent': 'HongSub', 'Cache-Control': 'no-cache' } });
    if (!r.ok) return null;
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    const cur = app.getVersion();
    const n = (v) => v.split('.').map(x => parseInt(x, 10) || 0);
    const a = n(latest), c = n(cur);
    let newer = false;
    for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (c[i] || 0)) { newer = (a[i] || 0) > (c[i] || 0); break; } }
    const asset = (j.assets || []).find(x => x.name === 'hong-sub-pc.exe');
    return { version: latest, current: cur, newer: newer && !!asset, url: asset ? asset.browser_download_url : '', size: asset ? asset.size : 0 };
  } catch (e) { return null; }
}
async function updateTick() {
  const u = await checkUpdate();
  if (!u || !u.newer) return;
  if (win && !win.isDestroyed()) win.webContents.send('update-available', u);
  if (cfg.updTold !== u.version && Notification.isSupported()) {
    cfg.updTold = u.version; saveCfg();
    const nt = new Notification({ title: 'Có bản Hóng Sub mới ' + u.version, body: 'Mở Hóng Sub và bấm "Cập nhật" để lên bản mới, mã và cài đặt vẫn giữ nguyên.' });
    nt.on('click', () => { if (win) { win.show(); win.focus(); } });
    nt.show();
  }
}
function sendOverlayState() {
  const st = { hidden: !!cfg.overlayHidden, move: moveMode, zonesHidden: !!cfg.zonesHidden };
  if (win && !win.isDestroyed()) win.webContents.send('overlay-state', st);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay-state', st);
  for (const z of zoneWins.values()) if (!z.win.isDestroyed()) z.win.webContents.send('overlay-state', st);
  zonesVisible();
  buildTrayMenu();
}
function overlayCmd(cmd) {
  if (!overlay) return;
  if (cmd === 'toggle') {
    cfg.overlayHidden = !cfg.overlayHidden; saveCfg();
    if (cfg.overlayHidden) { if (moveMode) setMove(false); overlay.hide(); } else overlay.showInactive();
  } else if (cmd === 'move') {
    setMove(!moveMode);
  } else if (cmd === 'done') {
    setMove(false);
  } else if (cmd === 'reset') {
    cfg.overlay = null; saveCfg(); overlay.setBounds(overlayBounds());
  }
  sendOverlayState();
}
function setMove(on) {
  moveMode = on;
  if (on) {
    if (cfg.overlayHidden) { cfg.overlayHidden = false; saveCfg(); }
    overlay.setIgnoreMouseEvents(false); overlay.setFocusable(true); overlay.show();
    for (const z of zoneWins.values()) if (!z.win.isDestroyed()) { z.win.setIgnoreMouseEvents(false); z.win.setFocusable(true); }
  } else {
    overlay.setIgnoreMouseEvents(true); overlay.setFocusable(false);
    for (const z of zoneWins.values()) if (!z.win.isDestroyed()) { z.win.setIgnoreMouseEvents(true); z.win.setFocusable(false); }
    cfg.overlay = overlay.getBounds(); saveCfg();
    if (!cfg.overlayHidden) overlay.showInactive();
  }
}

/* ---------- tray ---------- */
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở Hóng Sub', click: showMain },
    { label: 'Bật/tắt dịch (' + keys().toggle + ')', click: () => hotkey('toggle') },
    { label: cfg.overlayHidden ? 'Hiện phụ đề nổi (' + keys().ovl + ')' : 'Ẩn phụ đề nổi (' + keys().ovl + ')', click: () => overlayCmd('toggle') },
    { label: moveMode ? 'Xong di chuyển phụ đề (' + keys().move + ')' : 'Di chuyển phụ đề (' + keys().move + ')', click: () => overlayCmd('move') },
    { label: 'Đưa phụ đề về chỗ cũ', click: () => overlayCmd('reset') },
    { type: 'separator' },
    { label: 'Thoát Hóng Sub', click: () => { quitting = true; app.quit(); } }
  ]));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png')));
  tray.setToolTip('Hóng Sub · dịch phụ đề game');
  tray.on('click', showMain);
  buildTrayMenu();
}
function showMain() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

/* ---------- hotkeys ---------- */
function hotkey(k) { if (win && !win.isDestroyed()) win.webContents.send('hotkey', k); }
const KEY_DEFAULT = { toggle: 'F7', now: 'F8', ovl: 'F9', move: 'F10', full: 'F11', zones: 'F6', speak: 'F5' };
const KEY_ACT = { toggle: () => hotkey('toggle'), now: () => hotkey('now'), ovl: () => overlayCmd('toggle'), move: () => overlayCmd('move'), full: () => hotkey('full'), zones: () => hotkey('zones'), speak: () => hotkey('speak') };
function keys() { return Object.assign({}, KEY_DEFAULT, cfg.hotkeys || {}); }
function registerKeys() {
  globalShortcut.unregisterAll();
  const res = {};
  const k = keys();
  for (const id of Object.keys(KEY_ACT)) {
    if (!k[id]) { res[id] = 'off'; continue; }
    try { res[id] = globalShortcut.register(k[id], KEY_ACT[id]) ? 'ok' : 'busy'; } catch (e) { res[id] = 'bad'; }
  }
  return res;
}
/* Sony's own PS Remote Play app, if it is installed */
function sonyRp() {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  for (const b of bases) { const f = path.join(b, 'Sony', 'PS Remote Play', 'RemotePlay.exe'); if (fs.existsSync(f)) return f; }
  return '';
}

/* ---------- screen capture: pick PS Remote Play without asking ---------- */
async function listSources(withThumbs) {
  const size = withThumbs ? { width: 320, height: 180 } : { width: 1, height: 1 };
  const srcs = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: size });
  return srcs.filter(s => !/^Hóng Sub/.test(s.name));
}
function setupCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    try {
      const srcs = await listSources(false);
      const s = srcs.find(x => x.id === chosenId) || srcs.find(x => /remote play/i.test(x.name)) || srcs.find(x => x.id.startsWith('screen'));
      cb(s ? { video: s } : {});
    } catch (e) { cb({}); }
  });
}

/* ---------- Windows voices (PowerShell helper, Windows.Media.SpeechSynthesis) ---------- */
let tts = null, ttsBuf = '', ttsSeq = 0;
const ttsWait = new Map();
function ttsStart() {
  if (process.platform !== 'win32' || tts) return;
  try {
    tts = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tts.ps1')], { windowsHide: true });
  } catch (e) { tts = null; return; }
  tts.stdout.setEncoding('utf8');
  tts.stdout.on('data', (d) => {
    ttsBuf += d;
    let i;
    while ((i = ttsBuf.indexOf('\n')) >= 0) {
      const line = ttsBuf.slice(0, i).trim(); ttsBuf = ttsBuf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      const w = ttsWait.get(m.id); if (w) { ttsWait.delete(m.id); w(m); }
    }
  });
  tts.on('exit', () => { tts = null; for (const w of ttsWait.values()) w({ err: 'tts exited' }); ttsWait.clear(); });
}
function ttsCall(msg, timeout) {
  ttsStart();
  if (!tts) return Promise.resolve({ err: 'no tts' });
  const id = ++ttsSeq; msg.id = id;
  return new Promise((done) => {
    const t = setTimeout(() => { ttsWait.delete(id); done({ err: 'timeout' }); }, timeout || 15000);
    ttsWait.set(id, (m) => { clearTimeout(t); done(m); });
    tts.stdin.write(JSON.stringify(msg) + '\n');
  });
}
const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');

/* ---------- bundled tools: Remote Play (chiaki-ng) and Vietnamese voice (Piper) ---------- */
function resDir(name) { return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(ROOT, name); }
function findFile(dir, test, depth) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && test(e.name)) return p;
    }
    if ((depth || 0) < 3) for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { const f = findFile(path.join(dir, e.name), test, (depth || 0) + 1); if (f) return f; }
    }
  } catch (e) { /* missing */ }
  return null;
}
const rpHelper = () => findFile(resDir('rp'), n => /^hongsub-rp\.exe$/i.test(n)) || path.join(resDir('rp'), 'hongsub-rp.exe');
const rpExe = () => findFile(resDir('remoteplay'), n => /^chiaki(-ng)?\.exe$/i.test(n));
let rpProc = null;
function rpLaunch(opengl) {
  const exe = rpExe();
  if (!exe) return { ok: false, err: 'missing' };
  if (rpProc && rpProc.exitCode === null) return { ok: true, running: true };
  try {
    rpProc = spawn(exe, opengl ? ['--opengl'] : [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
    rpProc.on('exit', () => { rpProc = null; if (win && !win.isDestroyed()) win.webContents.send('rp-exit'); });
    rpProc.unref();
    return { ok: true };
  } catch (e) { return { ok: false, err: String(e.message || e) }; }
}

// Piper: offline Vietnamese voice. One process stays loaded; each stdin line becomes one wav file.
const VOICE_NAME = 'Giọng Việt Hóng Sub (có sẵn)';
let piper = null, piperRate = null, piperOut = '', piperQ = [];
function piperPaths() {
  const dir = resDir('voices');
  return { exe: findFile(dir, n => /^piper\.exe$/i.test(n)), model: findFile(dir, n => /\.onnx$/i.test(n)) };
}
function piperStart(rate) {
  const { exe, model } = piperPaths();
  if (!exe || !model) return false;
  if (piper && piperRate === rate) return true;
  if (piper) { try { piper.kill(); } catch (e) { /* ignore */ } piper = null; }
  const out = path.join(os.tmpdir(), 'hongsub-voice'); fs.mkdirSync(out, { recursive: true });
  piper = spawn(exe, ['--model', model, '--output_dir', out, '--length_scale', (1 / Math.max(0.5, rate || 1)).toFixed(2), '--sentence_silence', '0.1'], { cwd: path.dirname(exe), windowsHide: true });
  piperRate = rate; piperOut = '';
  piper.stdout.setEncoding('utf8');
  piper.stdout.on('data', (d) => {
    piperOut += d; let i;
    while ((i = piperOut.indexOf('\n')) >= 0) {
      const line = piperOut.slice(0, i).trim(); piperOut = piperOut.slice(i + 1);
      if (!/\.wav$/i.test(line)) continue;
      const done = piperQ.shift(); if (!done) continue;
      try { const buf = fs.readFileSync(line); fs.unlink(line, () => {}); done({ wav: buf.toString('base64') }); } catch (e) { done({ err: String(e) }); }
    }
  });
  piper.stderr.on('data', () => {});
  piper.on('exit', () => { piper = null; while (piperQ.length) piperQ.shift()({ err: 'voice stopped' }); });
  return true;
}
function piperSpeak(text, rate) {
  const r = Math.round((rate || 1) * 10) / 10;
  if (!piperStart(r)) return Promise.resolve({ err: 'novoice' });
  return new Promise((done) => {
    const t = setTimeout(() => { const i = piperQ.indexOf(fin); if (i >= 0) piperQ.splice(i, 1); done({ err: 'timeout' }); }, 20000);
    const fin = (m) => { clearTimeout(t); done(m); };
    piperQ.push(fin);
    piper.stdin.write(String(text).replace(/[\r\n]+/g, ' ').trim() + '\n');
  });
}

/* ---------- AI voices (VieNeu-TTS v3 Turbo pack, downloaded once) ---------- */
const AIV_URL = 'https://github.com/nvhnhi96-ui/hong-sub-tv/releases/download/voices-1/hong-sub-voices.zip';
const aiv = { proc: null, ready: false, voices: [], err: '', busy: '', got: 0, total: 0, buf: '', startMs: 0 };
function aivDir() { return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'HongSub', 'voices'); }   /* short ASCII path: Python and long model paths */
function aivPy() { const d = aivDir(); const py = path.join(d, 'python', 'python.exe'); return fs.existsSync(py) && fs.existsSync(path.join(d, 'hs_voice.py')) ? py : ''; }
function aivState() { return { installed: !!aivPy(), running: !!aiv.proc, ready: aiv.ready, voices: aiv.voices, err: aiv.err, busy: aiv.busy, got: aiv.got, total: aiv.total, fast: !!cfg.aivFast, startMs: aiv.startMs }; }
function aivSend(ch, m) { if (win && !win.isDestroyed()) win.webContents.send(ch, m); }
function aivNotify() { aivSend('aiv-state', aivState()); }
function aivStart() {
  const py = aivPy();
  if (!py || aiv.proc) return !!aiv.proc;
  aiv.ready = false; aiv.err = ''; aiv.buf = ''; const t0 = Date.now();
  const env = Object.assign({}, process.env, { HS_VOICE_PREC: cfg.aivFast ? 'int8' : 'fp32', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HS_VOICE_THREADS: String(Math.max(2, Math.min(6, os.cpus().length - 2))) });
  const proc = spawn(py, ['-u', path.join(aivDir(), 'hs_voice.py')], { cwd: aivDir(), windowsHide: true, env });
  aiv.proc = proc;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    aiv.buf += d; let i;
    while ((i = aiv.buf.indexOf('\n')) >= 0) {
      const line = aiv.buf.slice(0, i).trim(); aiv.buf = aiv.buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      if (aiv.tap) aiv.tap(m);
      if (m.type === 'ready') { aiv.ready = true; aiv.voices = m.voices || []; aiv.startMs = Date.now() - t0; aivNotify(); }
      else if (m.type === 'audio' || m.type === 'error') aivSend('aiv-audio', m);
      else if (m.type === 'fatal') { aiv.err = m.err || 'lỗi'; aivNotify(); }
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('exit', (code) => { if (aiv.proc === proc) { aiv.proc = null; aiv.ready = false; if (code && !aiv.err) aiv.err = 'Bộ giọng AI dừng (mã ' + code + ')'; aivNotify(); } });
  proc.on('error', (e) => { aiv.err = String(e.message || e); aivNotify(); });
  aivNotify();
  return true;
}
function aivStop() { if (aiv.proc) { try { aiv.proc.stdin.write('{"cmd":"quit"}\n'); } catch (e) { /* ignore */ } const p = aiv.proc; setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } }, 1500); aiv.proc = null; aiv.ready = false; } }
async function aivInstall() {
  if (aiv.busy) return aivState();
  aiv.busy = 'download'; aiv.err = ''; aiv.got = 0; aiv.total = 0; aivNotify();
  const tmp = path.join(app.getPath('temp'), 'hong-sub-voices.zip');
  try {
    const r = await net.fetch(AIV_URL);
    if (!r.ok) throw new Error('Không tải được bộ giọng (HTTP ' + r.status + ')');
    aiv.total = +r.headers.get('content-length') || 0;
    const out = fs.createWriteStream(tmp);
    const reader = r.body.getReader(); let last = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (!out.write(Buffer.from(value))) await new Promise(res => out.once('drain', res));
      aiv.got += value.length;
      if (Date.now() - last > 400) { last = Date.now(); aivNotify(); }
    }
    await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));
    aiv.busy = 'unzip'; aivNotify();
    aivStop();
    const dir = aivDir(), part = dir + '.new';
    fs.rmSync(part, { recursive: true, force: true }); fs.mkdirSync(part, { recursive: true });
    const unzip = (cmd, args) => new Promise((res, rej) => {
      let er = '';
      const pr = spawn(cmd, args, { windowsHide: true });
      pr.stderr.on('data', d => { er += d; }); pr.stdout.on('data', () => {});
      pr.on('exit', c => c === 0 ? res() : rej(new Error('Giải nén lỗi (mã ' + c + ') ' + er.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200))));
      pr.on('error', rej);
    });
    try { await unzip(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', tmp, '-C', part]); }
    catch (e1) {
      fs.rmSync(part, { recursive: true, force: true }); fs.mkdirSync(part, { recursive: true });
      try { await unzip('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Expand-Archive -LiteralPath '" + tmp.replace(/'/g, "''") + "' -DestinationPath '" + part.replace(/'/g, "''") + "' -Force"]); }
      catch (e2) { throw new Error(e1.message + ' / ' + e2.message); }
    }
    fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(part, dir);
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    aiv.busy = ''; cfg.aivOn = true; saveCfg(); aivStart();
  } catch (e) {
    aiv.busy = ''; aiv.err = String(e.message || e); try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ }
  }
  aivNotify();
  return aivState();
}

/* ---------- IPC ---------- */
function setupIpc() {
  ipcMain.handle('aiv-state', () => aivState());
  ipcMain.handle('aiv-install', () => aivInstall());
  ipcMain.handle('aiv-start', () => { aivStart(); return aivState(); });
  ipcMain.handle('aiv-fast', (e, on) => { cfg.aivFast = !!on; saveCfg(); aivStop(); setTimeout(aivStart, 1600); return aivState(); });
  ipcMain.handle('aiv-remove', () => { aivStop(); setTimeout(() => { try { fs.rmSync(aivDir(), { recursive: true, force: true }); } catch (e) { /* ignore */ } aivNotify(); }, 1800); return true; });
  ipcMain.on('aiv-speak', (e, m) => { if (!aiv.proc) aivStart(); if (aiv.proc) { try { aiv.proc.stdin.write(JSON.stringify({ cmd: 'speak', id: m.id, text: String(m.text || '').replace(/[\r\n]+/g, ' '), voice: m.voice || '' }) + '\n'); } catch (x) { /* ignore */ } } });
  ipcMain.on('aiv-stop', () => { if (aiv.proc) { try { aiv.proc.stdin.write('{"cmd":"stop"}\n'); } catch (x) { /* ignore */ } } });
  ipcMain.handle('sources', async () => (await listSources(true)).map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() })));
  ipcMain.handle('windows', async () => (await listSources(false)).map(s => ({ id: s.id, name: s.name })));
  ipcMain.handle('rp-info', () => ({ bundled: !!rpExe(), running: !!(rpProc && rpProc.exitCode === null) }));
  ipcMain.handle('rp-launch', (e, opengl) => rpLaunch(!!opengl));
  ipcMain.handle('use', (e, id) => { chosenId = id; return true; });
  ipcMain.on('zones', (e, list) => zonesUpdate(list));
  /* ---------- the TV on the home network (Hóng Sub TV listens on 8765, answers broadcasts on 8766) ---------- */
  ipcMain.handle('tv-find', () => new Promise((resolve) => {
    const dgram = require('dgram'), os = require('os'), found = {};
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => {});
    sock.on('message', (m, r) => { try { const j = JSON.parse(String(m)); if (j.app === 'hongsubtv') found[r.address] = Object.assign(j, { ip: r.address }); } catch (e) { /* ignore */ } });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
      const q = Buffer.from('HONGSUB_TV?');
      const targets = new Set(['255.255.255.255']);
      for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
        const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
        targets.add(ip.map((v, i) => (v & mask[i]) | (~mask[i] & 255)).join('.'));
      }
      const send = () => { for (const t of targets) sock.send(q, 8766, t, () => {}); };
      send(); setTimeout(send, 400); setTimeout(send, 900);
    });
    setTimeout(() => { try { sock.close(); } catch (e) { /* ignore */ } resolve(Object.values(found)); }, 1800);
  }));
  function tvHttp(ip, pathname, body) {
    return new Promise((resolve) => {
      const http = require('http');
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ''))) return resolve({ ok: false, err: 'ip' });
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = http.request({ host: ip, port: 8765, path: pathname, method: data ? 'POST' : 'GET', timeout: 3000,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; });
        res.on('end', () => { try { resolve(Object.assign({ ok: res.statusCode === 200 }, JSON.parse(t || '{}'))); } catch (e) { resolve({ ok: res.statusCode === 200 }); } });
      });
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
      req.on('error', (e) => resolve({ ok: false, err: e.code || e.message }));
      if (data) req.write(data);
      req.end();
    });
  }
  ipcMain.handle('tv-ping', (e, ip) => tvHttp(ip, '/ping'));
  ipcMain.handle('tv-send', (e, ip, msg) => tvHttp(ip, '/sub', msg));
  /* the TV code way, through honggame.store: sent from here so the page's app:// address never meets CORS */
  ipcMain.handle('tv-relay', async (e, msg) => {
    try {
      const r = await net.fetch('https://honggame.store/wp-json/hgs-sub/v1/push', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'HongSub/' + app.getVersion() }, body: JSON.stringify(msg) });
      const body = (await r.text()).slice(0, 200);
      return { ok: r.ok, status: r.status, body };
    } catch (err) { return { ok: false, status: 0, err: String(err && err.message || err) }; }
  });
  ipcMain.on('full-overlay', (e, d) => fullShow(d));
  ipcMain.handle('zones-reset', () => { cfg.zoneWins = {}; saveCfg(); for (const z of zoneWins.values()) if (!z.win.isDestroyed()) { z.quiet = true; z.win.setBounds(zoneDefault(z.data)); setTimeout(() => { z.quiet = false; }, 300); } return true; });
  ipcMain.on('zone-size', (e, id, w, h) => {
    const z = zoneWins.get(id); if (!z || z.win.isDestroyed() || !moveMode) return;
    z.win.setSize(Math.max(200, Math.round(w)), Math.max(60, Math.round(h)));
    cfg.zoneWins = cfg.zoneWins || {}; cfg.zoneWins[id] = z.win.getBounds(); saveCfg();
  });
  ipcMain.handle('zones-panel', (e, on) => { cfg.zonesHidden = !on; saveCfg(); zonesVisible(); return true; });
  ipcMain.on('sub', (e, payload) => { if (overlay && !overlay.isDestroyed()) overlay.webContents.send('sub', payload); });
  ipcMain.on('overlay', (e, cmd) => overlayCmd(cmd));
  ipcMain.handle('voices', async () => {
    const list = [];
    const pp = piperPaths(); if (pp.exe && pp.model) list.push({ name: VOICE_NAME, lang: 'vi-VN', id: 'hs:piper' });
    const r = await ttsCall({ cmd: 'voices' }, 20000);
    (r.voices || []).forEach(v => list.push({ name: v.name, lang: v.lang, id: 'win:' + v.name }));
    return list;
  });
  ipcMain.handle('speak', async (e, text, voice, rate) => {
    if (!text) return { stop: true };
    voice = voice || '';
    if (voice.startsWith('win:')) return ttsCall({ cmd: 'speak', text: b64(text), voice: voice.slice(4), rate: rate || 1 }, 20000);
    const r = await piperSpeak(text, rate);
    if (r.wav || voice === 'hs:piper') return r;
    return ttsCall({ cmd: 'speak', text: b64(text), voice: '', rate: rate || 1 }, 20000);
  });
  ipcMain.on('voice-settings', () => shell.openExternal('ms-settings:speech'));
  ipcMain.handle('update', () => checkUpdate());
  /* one click: download the new installer, run it quietly, Hóng Sub closes and opens again on the new version */
  let updBusy = false;
  ipcMain.handle('update-install', async () => {
    if (updBusy) return { ok: false, err: 'busy' };
    const u = await checkUpdate();
    if (!u || !u.newer || !u.url) return { ok: false, err: 'none' };
    updBusy = true;
    try {
      const file = path.join(os.tmpdir(), 'HongSub-' + u.version + '.exe');
      const r = await net.fetch(u.url, { headers: { 'User-Agent': 'HongSub' } });
      if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
      const total = +r.headers.get('content-length') || u.size || 0;
      const out = fs.createWriteStream(file);
      const reader = r.body.getReader();
      let got = 0, last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((ok) => out.once('drain', ok));
        if (Date.now() - last > 300 && win && !win.isDestroyed()) { last = Date.now(); win.webContents.send('update-progress', total ? got / total : 0); }
      }
      await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
      if (total && got < total * 0.98) throw new Error('tải chưa đủ');
      spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => { quitting = true; app.quit(); }, 800);
      return { ok: true };
    } catch (e) {
      updBusy = false;
      return { ok: false, err: String(e.message || e) };
    }
  });
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('hotkeys-get', () => ({ keys: keys(), state: registerKeys() }));
  ipcMain.handle('hotkeys-set', (e, k) => { cfg.hotkeys = Object.assign({}, cfg.hotkeys || {}, k || {}); saveCfg(); const st = registerKeys(); buildTrayMenu(); return { keys: keys(), state: st }; });
  ipcMain.handle('hotkeys-pause', (e, on) => { if (on) globalShortcut.unregisterAll(); else registerKeys(); return true; });
  ipcMain.handle('sony-rp', () => ({ path: sonyRp() }));
  ipcMain.handle('sony-rp-open', async () => { const f = sonyRp(); if (!f) return { ok: false }; const err = await shell.openPath(f); return { ok: !err, err }; });
  ipcMain.handle('open-url', (e, u) => { if (/^https:\/\//.test(String(u))) shell.openExternal(String(u)); return true; });
  ipcMain.handle('overlay-reset', () => { overlayCmd('reset'); return true; });
  ipcMain.handle('overlay-size', (e, pct, h) => {
    if (!overlay) return false;
    const b = overlay.getBounds(), d = screen.getDisplayMatching(b).workArea;
    const w = Math.round(d.width * Math.max(0.3, Math.min(1, pct / 100))), hh = Math.max(120, Math.min(420, h || b.height));
    const cx = b.x + b.width / 2, nx = Math.round(Math.max(d.x, Math.min(d.x + d.width - w, cx - w / 2)));
    const ny = Math.round(Math.min(b.y, d.y + d.height - hh));
    overlay.setBounds({ x: nx, y: ny, width: w, height: hh }); cfg.overlay = overlay.getBounds(); cfg.overlayPct = pct; saveCfg(); return true;
  });
  ipcMain.handle('get-json', async (e, u) => {
    const url = new URL(String(u));
    if (url.hostname !== 'translate.googleapis.com') throw new Error('blocked');
    const r = await net.fetch(url.toString());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

/* ---------- self test (used by the GitHub build on a Windows machine) ---------- */
async function runSelftest() {
  const out = process.env.HS_SELFTEST_OUT || path.join(os.tmpdir(), 'hongsub-selftest');
  fs.mkdirSync(out, { recursive: true });
  const log = (...a) => { fs.appendFileSync(path.join(out, 'log.txt'), a.join(' ') + '\n'); };
  log('version', app.getVersion());
  fakeGame = new BrowserWindow({ x: 0, y: 0, width: 960, height: 540, title: 'PS Remote Play', show: true, backgroundColor: '#000', webPreferences: { backgroundThrottling: false } });
  fakeGame.loadURL('app://hongsub/assets/selftest-game.html');
  await new Promise(r => setTimeout(r, 2500));
  createMain();
  win.webContents.on('console-message', (e) => log('console', e.level, e.message));
  await new Promise(r => win.webContents.once('did-finish-load', r));
  // preset the subtitle area to where the fake game draws its lines
  await win.webContents.executeJavaScript("localStorage.setItem('hongsub.v1.region',JSON.stringify({x:.05,y:.78,w:.9,h:.16}));localStorage.setItem('hongsub.v1.regionSet','true');location.reload();");
  await new Promise(r => win.webContents.once('did-finish-load', r));
  const state = () => win.webContents.executeJavaScript('window.hsTestState?JSON.stringify(window.hsTestState()):"null"').then(JSON.parse).catch(e => ({ err: String(e) }));
  await new Promise(r => setTimeout(r, 25000));
  const s1 = await state(); log('state-visible', JSON.stringify(s1));
  win.minimize();
  await new Promise(r => setTimeout(r, 15000));
  const s2 = await state(); log('state-minimized', JSON.stringify(s2));
  win.restore();
  const shot = async (name) => {
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: screen.getPrimaryDisplay().size });
    if (srcs[0]) {
      fs.writeFileSync(path.join(out, name), srcs[0].thumbnail.toPNG());
    }
  };
  await shot('screen.png');
  const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, 'main.png'), img.toPNG());
  const oimg = await overlay.webContents.capturePage(); fs.writeFileSync(path.join(out, 'overlay.png'), oimg.toPNG());
  const v = await ttsCall({ cmd: 'voices' }, 30000); log('voices', JSON.stringify(v));
  const pv = Date.now(); const pw = await piperSpeak('Xin chào, đây là giọng đọc phụ đề của Hóng Sub.', 1.1);
  log('piper', pw.err ? 'ERR ' + pw.err : 'wav bytes ' + Math.round((pw.wav || '').length * 0.75) + ' in ' + (Date.now() - pv) + 'ms');
  const pv2 = Date.now(); const pw2 = await piperSpeak('Chúng ta phải rời khỏi đây trước khi trời sáng.', 1.1);
  log('piper2', pw2.err ? 'ERR ' + pw2.err : 'wav bytes ' + Math.round((pw2.wav || '').length * 0.75) + ' in ' + (Date.now() - pv2) + 'ms');
  if (pw.wav) fs.writeFileSync(path.join(out, 'voice-vi.wav'), Buffer.from(pw.wav, 'base64'));
  const rl = { helper: rpHelper() };
  try {
    const ver = await new Promise((res) => { const p = spawn(rpHelper(), ['version'], { windowsHide: true }); let o = ''; p.stdout.on('data', d => { o += d; }); p.on('exit', c => res('exit=' + c + ' ' + o.trim())); p.on('error', e => res('error ' + e)); });
    log('rp version', ver); rl.version = ver;
  } catch (e) { log('rp version failed', String(e)); }
  try {
    const st = await new Promise((res) => {
      const p = spawn(rpHelper(), ['stream', '127.0.0.1', '1', Buffer.alloc(16).toString('base64'), Buffer.alloc(16).toString('base64'), '720', '30'], { windowsHide: true });
      let bufx = Buffer.alloc(0); const evs = [];
      p.stdout.on('data', d => { bufx = Buffer.concat([bufx, d]); while (bufx.length >= 5) { const len = bufx.readUInt32LE(1); if (bufx.length < 5 + len) break; if (bufx[0] === 9) evs.push(bufx.subarray(5, 5 + len).toString('utf8').slice(0, 200)); bufx = bufx.subarray(5 + len); } });
      const t = setTimeout(() => { try { p.stdin.write('q\n'); } catch (e) { /* ignore */ } }, 12000);
      p.on('exit', c => { clearTimeout(t); res({ code: c, events: evs.slice(-6) }); });
      p.on('error', e => res({ error: String(e) }));
    });
    log('rp stream test', JSON.stringify(st)); rl.stream = st;
  } catch (e) { log('rp stream failed', String(e)); }
  try { const d = await ps.discover(); log('discover', JSON.stringify(d)); } catch (e) { log('discover failed', String(e)); }
  try {
    const pt = await win.webContents.executeJavaScript('window.hsPsTest ? window.hsPsTest().then(JSON.stringify) : "null"');
    log('picture test', pt); rl.picture = JSON.parse(pt);
    await new Promise(r => setTimeout(r, 500));
    const img2 = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, 'main-ps.png'), img2.toPNG());
  } catch (e) { log('picture test failed', String(e)); }
  try {
    const rt = await win.webContents.executeJavaScript(`(async function(){ var o={}; var body=JSON.stringify({room:'CITEST',vi:'selftest',kind:'notice'});
      try{ var r=await fetch('https://honggame.store/wp-json/hgs-sub/v1/push',{method:'POST',headers:{'Content-Type':'application/json'},body:body}); o.page=r.status; }catch(e){ o.page='ERR '+e.message; }
      try{ var m=await window.hsDesktop.tv.relay({room:'CITEST',vi:'selftest main',kind:'notice'}); o.main=m.status||m.err; }catch(e){ o.main='ERR '+e.message; }
      return JSON.stringify(o); })()`);
    log('relay test', rt);
  } catch (e) { log('relay test failed', String(e)); }
  if (process.env.HS_TEST_AIV === '1') {
    try {
      const t0 = Date.now(); const st = await aivInstall(); log('aiv install', JSON.stringify({ installed: st.installed, err: st.err, ms: Date.now() - t0, mb: Math.round(st.total / 1048576) }));
      const t1 = Date.now(); while (!aiv.ready && !aiv.err && Date.now() - t1 < 120000) await new Promise(r => setTimeout(r, 500));
      log('aiv ready', aiv.ready, 'voices', aiv.voices.length, 'start ms', aiv.startMs, aiv.err || '');
      if (aiv.ready) {
        for (const [i, v] of [['Trúc Ly'], ['Hải Đăng'], ['Quang Sơn']].entries()) {
          const t2 = Date.now(); let first = 0, sec = 0, got = 0;
          await new Promise((res) => {
            const to = setTimeout(res, 30000);
            aiv.tap = (m) => { if (m.id !== 900 + i) return; if (m.type === 'error') { log('aiv error', m.err); clearTimeout(to); res(); return; } if (!first) first = Date.now() - t2; sec += m.sec || 0; got++; if (m.i === 0 && i === 0) fs.writeFileSync(path.join(out, 'voice-ai.wav'), Buffer.from(m.wav, 'base64')); if (m.last) { clearTimeout(to); res(); } };
            aiv.proc.stdin.write(JSON.stringify({ cmd: 'speak', id: 900 + i, text: 'Chúng ta phải rời khỏi đây trước khi trời sáng. Bám sát vào nhé!', voice: v[0] }) + '\n');
          });
          aiv.tap = null; log('aiv speak', v[0], 'first audio ms', first, 'speech sec', sec.toFixed(2), 'parts', got, 'total ms', Date.now() - t2);
        }
        const r = await win.webContents.executeJavaScript("(function(){var A=window.hsApi; return JSON.stringify({ai:A.aiv.ready,n:A.aiv.list.length,narr:A.narrator(),opts:document.getElementById('hsVoice').options.length});})()");
        log('aiv in page', r);
      }
    } catch (e) { log('aiv test failed', String(e && e.stack || e)); }
  }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ visible: s1, minimized: s2, voices: v.voices || v.err, speakOk: typeof sp !== 'undefined' && !!(sp && sp.wav && sp.wav.length > 1000), piperOk: typeof pw !== 'undefined' && !!(pw && pw.wav && pw.wav.length > 1000), remotePlay: rl }, null, 2));
  quitting = true; app.quit();
}

/* ---------- start ---------- */
app.whenReady().then(async () => {
  loadCfg();
  if (SELFTEST) cfg = {};
  serveFiles();
  setupCapture();
  setupIpc();
  ps = psModule.setup({ userData: app.getPath('userData'), helperPath: rpHelper, getWin: () => win, log: (m) => { if (SELFTEST) { try { fs.appendFileSync(path.join(process.env.HS_SELFTEST_OUT || os.tmpdir(), 'log.txt'), m + '\n'); } catch (e) { /* ignore */ } } } });
  createOverlay();
  if (!SELFTEST) { setTimeout(updateTick, 15000); setInterval(updateTick, 30 * 60 * 1000); }
  if (!SELFTEST) { createTray(); createMain(); if (cfg.aivOn !== false && aivPy()) setTimeout(aivStart, 2500); }
  registerKeys();
  ttsStart();
  setTimeout(() => piperStart(1.1), 3000);
  if (SELFTEST) runSelftest().catch(e => { try { fs.appendFileSync(path.join(process.env.HS_SELFTEST_OUT || os.tmpdir(), 'log.txt'), 'FATAL ' + e.stack + '\n'); } catch (x) { /* ignore */ } app.exit(1); });
});
app.on('second-instance', showMain);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (ps) ps.stop(); aivStop(); for (const p of [tts, piper]) { if (p) { try { p.kill(); } catch (e) { /* ignore */ } } } });
app.on('window-all-closed', () => { if (quitting || SELFTEST) app.quit(); });
