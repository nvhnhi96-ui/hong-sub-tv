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

const SELFTEST = process.argv.includes('--selftest') || process.env.HS_SELFTEST === '1';
const ROOT = __dirname;
const UPDATE_API = 'https://api.github.com/repos/nvhnhi96-ui/hong-sub-tv/releases/latest';

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

if (!SELFTEST && !app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('store.honggame.hongsub.pc');

let win = null, overlay = null, tray = null, fakeGame = null;
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
    return net.fetch(pathToFileURL(file).toString());
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
function sendOverlayState() {
  const st = { hidden: !!cfg.overlayHidden, move: moveMode };
  if (win && !win.isDestroyed()) win.webContents.send('overlay-state', st);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay-state', st);
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
  } else {
    overlay.setIgnoreMouseEvents(true); overlay.setFocusable(false);
    cfg.overlay = overlay.getBounds(); saveCfg();
    if (!cfg.overlayHidden) overlay.showInactive();
  }
}

/* ---------- tray ---------- */
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở Hóng Sub', click: showMain },
    { label: 'Bật/tắt dịch (F7)', click: () => hotkey('toggle') },
    { label: cfg.overlayHidden ? 'Hiện phụ đề nổi (F9)' : 'Ẩn phụ đề nổi (F9)', click: () => overlayCmd('toggle') },
    { label: moveMode ? 'Xong di chuyển phụ đề (F10)' : 'Di chuyển phụ đề (F10)', click: () => overlayCmd('move') },
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
function registerKeys() {
  const map = { F7: () => hotkey('toggle'), F8: () => hotkey('now'), F9: () => overlayCmd('toggle'), F10: () => overlayCmd('move'), F11: () => hotkey('full') };
  for (const k of Object.keys(map)) { try { globalShortcut.register(k, map[k]); } catch (e) { /* key taken by another app */ } }
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

/* ---------- IPC ---------- */
function setupIpc() {
  ipcMain.handle('sources', async () => (await listSources(true)).map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() })));
  ipcMain.handle('windows', async () => (await listSources(false)).map(s => ({ id: s.id, name: s.name })));
  ipcMain.handle('rp-info', () => ({ bundled: !!rpExe(), running: !!(rpProc && rpProc.exitCode === null) }));
  ipcMain.handle('rp-launch', (e, opengl) => rpLaunch(!!opengl));
  ipcMain.handle('use', (e, id) => { chosenId = id; return true; });
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
  ipcMain.handle('update', async () => {
    try {
      const r = await net.fetch(UPDATE_API, { headers: { 'User-Agent': 'HongSub' } });
      if (!r.ok) return null;
      const j = await r.json();
      const latest = String(j.tag_name || '').replace(/^v/, '');
      const cur = app.getVersion();
      const n = (v) => v.split('.').map(x => parseInt(x, 10) || 0);
      const a = n(latest), c = n(cur);
      let newer = false;
      for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (c[i] || 0)) { newer = (a[i] || 0) > (c[i] || 0); break; } }
      const hasPc = (j.assets || []).some(x => x.name === 'hong-sub-pc.exe');
      return { version: latest, newer: newer && hasPc };
    } catch (e) { return null; }
  });
  ipcMain.handle('app-version', () => app.getVersion());
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
  const rl = { ok: !!rpExe() }; log('remoteplay exe', rpExe() || 'none');
  const tries = [['default', [], {}], ['opengl', ['--opengl'], {}], ['software', [], { QT_QUICK_BACKEND: 'software' }]];
  for (const [label, args, env] of tries) {
    const exe = rpExe(); if (!exe) break;
    let errTxt = '', code = null;
    const pr = spawn(exe, args, { cwd: path.dirname(exe), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    pr.stdout.on('data', d => { errTxt += d; }); pr.stderr.on('data', d => { errTxt += d; });
    pr.on('exit', c => { code = c; });
    await new Promise(r => setTimeout(r, 10000));
    const ws = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 960, height: 540 } });
    const cw = ws.find(w => /chiaki/i.test(w.name));
    log('rp ' + label + ': exit=' + code + ' window=' + (cw ? cw.name : 'none') + ' out=' + errTxt.slice(-600).replace(/\s+/g, ' '));
    if (cw) { fs.writeFileSync(path.join(out, 'remoteplay-' + label + '.png'), cw.thumbnail.toPNG()); rl[label] = true; }
    try { pr.kill(); } catch (e) { /* ignore */ }
    await new Promise(r => setTimeout(r, 1500));
  }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ visible: s1, minimized: s2, voices: v.voices || v.err, speakOk: !!(sp.wav && sp.wav.length > 1000), piperOk: !!(pw.wav && pw.wav.length > 1000), remotePlay: rl }, null, 2));
  quitting = true; app.quit();
}

/* ---------- start ---------- */
app.whenReady().then(async () => {
  loadCfg();
  if (SELFTEST) cfg = {};
  serveFiles();
  setupCapture();
  setupIpc();
  createOverlay();
  if (!SELFTEST) { createTray(); createMain(); }
  registerKeys();
  ttsStart();
  setTimeout(() => piperStart(1.1), 3000);
  if (SELFTEST) runSelftest().catch(e => { try { fs.appendFileSync(path.join(process.env.HS_SELFTEST_OUT || os.tmpdir(), 'log.txt'), 'FATAL ' + e.stack + '\n'); } catch (x) { /* ignore */ } app.exit(1); });
});
app.on('second-instance', showMain);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); for (const p of [tts, piper]) { if (p) { try { p.kill(); } catch (e) { /* ignore */ } } } });
app.on('window-all-closed', () => { if (quitting || SELFTEST) app.quit(); });
