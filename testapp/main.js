/* Hóng Sub Test: game giả có phụ đề để thử Hóng Sub, và kiểm tra máy tính trước khi dùng. */
const { app, BrowserWindow, ipcMain, protocol, net, shell, screen, desktopCapturer, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const netSock = require('net');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const SELFTEST = process.argv.includes('--selftest') || process.env.HS_SELFTEST === '1';
const OUT = process.env.HS_SELFTEST_OUT || path.join(os.tmpdir(), 'hongsub-test-selftest');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (!SELFTEST && !app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('store.honggame.hongsub.test');

let panel = null, game = null;

function serve() {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    const file = path.normalize(path.join(ROOT, 'ui', decodeURIComponent(u.pathname).replace(/^\/+/, '')));
    if (!file.startsWith(path.join(ROOT, 'ui'))) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      const h = new Headers(res.headers);
      h.set('Cross-Origin-Opener-Policy', 'same-origin');
      h.set('Cross-Origin-Embedder-Policy', 'credentialless');
      if (file.endsWith('.wasm')) h.set('Content-Type', 'application/wasm');
      else if (/\.m?js$/.test(file)) h.set('Content-Type', 'text/javascript');
      return new Response(res.body, { status: res.status, headers: h });
    });
  });
}

function makeGame() {
  const d = screen.getPrimaryDisplay().workArea;
  const gw = Math.max(960, Math.min(1280, d.width - 800));
  game = new BrowserWindow({
    width: gw, height: Math.round(gw * 9 / 16), x: d.x + 20, y: d.y + 40, useContentSize: true,
    title: 'PS Remote Play - Game thử (Hóng Sub Test)', backgroundColor: '#000', autoHideMenuBar: true,
    icon: path.join(ROOT, 'ui', 'icon.png'),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, backgroundThrottling: false }
  });
  game.loadURL('app://test/game.html');
  game.on('page-title-updated', (e) => e.preventDefault());
  game.on('closed', () => { game = null; if (panel) panel.webContents.send('game-event', { type: 'closed' }); });
}

function makePanel() {
  const d = screen.getPrimaryDisplay().workArea;
  panel = new BrowserWindow({
    width: 760, height: Math.min(900, d.height - 40), x: d.x + d.width - 780, y: d.y + 20, minWidth: 620, minHeight: 560,
    title: 'Hóng Sub Test', backgroundColor: '#ECEEF1', autoHideMenuBar: true,
    icon: path.join(ROOT, 'ui', 'icon.png'),
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, backgroundThrottling: false }
  });
  panel.loadURL('app://test/index.html');
  panel.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  panel.on('closed', () => { panel = null; if (!SELFTEST) app.quit(); });
}

/* ---------- PS5 / PS4 discovery on the home network ---------- */
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
function discover(extraIp) {
  return new Promise((resolve) => {
    const found = {};
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => {});
    sock.on('message', (msg, rinfo) => {
      const lines = msg.toString('utf8').replace(/\0+$/, '').split(/\r?\n/);
      const m = /^HTTP\/1\.1\s+(\d+)/.exec(lines[0] || ''); if (!m) return;
      const h = {};
      for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) h[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
      found[h['host-id'] || rinfo.address] = { name: h['host-name'] || rinfo.address, type: h['host-type'] || '', addr: rinfo.address, state: m[1] === '200' ? 'ready' : m[1] === '620' ? 'standby' : 'unknown', fw: h['system-version'] || '', app: h['running-app-name'] || '' };
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch (e) { /* ignore */ }
      const pk5 = Buffer.from('SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00030010\n\0');
      const pk4 = Buffer.from('SRCH * HTTP/1.1\ndevice-discovery-protocol-version:00020020\n\0');
      const targets = broadcasts(); if (extraIp) targets.push(extraIp);
      for (let k = 0; k < 3; k++) setTimeout(() => { for (const t of targets) { sock.send(pk5, 9302, t, () => {}); sock.send(pk4, 987, t, () => {}); } }, k * 600);
      setTimeout(() => { try { sock.close(); } catch (e) { /* ignore */ } resolve(Object.values(found)); }, 2600);
    });
  });
}
function tcpProbe(host, port, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now(), s = new netSock.Socket(); let done = false;
    const end = (ok, err) => { if (done) return; done = true; try { s.destroy(); } catch (e) { /* ignore */ } resolve({ ok, ms: Date.now() - t0, err: err || '' }); };
    s.setTimeout(ms || 2000); s.once('connect', () => end(true)); s.once('timeout', () => end(false, 'timeout')); s.once('error', (e) => end(false, e.code || String(e)));
    s.connect(port, host);
  });
}

/* ---------- small helpers for the checks ---------- */
async function timedFetch(url, opt) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), (opt && opt.timeout) || 8000);
    const r = await net.fetch(url, { method: (opt && opt.method) || 'GET', headers: (opt && opt.headers) || {}, body: opt && opt.body, signal: ctl.signal });
    const text = await r.text(); clearTimeout(tm);
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, text: text.slice(0, (opt && opt.keep) || 4000) };
  } catch (e) { return { ok: false, status: 0, ms: Date.now() - t0, err: e.name === 'AbortError' ? 'quá thời gian' : String(e.message || e) }; }
}
function ps(cmd) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true, timeout: 20000, maxBuffer: 4 << 20 }, (err, out) => resolve(err ? '' : String(out)));
  });
}
async function voicesWin() {
  const out = await ps("$r=@(); foreach($p in 'HKLM:\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices\\Tokens','HKLM:\\SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Speech\\Voices\\Tokens'){ if(Test-Path $p){ Get-ChildItem $p | ForEach-Object { $a=Get-ItemProperty ($_.PSPath+'\\Attributes') -ErrorAction SilentlyContinue; $r+=[pscustomobject]@{name=[string]$a.Name; lang=[string]$a.Language; src=(Split-Path $p -Parent | Split-Path -Leaf)} } } }; $r | ConvertTo-Json -Compress");
  try { const j = JSON.parse(out || '[]'); return Array.isArray(j) ? j : [j]; } catch (e) { return []; }
}
function hongSub() {
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const dirs = [path.join(la, 'Programs', 'hong-sub-pc'), path.join(la, 'Programs', 'Hóng Sub')].concat(pf.map(p => path.join(p, 'Hóng Sub')));
  for (const d of dirs) {
    const exe = path.join(d, 'HongSub.exe');
    if (fs.existsSync(exe)) {
      let ver = ''; try { ver = JSON.parse(fs.readFileSync(path.join(d, 'resources', 'app', 'package.json'), 'utf8')).version; } catch (e) { /* ignore */ }
      const piper = fs.existsSync(path.join(d, 'resources', 'voices', 'vi_VN-vais1000-medium.onnx'));
      const rp = fs.existsSync(path.join(d, 'resources', 'rp'));
      return { installed: true, dir: d, version: ver, piper, rp };
    }
  }
  return { installed: false };
}
function sysInfo() {
  const nets = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) nets.push({ name, ip: a.address, mask: a.netmask });
  }
  const ds = screen.getAllDisplays().map(d => ({ w: d.size.width, h: d.size.height, scale: d.scaleFactor, hz: d.displayFrequency }));
  return { os: os.type() + ' ' + (os.version ? os.version() : '') + ' (' + os.release() + ')', arch: os.arch(), cpu: (os.cpus()[0] || {}).model || '', cores: os.cpus().length, ram: Math.round(os.totalmem() / 1073741824 * 10) / 10, nets, displays: ds, app: app.getVersion() };
}

function ipc() {
  ipcMain.handle('sys', async () => { const s = sysInfo(); try { const g = await app.getGPUInfo('complete'); s.gpu = ((g.gpuDevice || []).find(d => d.active) || (g.gpuDevice || [])[0] || {}); s.gpuName = (g.auxAttributes && g.auxAttributes.glRenderer) || ''; } catch (e) { s.gpuName = ''; } return s; });
  ipcMain.handle('fetch', (e, url, opt) => timedFetch(url, opt));
  ipcMain.handle('discover', (e, ip) => discover(ip));
  ipcMain.handle('tcp', (e, host, port) => tcpProbe(host, port, 2500));
  ipcMain.handle('voices-win', () => voicesWin());
  ipcMain.handle('hongsub', () => hongSub());
  ipcMain.handle('sources', async () => { try { const s = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } }); return { n: s.length, names: s.map(x => x.name).slice(0, 30) }; } catch (e) { return { n: 0, err: String(e) }; } });
  ipcMain.handle('save-report', (e, text, name) => {
    let dir = app.getPath('desktop'); if (!fs.existsSync(dir)) dir = app.getPath('documents');
    const f = path.join(dir, name);
    fs.writeFileSync(f, '﻿' + text, 'utf8');
    try { clipboard.writeText(text); } catch (x) { /* ignore */ }
    shell.showItemInFolder(f);
    return f;
  });
  ipcMain.handle('open', (e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.on('game-cmd', (e, c) => {
    if (!game) makeGame();
    if (c.focus) { game.show(); game.focus(); }
    game.webContents.send('game-cmd', c);
  });
  ipcMain.on('game-event', (e, ev) => { if (panel) panel.webContents.send('game-event', ev); });
  ipcMain.on('game-full', (e, on) => { if (!game) return; game.setFullScreen(on === undefined ? !game.isFullScreen() : !!on); });
  ipcMain.handle('version', () => app.getVersion());
}

async function selftest() {
  fs.mkdirSync(OUT, { recursive: true });
  const log = (...a) => fs.appendFileSync(path.join(OUT, 'testapp-log.txt'), a.join(' ') + '\n');
  log('version', app.getVersion());
  panel.webContents.on('console-message', (e) => log('console', e.level, e.message));
  await new Promise(r => panel.webContents.once('did-finish-load', r));
  await new Promise(r => setTimeout(r, 3000));
  const res = await panel.webContents.executeJavaScript('window.hsRunChecks ? window.hsRunChecks().then(JSON.stringify) : "null"');
  log('checks', res);
  await panel.webContents.executeJavaScript("document.querySelector('[data-tab=sub]').click(); window.hsPlay && window.hsPlay(1);");
  await new Promise(r => setTimeout(r, 9000));
  const shotP = await panel.webContents.capturePage(); fs.writeFileSync(path.join(OUT, 'testapp-panel.png'), shotP.toPNG());
  if (game) { const shotG = await game.webContents.capturePage(); fs.writeFileSync(path.join(OUT, 'testapp-game.png'), shotG.toPNG()); }
  await panel.webContents.executeJavaScript("document.querySelector('[data-tab=check]').click();");
  await new Promise(r => setTimeout(r, 800));
  const shotC = await panel.webContents.capturePage(); fs.writeFileSync(path.join(OUT, 'testapp-checks.png'), shotC.toPNG());
  const rep = await panel.webContents.executeJavaScript('window.hsReportText ? window.hsReportText() : ""');
  fs.writeFileSync(path.join(OUT, 'testapp-report.txt'), rep);
  log('done');
  app.exit(0);
}

app.whenReady().then(() => {
  serve(); ipc();
  makeGame(); makePanel();
  if (SELFTEST) selftest().catch(e => { try { fs.appendFileSync(path.join(OUT, 'testapp-log.txt'), 'FATAL ' + e.stack + '\n'); } catch (x) { /* ignore */ } app.exit(1); });
});
app.on('window-all-closed', () => app.quit());
