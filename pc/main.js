'use strict';
// Hóng Sub for Windows: wraps the Hóng Sub page (app/index.html) and adds what a browser tab cannot do:
// picks the PS Remote Play window by itself, shows subtitles in a transparent always-on-top bar over the game,
// global hotkeys, Windows voices, tray icon and keeps running while minimised.
const {
  app, BrowserWindow, protocol, net, session, desktopCapturer, ipcMain, globalShortcut,
  Tray, Menu, screen, shell, nativeImage, Notification, systemPreferences
} = require('electron');
const IS_MAC = process.platform === 'darwin';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const psModule = require('./ps');
const lgModule = require('./lg');
const onlineTts = require('./onlinetts');
const tizenModule = require('./tizen');
const tzRaw = require('./tzraw');
let lgApi = null;   /* the home-network server for the TV apps (lg.js) */

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
  if (!IS_MAC) win.setMenu(null);
  win.loadURL('app://hongsub/app/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) { e.preventDefault(); shell.openExternal(url); } });
  const remember = () => { if (!win.isMinimized() && !win.isMaximized()) { cfg.main = win.getBounds(); saveCfg(); } };
  win.on('resize', remember); win.on('move', remember);
  /* closing the window ends Hóng Sub: no more translating in the background, nothing left on the TV
     (keep it running while playing: minimise the window instead) */
  win.on('close', (e) => {
    if (quitting || SELFTEST) return;
    e.preventDefault(); bye();
  });
}
/* Hóng Sub is ending: the page stops translating, stops reading aloud and takes its lines and area boxes off the TV,
   then the app quits (at most 3 s, even if the TV does not answer) */
let byeState = 0;
function bye() {
  if (byeState) return; byeState = 1;
  const fin = () => { if (byeState === 2) return; byeState = 2; quitting = true; app.quit(); };
  try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
  for (const w of BrowserWindow.getAllWindows()) { if (w !== win && !w.isDestroyed()) { try { w.hide(); } catch (e) { /* ignore */ } } }
  if (win && !win.isDestroyed()) { try { win.hide(); } catch (e) { /* ignore */ } }
  if (!win || win.isDestroyed()) return fin();
  ipcMain.once('bye-done', fin);
  try { win.webContents.send('bye'); } catch (e) { return fin(); }
  setTimeout(fin, 3000);
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
/* "Phụ đề nổi trên game" (the subtitle window over other apps) has been taken out: the window is still made for the
   areas' move mode, but the subtitle in it is never shown. Subtitles show in Hóng Sub and on the TV. */
const SUB_FLOAT = false;
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
  overlay.once('ready-to-show', () => { if (SUB_FLOAT && !cfg.overlayHidden) overlay.showInactive(); sendOverlayState(); });
  overlay.on('moved', () => { cfg.overlay = overlay.getBounds(); saveCfg(); });
}
/* ---------- one floating window per extra area ("Vùng 1", "Vùng 2"...) ----------
   By default each window sits where that area is on the main screen, so the Vietnamese covers the English
   (right when the game runs full screen). Moved or resized windows keep their place. */
const zoneWins = new Map();          // id -> { win, data, key }
/* the picture Hóng Sub reads: the PS Remote Play window (followed as it moves) or a whole screen */
let capturedId = '', capRect = null, rectProc = null, rectBuf = '', rectBusy = false, rectTimer = null;
function capBase() {
  if (capRect) return capRect;
  const m = /^screen:(\d+)/.exec(capturedId || '');
  const ds = screen.getAllDisplays();
  const dp = (m && ds.find(x => String(x.id) === m[1])) || screen.getPrimaryDisplay();
  return dp.bounds;
}
function rectStart() {
  if (process.platform !== 'win32' || rectProc) return;
  try { rectProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'winrect.ps1')], { windowsHide: true }); }
  catch (e) { rectProc = null; return; }
  rectProc.stdout.setEncoding('utf8');
  rectProc.stdout.on('data', (s) => {
    rectBuf += s; let i;
    while ((i = rectBuf.indexOf('\n')) >= 0) { const line = rectBuf.slice(0, i).trim(); rectBuf = rectBuf.slice(i + 1); rectBusy = false; rectGot(line); }
  });
  rectProc.on('exit', () => { rectProc = null; rectBusy = false; });
  rectProc.on('error', () => { rectProc = null; rectBusy = false; });
}
function rectGot(line) {
  const p = line.split(',').map(Number);
  if (p.length < 5 || p.some(isNaN) || p[2] < 50 || p[3] < 50 || p[4]) return;   // closed or minimized: keep the last place
  let r = { x: p[0], y: p[1], width: p[2], height: p[3] };
  try { r = screen.screenToDipRect(null, r); } catch (e) { /* not Windows */ }
  if (capRect && Math.abs(capRect.x - r.x) < 3 && Math.abs(capRect.y - r.y) < 3 && Math.abs(capRect.width - r.width) < 3 && Math.abs(capRect.height - r.height) < 3) return;
  capRect = r; zonesFollow();
}
function rectAsk() {
  const m = /^window:(\d+)/.exec(capturedId || '');
  if (!m) { if (capRect) { capRect = null; zonesFollow(); } return; }
  if (!zoneWins.size) return;
  rectStart(); if (!rectProc || rectBusy) return;
  rectBusy = true; try { rectProc.stdin.write(m[1] + '\n'); } catch (e) { rectBusy = false; }
}
/* "Đè chữ Việt lên phụ đề gốc": the subtitle bar sits exactly over the game's own subtitle area */
let subPlace = null;
let subSize = 28;   /* "Cỡ chữ" on the computer: bigger letters over the original subtitle need a bigger window */
function applyPlace() {
  if (!overlay || overlay.isDestroyed() || moveMode) return;
  if (subPlace) {
    const b = capBase();
    /* as wide as "Độ rộng khung phụ đề" says (share of the game picture), centred on the original subtitle */
    const pct = Math.max(20, Math.min(100, +cfg.overlayPct || 80)) / 100, hs = Math.max(40, Math.min(300, +cfg.overlayHgt || 100)) / 100;
    let bw = Math.max(120, Math.round(pct * b.width)), cx = b.x + (subPlace.x + subPlace.w / 2) * b.width;
    /* "Đè đúng chỗ từng dòng": right over the original text, a little wider for the longer Vietnamese (no wider than the width setting) */
    if (subPlace.spot) bw = Math.max(60, Math.min(bw, Math.round(subPlace.w * b.width * 1.25)));
    /* "Độ cao khung nền": taller or flatter than the original line, centred on it */
    const sk = Math.max(1, Math.min(2.5, subSize / 28));
    if (subPlace.spot && sk > 1) bw = Math.max(60, Math.min(Math.round(pct * b.width), Math.round(subPlace.w * b.width * 1.25 * sk)));
    const bh = Math.max(30, Math.round(subPlace.h * b.height * hs * sk)), cy = b.y + (subPlace.y + subPlace.h / 2) * b.height;
    let left = cx - bw / 2;
    if (subPlace.spot && subPlace.al === 'l') left = b.x + subPlace.x * b.width;
    if (subPlace.spot && subPlace.al === 'r') left = b.x + (subPlace.x + subPlace.w) * b.width - bw;
    overlay.setBounds({ x: Math.round(Math.max(b.x, Math.min(b.x + b.width - bw, left))), y: Math.round(cy - bh / 2),
      width: bw, height: bh });
    overlay.webContents.send('sub', { cover: true, spot: !!subPlace.spot, al: subPlace.al, fs: subPlace.spot ? Math.max(9, Math.round(subPlace.lh * b.height * 0.82)) : 0 });
  } else {
    overlay.setBounds(overlayBounds());
    overlay.webContents.send('sub', { cover: false });
  }
}
/* windows the user did not place by hand follow the game window */
function zonesFollow() {
  applyPlace();
  for (const z of zoneWins.values()) {
    if (z.win.isDestroyed() || (cfg.zoneWins || {})[z.data.id]) continue;
    z.quiet = true; z.win.setBounds(zoneDefault(z.data)); setTimeout(() => { z.quiet = false; }, 300);
  }
}
/* exactly the area on the game picture, so the Vietnamese covers the original text and stays inside it */
function zoneDefault(d) {
  const b = capBase();
  return { x: Math.round(b.x + d.x * b.width), y: Math.round(b.y + d.y * b.height),
    width: Math.max(40, Math.round(d.w * b.width)), height: Math.max(24, Math.round(d.h * b.height)) };
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
  const b = capBase(); fullWin.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });   /* the game picture: a whole screen or the PS Remote Play window */
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
    const want = IS_MAC ? 'hong-sub-mac-' + (process.arch === 'arm64' ? 'apple' : 'intel') + '.dmg' : 'hong-sub-pc.exe';
    const asset = (j.assets || []).find(x => x.name === want);
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
    if (!SUB_FLOAT) { sendOverlayState(); return; }
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
    overlay.setIgnoreMouseEvents(false); overlay.setFocusable(true); if (SUB_FLOAT) overlay.show();
    for (const z of zoneWins.values()) if (!z.win.isDestroyed()) { z.win.setIgnoreMouseEvents(false); z.win.setFocusable(true); }
  } else {
    overlay.setIgnoreMouseEvents(true); overlay.setFocusable(false);
    for (const z of zoneWins.values()) if (!z.win.isDestroyed()) { z.win.setIgnoreMouseEvents(true); z.win.setFocusable(false); }
    if (!subPlace) { cfg.overlay = overlay.getBounds(); saveCfg(); } else applyPlace();   /* over the game's subtitle: its place comes from the subtitle area */
    if (SUB_FLOAT && !cfg.overlayHidden) overlay.showInactive(); else if (!SUB_FLOAT) overlay.hide();
  }
}

/* ---------- tray ---------- */
function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở Hóng Sub', click: showMain },
    { label: 'Bật/tắt dịch (' + keys().toggle + ')', click: () => hotkey('toggle') },
    ...(SUB_FLOAT ? [{ label: cfg.overlayHidden ? 'Hiện phụ đề nổi (' + keys().ovl + ')' : 'Ẩn phụ đề nổi (' + keys().ovl + ')', click: () => overlayCmd('toggle') }] : []),
    { label: moveMode ? 'Xong di chuyển phụ đề (' + keys().move + ')' : 'Di chuyển phụ đề (' + keys().move + ')', click: () => overlayCmd('move') },
    { label: 'Đưa phụ đề về chỗ cũ', click: () => overlayCmd('reset') },
    { type: 'separator' },
    { label: 'Thoát Hóng Sub', click: bye }
  ]));
}
function createTray() {
  let ti = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png'));
  if (IS_MAC) ti = ti.resize({ width: 18, height: 18 });   /* menu bar size */
  tray = new Tray(ti);
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
/* Mac: Sony's installer names the bundle RemotePlay.app (shown as "PS Remote Play"); look under both names, any app
   folder with "Remote Play" in it, and finally ask Spotlight for Sony's bundle id */
let macRpCache = { at: 0, f: '' };
function sonyRpMac() {
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications'), '/Applications/PlayStation'];
  for (const d of dirs) for (const n of ['RemotePlay.app', 'PS Remote Play.app', 'PS RemotePlay.app']) { const f = path.join(d, n); if (fs.existsSync(f)) return f; }
  for (const d of dirs) {
    let list = []; try { list = fs.readdirSync(d); } catch (e) { continue; }
    const n = list.find((x) => /\.app$/i.test(x) && /remote\s*play/i.test(x) && !/h[oó]ng/i.test(x));
    if (n) return path.join(d, n);
  }
  if (Date.now() - macRpCache.at < 60000) return macRpCache.f;
  let f = '';
  try {
    const out = require('child_process').execFileSync('/usr/bin/mdfind', ["kMDItemCFBundleIdentifier == 'com.playstation.RemotePlay'"], { timeout: 4000, encoding: 'utf8' });
    f = String(out || '').split('\n').map((x) => x.trim()).find((x) => /\.app$/i.test(x) && fs.existsSync(x)) || '';
  } catch (e) { /* ignore */ }
  macRpCache = { at: Date.now(), f };
  return f;
}
function sonyRp() {
  if (IS_MAC) return sonyRpMac();
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
  /* the PS5 controller (DualSense) plugged into this computer: Hóng Sub reads its mic button to translate the areas
     ("Khi bấm nút mic"). Only Sony controllers, nothing else on USB/Bluetooth. */
  try {
    const sony = (d) => d && (d.vendorId === 0x054c || d.vendorId === 1356);
    session.defaultSession.setDevicePermissionHandler((det) => det.deviceType === 'hid' && sony(det.device));
    const prevCheck = null;
    session.defaultSession.setPermissionCheckHandler((wc, perm, origin, det) => perm === 'hid' ? true : (prevCheck ? prevCheck(wc, perm, origin, det) : true));
    session.defaultSession.on('select-hid-device', (e, det, cb) => { e.preventDefault(); const d = (det.deviceList || []).find(sony); cb(d ? d.deviceId : ''); });
  } catch (e) { }
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    try {
      const srcs = await listSources(false);
      const s = srcs.find(x => x.id === chosenId) || srcs.find(x => /remote play/i.test(x.name)) || srcs.find(x => x.id.startsWith('screen'));
      if (s && s.id !== capturedId) { capturedId = s.id; capRect = null; rectBusy = false; rectAsk(); zonesFollow(); }
      if (!rectTimer) rectTimer = setInterval(rectAsk, 1500);
      /* the game's sound too when the page asks for it ("Dịch lời nhân vật nói"): Windows plays it back to us (loopback) */
      cb(s ? (req.audioRequested && process.platform === 'win32' ? { video: s, audio: 'loopback' } : { video: s }) : {});
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
/* Mac: the system's own voices through the "say" command (Vietnamese: Linh) */
function macTts(msg, timeout) {
  return new Promise((done) => {
    if (msg.cmd === 'voices') {
      let out = '';
      const p = spawn('say', ['-v', '?']);
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => done({ voices: [] }));
      p.on('close', () => {
        const voices = out.split('\n').map((l) => /^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2})\s/.exec(l)).filter(Boolean)
          .filter((m) => /^vi/i.test(m[2])).map((m) => ({ name: m[1].trim(), lang: m[2].replace('_', '-') }));
        done({ voices });
      });
      return;
    }
    if (msg.cmd === 'speak') {
      const txt = path.join(os.tmpdir(), 'hs-say-' + process.pid + '-' + msg.id + '.txt'), wav = txt.replace(/\.txt$/, '.wav');
      try { fs.writeFileSync(txt, Buffer.from(String(msg.text || ''), 'base64').toString('utf8')); } catch (e) { done({ err: 'file' }); return; }
      const args = ['-f', txt, '-o', wav, '--data-format=LEI16@22050', '-r', String(Math.round(175 * (+msg.rate || 1)))];
      if (msg.voice) args.unshift('-v', msg.voice); else args.unshift('-v', 'Linh');
      const p = spawn('say', args);
      const t = setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } }, timeout || 20000);
      p.on('error', () => { clearTimeout(t); done({ err: 'say' }); });
      p.on('close', () => {
        clearTimeout(t);
        let b = null; try { b = fs.readFileSync(wav); } catch (e) { /* none */ }
        try { fs.unlinkSync(txt); fs.unlinkSync(wav); } catch (e) { /* ignore */ }
        done(b && b.length > 200 ? { wav: b.toString('base64') } : { err: 'no voice' });
      });
      return;
    }
    done({ err: 'cmd' });
  });
}
function ttsCall(msg, timeout) {
  if (IS_MAC) { msg.id = ++ttsSeq; return macTts(msg, timeout); }
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

/* ---------- Azure voice (Microsoft Azure AI Speech): natural Vietnamese voices, answer in a fraction of a second.
   The key and region the player pasted stay on this computer (hongsub-window.json). ---------- */
const AZ_VOICES = [{ id: 'az:vi-VN-HoaiMyNeural', name: 'Azure Hoài My (nữ)', g: 'female' }, { id: 'az:vi-VN-NamMinhNeural', name: 'Azure Nam Minh (nam)', g: 'male' }];
const azOn = () => !!(cfg.az && cfg.az.key && cfg.az.region);
const xmlEsc = (t) => String(t).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
async function azSpeak(text, voice, rate) {
  if (!azOn()) throw new Error('no key');
  const name = String(voice || '').replace(/^az:/, '') || 'vi-VN-HoaiMyNeural';
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try {
    const pr = rate && Math.abs(rate - 1) > 0.02 ? Math.round((Math.min(2.5, Math.max(0.5, rate)) - 1) * 100) : 0;   /* Azure speaks faster itself: clearer than playing the sound faster */
    const r = await net.fetch('https://' + cfg.az.region + '.tts.speech.microsoft.com/cognitiveservices/v1', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Ocp-Apim-Subscription-Key': cfg.az.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'HongSub' },
      body: "<speak version='1.0' xml:lang='vi-VN'><voice name='" + name + "'>" + (pr ? "<prosody rate='" + (pr > 0 ? '+' : '') + pr + "%'>" : '') + xmlEsc(String(text).replace(/[\r\n]+/g, ' ').slice(0, 1500)) + (pr ? '</prosody>' : '') + '</voice></speak>'
    });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200) throw new Error('empty');
    return buf;
  } finally { clearTimeout(t); }
}

/* ---------- AI voices (VieNeu-TTS v3 Turbo pack, downloaded once) ---------- */
const AIV_URL = 'https://github.com/nvhnhi96-ui/hong-sub-tv/releases/download/voices-1/hong-sub-voices.zip';
const aivClips = new Map();
const aivWait = new Map();   /* answers to clone / unclone */
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
  /* the voice pack was downloaded once; the server script that comes with this version of the app replaces its copy */
  try { const src = path.join(resDir('voices'), 'hs_voice.py'), dst = path.join(aivDir(), 'hs_voice.py');
    if (fs.existsSync(src) && !fs.readFileSync(src).equals(fs.readFileSync(dst))) fs.copyFileSync(src, dst); } catch (e) { /* keep the pack's own copy */ }
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
      else if ((m.type === 'audio' || m.type === 'error') && aivClips.has(m.id)) aivClips.get(m.id)(m);   /* a clip for the TV */
      else if (m.type === 'audio' || m.type === 'error') aivSend('aiv-audio', m);
      else if (m.type === 'fatal') { aiv.err = m.err || 'lỗi'; aivNotify(); }
      else if (m.type === 'cloned' || m.type === 'clonefail' || m.type === 'voices') {   /* a cloned voice added or removed */
        if (m.voices) { aiv.voices = m.voices; aivNotify(); }
        const w = aivWait.get(m.id || '_unclone'); if (w) { aivWait.delete(m.id || '_unclone'); w(m); }
      }
    }
  });
  proc.stderr.on('data', () => {});
  proc.on('exit', (code) => { if (aiv.proc === proc) { aiv.proc = null; aiv.ready = false; if (code && !aiv.err) aiv.err = 'Bộ giọng AI dừng (mã ' + code + ')'; aivNotify(); } });
  proc.on('error', (e) => { aiv.err = String(e.message || e); aivNotify(); });
  aivNotify();
  return true;
}
/* one AI voice clip: the AI voice sends a long line in pieces (each a WAV file); join them into one WAV */
let aivClipSeq = 0;
function aivClip(text, voice) {
  if (!aiv.proc) aivStart();
  if (!aiv.proc || !aiv.ready) return Promise.resolve(null);
  const id = 'clip' + (++aivClipSeq), parts = [];
  return new Promise((done) => {
    const t = setTimeout(() => { aivClips.delete(id); done(parts.length ? wavJoin(parts) : null); }, 45000);
    aivClips.set(id, (m) => {
      if (m.type === 'error') { clearTimeout(t); aivClips.delete(id); done(parts.length ? wavJoin(parts) : null); return; }
      parts.push(Buffer.from(m.wav, 'base64'));
      if (m.last) { clearTimeout(t); aivClips.delete(id); done(wavJoin(parts)); }
    });
    try { aiv.proc.stdin.write(JSON.stringify({ cmd: 'speak', id, text, voice: voice || '' }) + '\n'); } catch (x) { clearTimeout(t); aivClips.delete(id); done(null); }
  });
}
function wavJoin(bufs) {
  const pcm = []; let fmt = null;
  for (const b of bufs) {
    let o = 12;
    while (o + 8 <= b.length) {
      const id = b.toString('ascii', o, o + 4), n = b.readUInt32LE(o + 4);
      if (id === 'fmt ' && !fmt) fmt = b.subarray(o + 8, o + 8 + n);
      if (id === 'data') { pcm.push(b.subarray(o + 8, Math.min(b.length, o + 8 + n))); break; }
      o += 8 + n + (n & 1);
    }
  }
  if (!fmt || !pcm.length) return bufs[0] || null;
  const data = Buffer.concat(pcm), head = Buffer.alloc(20);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(4 + 8 + fmt.length + 8 + data.length, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(fmt.length, 16);
  const dh = Buffer.alloc(8); dh.write('data', 0, 'ascii'); dh.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, dh, data]);
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
  /* a cloned voice: a short clip the person recorded or picked (WAV made by the page), enrolled by the voice engine */
  ipcMain.handle('aiv-clone', async (e, o) => {
    o = o || {};
    const name = String(o.name || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').trim().slice(0, 32);
    const wav = Buffer.from(String(o.wav || ''), 'base64');
    if (!name) return { ok: false, err: 'Đặt tên cho giọng.' };
    if (wav.length < 44 + 24000 * 2 * 2 || wav.toString('ascii', 0, 4) !== 'RIFF') return { ok: false, err: 'Đoạn ghi âm quá ngắn (cần ít nhất 3 giây).' };
    if (!aiv.proc) aivStart();
    if (!aiv.proc) return { ok: false, err: 'Chưa có bộ giọng AI. Tải bộ giọng AI trước.' };
    for (let i = 0; i < 120 && !aiv.ready && aiv.proc; i++) await new Promise((r) => setTimeout(r, 500));
    if (!aiv.ready) return { ok: false, err: 'Bộ giọng AI chưa mở xong. Thử lại sau ít giây.' };
    const dir = path.join(aivDir(), 'clones'); fs.mkdirSync(dir, { recursive: true });
    const id = 'c' + Date.now().toString(36), file = path.join(dir, id + '.wav');
    fs.writeFileSync(file, wav);
    const r = await new Promise((done) => {
      const t = setTimeout(() => { aivWait.delete(id); done({ type: 'clonefail', err: 'timeout' }); }, 240000);
      aivWait.set(id, (m) => { clearTimeout(t); done(m); });
      try { aiv.proc.stdin.write(JSON.stringify({ cmd: 'clone', id, name, path: file, gender: o.gender === 'male' ? 'male' : 'female' }) + '\n'); } catch (x) { clearTimeout(t); aivWait.delete(id); done({ type: 'clonefail', err: String(x.message || x) }); }
    });
    if (r.type !== 'cloned') { try { fs.unlinkSync(file); } catch (x) { /* ignore */ } return { ok: false, err: r.err || 'lỗi' }; }
    return { ok: true, name, ms: r.ms };
  });
  ipcMain.handle('aiv-unclone', (e, name) => new Promise((done) => {
    if (!aiv.proc) { done(false); return; }
    const t = setTimeout(() => { aivWait.delete('_unclone'); done(false); }, 20000);
    aivWait.set('_unclone', () => { clearTimeout(t); done(true); });
    try { aiv.proc.stdin.write(JSON.stringify({ cmd: 'unclone', name: String(name || '') }) + '\n'); } catch (x) { clearTimeout(t); done(false); }
  }));
  ipcMain.handle('aiv-remove', () => { aivStop(); setTimeout(() => { try { fs.rmSync(aivDir(), { recursive: true, force: true }); } catch (e) { /* ignore */ } aivNotify(); }, 1800); return true; });
  ipcMain.on('aiv-speak', (e, m) => { if (!aiv.proc) aivStart(); if (aiv.proc) { try { aiv.proc.stdin.write(JSON.stringify({ cmd: 'speak', id: m.id, text: String(m.text || '').replace(/[\r\n]+/g, ' '), voice: m.voice || '' }) + '\n'); } catch (x) { /* ignore */ } } });
  ipcMain.on('aiv-drop', (e, id) => { if (aiv.proc) { try { aiv.proc.stdin.write(JSON.stringify({ cmd: 'drop', id }) + '\n'); } catch (x) { /* ignore */ } } });
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
    z.win.setSize(Math.max(40, Math.round(w)), Math.max(24, Math.round(h)));
    cfg.zoneWins = cfg.zoneWins || {}; cfg.zoneWins[id] = z.win.getBounds(); saveCfg();
  });
  ipcMain.handle('zones-panel', (e, on) => { cfg.zonesHidden = !on; saveCfg(); zonesVisible(); return true; });
  ipcMain.on('sub', (e, payload) => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send('sub', payload);
    if (payload && +payload.size >= 8 && +payload.size !== subSize) { subSize = +payload.size; if (subPlace) applyPlace(); }   /* Cỡ chữ changed: resize the box over the original */
  });
  ipcMain.on('overlay', (e, cmd) => overlayCmd(cmd));
  ipcMain.on('sub-place', (e, r) => {
    const ok = r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && v >= 0 && v <= 1.01) && r.w > 0.02 && r.h > 0.02;
    subPlace = ok ? { x: r.x, y: r.y, w: r.w, h: r.h, spot: !!r.spot, al: /^[lcr]$/.test(r.al || '') ? r.al : 'c', lh: +r.lh || 0 } : null; applyPlace();
  });
  ipcMain.handle('voices', async () => {
    const list = [];
    const pp = piperPaths(); if (pp.exe && pp.model) list.push({ name: VOICE_NAME, lang: 'vi-VN', id: 'hs:piper' });
    const r = await ttsCall({ cmd: 'voices' }, 20000);
    (r.voices || []).forEach(v => list.push({ name: v.name, lang: v.lang, id: 'win:' + v.name }));
    /* online voice: no key, no download; used while the computer is online */
    onlineTts.GG_VOICES.forEach(v => list.push({ name: v.name, lang: 'vi-VN', id: v.id, g: v.gender, online: true }));
    if (azOn()) AZ_VOICES.forEach(v => list.push({ name: v.name, lang: 'vi-VN', id: v.id, g: v.g, online: true }));
    return list;
  });
  const onlineFails = {}, onlineOff = {};
  ipcMain.handle('speak', async (e, text, voice, rate) => {
    if (!text) return { stop: true };
    voice = voice || '';
    if (voice.startsWith('win:')) return ttsCall({ cmd: 'speak', text: b64(text), voice: voice.slice(4), rate: rate || 1 }, 20000);
    if (voice.startsWith('az:') && Date.now() > (onlineOff.az || 0)) {
      try { const mp3 = await azSpeak(text, voice, rate); onlineFails.az = 0; return { wav: mp3.toString('base64'), mime: 'audio/mpeg', rateApply: false }; }
      catch (err) {
        onlineFails.az = (onlineFails.az || 0) + 1;
        if (err.status === 401 || err.status === 403 || onlineFails.az >= 3) { onlineOff.az = Date.now() + 10 * 60 * 1000; onlineFails.az = 0; }   /* wrong key, out of quota or offline: the voice on this computer for 10 minutes */
        console.warn('azure voice: ' + (err && err.message));
      }
    }
    if (voice.startsWith('gg:') && Date.now() > (onlineOff[voice.slice(0, 3)] || 0)) {
      try {
        const mp3 = await onlineTts.gg(text, (u, o) => net.fetch(u, o));
        onlineFails[voice.slice(0, 3)] = 0;
        return { wav: mp3.toString('base64'), mime: 'audio/mpeg', rateApply: true };
      } catch (err) {
        const k = voice.slice(0, 3); onlineFails[k] = (onlineFails[k] || 0) + 1;
        if (onlineFails[k] >= 3) { onlineOff[k] = Date.now() + 10 * 60 * 1000; onlineFails[k] = 0; }   /* keeps failing: skip it for 10 minutes, no waiting on every line */
        console.warn('online voice ' + voice + ': ' + (err && err.message));   /* offline or refused: read it with the voice on this computer */
      }
    }
    const r = await piperSpeak(text, rate);
    if (r.wav || voice === 'hs:piper') return r;
    return ttsCall({ cmd: 'speak', text: b64(text), voice: '', rate: rate || 1 }, 20000);
  });
  ipcMain.handle('az-set', (e, key, region) => {
    key = String(key || '').trim(); region = String(region || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key && region) cfg.az = { key, region }; else delete cfg.az;
    saveCfg(); delete onlineOff.az; onlineFails.az = 0; return { ok: true, on: azOn() };
  });
  ipcMain.handle('az-state', () => ({ on: azOn(), region: azOn() ? cfg.az.region : '', key: azOn() ? cfg.az.key.slice(0, 4) + '…' + cfg.az.key.slice(-4) : '' }));
  ipcMain.handle('az-test', async () => {
    const t0 = Date.now();
    try { const b = await azSpeak('Xin chào, đây là giọng Azure của Hóng Sub.', 'az:vi-VN-HoaiMyNeural'); return { ok: true, ms: Date.now() - t0, b64: b.toString('base64'), mime: 'audio/mpeg' }; }
    catch (err) { return { ok: false, status: err.status || 0, err: String(err && err.message || err) }; }
  });
  ipcMain.on('voice-settings', () => shell.openExternal(IS_MAC ? 'x-apple.systempreferences:com.apple.preference.universalaccess?SpokenContent' : 'ms-settings:speech'));
  /* Mac: reading another app's window needs the "Screen Recording" permission */
  ipcMain.handle('mac-screen', () => { try { return systemPreferences.getMediaAccessStatus('screen'); } catch (e) { return 'unknown'; } });
  ipcMain.on('mac-screen-open', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'));
  /* Mac: without a working "Ghi màn hình" permission the Mac hides other apps' windows and their names, so the PS Remote
     Play window is never found. The app is not signed by Apple, so after each update the old permission no longer fits
     (the list shows it on, but it does not work): it is cleared here and the Mac asks again. */
  ipcMain.handle('mac-capture-check', async () => {
    if (!IS_MAC) return { ok: true };
    let st = 'unknown'; try { st = systemPreferences.getMediaAccessStatus('screen'); } catch (e) { /* ignore */ }
    let all = []; try { all = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1, height: 1 } }); } catch (e) { /* ignore */ }
    const others = all.filter(s => s.name && !/^H[oó]ng Sub/.test(s.name));
    return { status: st, windows: all.length, named: others.length, sony: others.some(s => /remote play/i.test(s.name)) };
  });
  ipcMain.handle('mac-screen-fix', async () => {
    if (!IS_MAC) return { ok: false };
    const cp = require('child_process');
    const ids = new Set(['store.honggame.hongsub.pc']);
    try { const plist = path.resolve(process.execPath, '..', '..', 'Info'); const id = cp.execFileSync('/usr/bin/defaults', ['read', plist, 'CFBundleIdentifier'], { timeout: 4000, encoding: 'utf8' }).trim(); if (id) ids.add(id); } catch (e) { /* ignore */ }
    let done = 0;
    for (const id of ids) { try { cp.execFileSync('/usr/bin/tccutil', ['reset', 'ScreenCapture', id], { timeout: 8000 }); done++; } catch (e) { /* ignore */ } }
    try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 64, height: 36 } }); } catch (e) { /* this makes the Mac ask */ }
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return { ok: done > 0, ids: [...ids] };
  });
  ipcMain.on('mac-relaunch', () => { quitting = true; app.relaunch(); app.exit(0); });
  /* the whole line as one sound file, read by a voice of this computer, so the TV can play the same voice.
     Read at normal speed: the speed is applied where it is played. */
  ipcMain.handle('voice-clip', async (e, text, voice) => {
    text = String(text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 600); voice = String(voice || '');
    if (!text) return { ok: false };
    try {
      let buf = null, mime = 'audio/wav';
      if (voice.startsWith('ai:')) buf = await aivClip(text, voice.slice(3));
      else if (voice.startsWith('gg:')) { buf = await onlineTts.gg(text, (u, o) => net.fetch(u, o)); mime = 'audio/mpeg'; }
      else if (voice.startsWith('az:')) { try { buf = await azSpeak(text, voice); mime = 'audio/mpeg'; } catch (x) { buf = null; } }
      else if (voice.startsWith('win:')) { const r = await ttsCall({ cmd: 'speak', text: b64(text), voice: voice.slice(4), rate: 1 }, 20000); if (r.wav) buf = Buffer.from(r.wav, 'base64'); }
      if (!buf) { const r = await piperSpeak(text, 1); if (r.wav) buf = Buffer.from(r.wav, 'base64'); }
      if (!buf) { const r = await ttsCall({ cmd: 'speak', text: b64(text), voice: '', rate: 1 }, 20000); if (r.wav) buf = Buffer.from(r.wav, 'base64'); }
      if (!buf || buf.length < 200) return { ok: false };
      const id = lgApi && lgApi.clipPut ? lgApi.clipPut(buf, mime) : '';
      return { ok: true, id, mime, b64: buf.toString('base64'), bytes: buf.length };
    } catch (err) { return { ok: false, err: String(err && err.message || err) }; }
  });
  /* Android TV: the clip goes to the TV in the message itself (the TV may not reach this computer through Windows Firewall) */
  ipcMain.handle('tv-say', (e, ip, msg) => tvHttp(ip, '/sub', msg));
  /* this computer on the home network: the IP the TVs need, and the port Hóng Sub answers them on */
  ipcMain.handle('net-info', () => {
    const a = lgApi && lgApi.myAddr ? lgApi.myAddr('') : '';
    const all = []; Object.values(os.networkInterfaces()).forEach((l) => (l || []).forEach((x) => { if (x.family === 'IPv4' && !x.internal) all.push(x.address); }));
    return { ip: a ? a.split(':')[0] : (all[0] || ''), port: a ? +a.split(':')[1] : 0, all };
  });
  ipcMain.handle('update', () => checkUpdate());
  /* what changed: the change notes between this version and the newest one (or the latest changes up to this version) */
  ipcMain.handle('update-notes', async (e, from, to) => {
    const ok = (v) => /^\d+\.\d+\.\d+$/.test(String(v || ''));
    const repo = 'https://api.github.com/repos/nvhnhi96-ui/hong-sub-tv';
    const url = ok(from) && ok(to) && from !== to ? repo + '/compare/v' + from + '...v' + to : ok(from) ? repo + '/commits?per_page=8&sha=v' + from : '';
    if (!url) return { ok: false };
    try {
      const r = await net.fetch(url, { headers: { 'User-Agent': 'HongSub', Accept: 'application/vnd.github+json' } });
      if (!r.ok) return { ok: false, status: r.status };
      const j = await r.json();
      const list = (Array.isArray(j) ? j : (j.commits || []).slice().reverse())
        .map(c => String((c.commit && c.commit.message) || '').split('\n')[0].trim())
        .filter(m => m && !/^Merge /.test(m));
      return { ok: true, notes: list.slice(0, 12) };
    } catch (err) { return { ok: false }; }
  });
  /* one click: download the new installer, run it quietly, Hóng Sub closes and opens again on the new version */
  let updBusy = false;
  ipcMain.handle('update-install', async () => {
    if (updBusy) return { ok: false, err: 'busy' };
    const u = await checkUpdate();
    if (!u || !u.newer || !u.url) return { ok: false, err: 'none' };
    updBusy = true;
    try {
      const file = IS_MAC ? path.join(app.getPath('downloads'), 'Hong-Sub-' + u.version + '.dmg') : path.join(os.tmpdir(), 'HongSub-' + u.version + '.exe');
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
      if (IS_MAC) {
        /* Mac: open the new disk image (Finder shows it), the person drags Hóng Sub into Applications to replace the old one */
        await shell.openPath(file);
        setTimeout(() => { quitting = true; app.quit(); }, 2500);
        return { ok: true, mac: true };
      }
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
  ipcMain.handle('sony-rp-open', async () => {
    const f = sonyRp();
    if (f) { const err = await shell.openPath(f); return { ok: !err, err }; }
    /* not found where we looked: let the Mac open it by Sony's bundle id if it is anywhere */
    if (IS_MAC) {
      const ok = await new Promise((res) => { try { require('child_process').execFile('/usr/bin/open', ['-b', 'com.playstation.RemotePlay'], { timeout: 8000 }, (e) => res(!e)); } catch (e) { res(false); } });
      if (ok) return { ok: true };
    }
    return { ok: false, err: 'missing' };
  });
  ipcMain.handle('open-url', (e, u) => { if (/^https:\/\//.test(String(u))) shell.openExternal(String(u)); return true; });
  ipcMain.handle('overlay-reset', () => { overlayCmd('reset'); return true; });
  ipcMain.handle('overlay-size', (e, pct, h, hgt) => {
    if (!overlay) return false;
    if (hgt) cfg.overlayHgt = Math.max(40, Math.min(300, +hgt || 100));
    if (subPlace) { cfg.overlayPct = pct; saveCfg(); applyPlace(); return true; }   /* over the game's subtitle: same width rule there */
    const b = overlay.getBounds(), d = screen.getDisplayMatching(b).workArea;
    const w = Math.round(d.width * Math.max(0.2, Math.min(1, pct / 100))), hh = Math.max(120, Math.min(420, h || b.height));
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
  if (pw.wav && pw2.wav) { const j = wavJoin([Buffer.from(pw.wav, 'base64'), Buffer.from(pw2.wav, 'base64')]); log('wav join', j ? j.length + ' bytes (' + Math.round(pw.wav.length * 0.75) + '+' + Math.round(pw2.wav.length * 0.75) + ')' : 'ERR'); if (j) fs.writeFileSync(path.join(out, 'voice-join.wav'), j); }
  try { const id = lgApi && lgApi.clipPut(Buffer.from(pw.wav || '', 'base64'), 'audio/wav'); const r = await net.fetch('http://127.0.0.1:8767/voice?id=' + id); log('clip serve', r.status, (await r.arrayBuffer()).byteLength); } catch (e) { log('clip serve ERR', String(e)); }
  for (const v of onlineTts.GG_VOICES) {   /* the online voice from a real Windows machine */
    const t0 = Date.now();
    try {
      const mp3 = await onlineTts.gg('Xin chào, đây là giọng đọc phụ đề của Hóng Sub.', (u, o) => net.fetch(u, o));
      log('online voice', v.id, 'mp3 bytes ' + mp3.length + ' in ' + (Date.now() - t0) + 'ms');
      fs.writeFileSync(path.join(out, 'voice-' + v.id.replace(/[^a-z0-9]/gi, '_') + '.mp3'), mp3);
    } catch (e) { log('online voice', v.id, 'ERR ' + (e && e.message)); }
  }
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
  try { log('lg test', JSON.stringify(lgModule.selfTest())); } catch (e) { log('lg test failed', String(e)); }
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
  try { lgApi = lgModule.setup({ ipcMain, app, net, getWin: () => win, log: null }); } catch (e) { console.error('lg', e); }
  try { tizenModule.setup({ ipcMain, net, getWin: () => win, cfgDir: app.getPath('userData'), lanAddr: async () => (lgApi && lgApi.myAddr ? lgApi.myAddr('') : '') }); } catch (e) { console.error('samsung', e); }
  try { tzRaw.setup({ ipcMain, BrowserWindow, getWin: () => win, lanAddr: async (tvIp) => (lgApi && lgApi.myAddr ? lgApi.myAddr(tvIp || '') : '') }); } catch (e) { console.error('samsung auto', e); }
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
app.on('activate', () => { if (!SELFTEST) showMain(); });
if (IS_MAC) app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu', label: 'Hóng Sub' }, { role: 'editMenu', label: 'Sửa' }, { role: 'windowMenu', label: 'Cửa sổ' }]));
});
app.on('before-quit', (e) => {
  if (!SELFTEST && byeState !== 2 && win && !win.isDestroyed()) { e.preventDefault(); bye(); return; }   /* Cmd+Q, the tray, an update: tidy the TV first */
  quitting = true;
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (ps) ps.stop(); aivStop(); for (const p of [tts, piper, rectProc]) { if (p) { try { p.kill(); } catch (e) { /* ignore */ } } } });
app.on('window-all-closed', () => { if (quitting || SELFTEST) app.quit(); });
