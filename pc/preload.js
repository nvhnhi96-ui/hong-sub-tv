'use strict';
// Bridge between the Hóng Sub page and the Windows app (main.js). Exposed as window.hsDesktop.
const { contextBridge, ipcRenderer } = require('electron');

const selftest = process.argv.includes('--hs-selftest');
let audio = null, seq = 0;
/* Read-aloud lines play one after another: a new subtitle waits for the one being read instead of cutting it off.
   If reading falls behind, waiting lines are read a little faster and only the oldest waiting line is dropped. */
const lines = []; let cur = null;
function stopAll() {
  seq++; if (audio) { try { audio.pause(); } catch (e) { /* ignore */ } audio = null; }
  if (cur && cur.ai) ipcRenderer.send('aiv-stop');
  cur = null; lines.length = 0;
}
function finish(id) { if (cur && cur.id === id) { cur = null; audio = null; startNext(); } }
function playPart() {
  if (!cur || cur.playing) return;
  const p = cur.parts.shift();
  if (!p) { if (cur.ended) finish(cur.id); return; }
  cur.playing = true; const my = cur.id, c = cur;
  audio = new Audio('data:audio/wav;base64,' + p.wav);
  if (c.ai) { audio.preservesPitch = c.pitch === 1; audio.playbackRate = c.rate * c.pitch; }
  else if (c.pitch !== 1 || c.boost !== 1) { audio.preservesPitch = c.pitch === 1; audio.playbackRate = c.pitch * c.boost; }
  const done = () => { if (!cur || cur.id !== my) return; cur.playing = false; audio = null; if (p.last) finish(my); else playPart(); };
  audio.onended = done; audio.onerror = done; audio.play().catch(done);
}
function startNext() {
  if (cur || !lines.length) return;
  const L = lines.shift(), my = ++seq;
  cur = { id: my, ai: L.ai, parts: [], playing: false, ended: false, rate: L.rate * L.boost, pitch: L.pitch, boost: L.boost };
  if (L.ai) { ipcRenderer.send('aiv-speak', { id: my, text: L.text, voice: L.voice }); return; }
  ipcRenderer.invoke('speak', L.text, L.voice, L.rate).then((res) => {
    if (!cur || cur.id !== my) return;
    if (!res || !res.wav) { finish(my); return; }
    cur.parts.push({ wav: res.wav, last: true }); playPart();
  }).catch(() => finish(my));
}
ipcRenderer.on('aiv-audio', (e, m) => {
  if (!cur || m.id !== cur.id) return;
  if (m.type === 'error') { cur.ended = true; if (!cur.playing) playPart(); return; }
  if (m.type !== 'audio') return;
  cur.parts.push({ wav: m.wav, last: !!m.last }); if (m.last) cur.ended = true; playPart();
});

contextBridge.exposeInMainWorld('hsDesktop', {
  selftest,
  sources: () => ipcRenderer.invoke('sources'),
  windows: () => ipcRenderer.invoke('windows'),
  rpInfo: () => ipcRenderer.invoke('rp-info'),
  rpLaunch: (opengl) => ipcRenderer.invoke('rp-launch', opengl),
  onRpExit: (cb) => ipcRenderer.on('rp-exit', () => cb()),
  use: (id) => ipcRenderer.invoke('use', id),
  sub: (p) => ipcRenderer.send('sub', p),
  overlay: (cmd) => ipcRenderer.send('overlay', cmd),
  onOverlay: (cb) => ipcRenderer.on('overlay-state', (e, s) => cb(s)),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (e, k) => cb(k)),
  onSub: (cb) => ipcRenderer.on('sub', (e, p) => cb(p)),
  zones: (list) => ipcRenderer.send('zones', list),
  fullOverlay: (data) => ipcRenderer.send('full-overlay', data),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdate: (cb) => ipcRenderer.on('update-available', (e, u) => cb(u)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (e, p) => cb(p)),
  tv: {
    find: () => ipcRenderer.invoke('tv-find'),
    ping: (ip) => ipcRenderer.invoke('tv-ping', ip),
    send: (ip, msg) => ipcRenderer.invoke('tv-send', ip, msg),
    relay: (msg) => ipcRenderer.invoke('tv-relay', msg)
  },
  onFull: (cb) => ipcRenderer.on('full', (e, d) => cb(d)),
  onZone: (cb) => ipcRenderer.on('zone', (e, d) => cb(d)),
  zoneSize: (id, w, h) => ipcRenderer.send('zone-size', id, w, h),
  zonesReset: () => ipcRenderer.invoke('zones-reset'),
  zonesPanel: (on) => ipcRenderer.invoke('zones-panel', on),
  voices: () => ipcRenderer.invoke('voices'),
  /* queue=true for subtitles (wait for the line being read), false for samples and tests (cut in right away) */
  speak: async (text, voice, rate, pitch, queue) => {
    if (!text) { stopAll(); return; }
    const v = String(voice || ''), L = { text, ai: v.startsWith('ai:'), voice: v.startsWith('ai:') ? v.slice(3) : v, rate: rate || 1, pitch: pitch || 1, boost: 1 };
    if (!queue) stopAll();
    else {
      if (lines.length >= 2) lines.splice(0, lines.length - 1);      /* far behind: drop the oldest waiting line */
      if (cur || lines.length) L.boost = lines.length ? 1.25 : 1.12;   /* behind: read the waiting line a bit faster */
    }
    lines.push(L); startNext();
  },
  voiceSettings: () => ipcRenderer.send('voice-settings'),
  aiv: {
    state: () => ipcRenderer.invoke('aiv-state'),
    install: () => ipcRenderer.invoke('aiv-install'),
    start: () => ipcRenderer.invoke('aiv-start'),
    fast: (on) => ipcRenderer.invoke('aiv-fast', on),
    remove: () => ipcRenderer.invoke('aiv-remove'),
    onState: (cb) => ipcRenderer.on('aiv-state', (e, s) => cb(s))
  },
  update: () => ipcRenderer.invoke('update'),
  version: () => ipcRenderer.invoke('app-version'),
  getJson: (u) => ipcRenderer.invoke('get-json', u),
  hotkeys: () => ipcRenderer.invoke('hotkeys-get'),
  setHotkeys: (k) => ipcRenderer.invoke('hotkeys-set', k),
  pauseHotkeys: (on) => ipcRenderer.invoke('hotkeys-pause', on),
  sonyRp: () => ipcRenderer.invoke('sony-rp'),
  openSonyRp: () => ipcRenderer.invoke('sony-rp-open'),
  openUrl: (u) => ipcRenderer.invoke('open-url', u),
  overlayReset: () => ipcRenderer.invoke('overlay-reset'),
  overlaySize: (pct, h) => ipcRenderer.invoke('overlay-size', pct, h),
  lg: {
    find: () => ipcRenderer.invoke('lg-find'),
    state: () => ipcRenderer.invoke('lg-state'),
    install: (ip, pass, code) => ipcRenderer.invoke('lg-install', ip, pass, code),
    launch: (code) => ipcRenderer.invoke('lg-launch', code),
    auto: (on) => ipcRenderer.invoke('lg-auto', on),
    push: (code, msg) => ipcRenderer.invoke('lg-push', code, msg),
    seen: (code) => ipcRenderer.invoke('lg-seen', code),
    addr: () => ipcRenderer.invoke('lg-addr'),
    onProgress: (cb) => ipcRenderer.on('lg-progress', (e, t) => cb(t))
  },
  ps: {
    state: () => ipcRenderer.invoke('ps-state'),
    login: () => ipcRenderer.invoke('ps-login'),
    loginUrl: (u) => ipcRenderer.invoke('ps-login-url', u),
    loginBrowser: () => ipcRenderer.invoke('ps-login-browser'),
    loginCancel: () => ipcRenderer.invoke('ps-login-cancel'),
    logout: () => ipcRenderer.invoke('ps-logout'),
    discover: (ip) => ipcRenderer.invoke('ps-discover', ip),
    regist: (host, pin) => ipcRenderer.invoke('ps-regist', host, pin),
    forget: (id) => ipcRenderer.invoke('ps-forget', id),
    wake: (id) => ipcRenderer.invoke('ps-wake', id),
    connect: (id, o) => ipcRenderer.invoke('ps-connect', id, o),
    fwCheck: () => ipcRenderer.invoke('ps-fw-check'),
    fwFix: () => ipcRenderer.invoke('ps-fw-fix'),
    input: (line) => ipcRenderer.send('ps-input', line),
    stop: (sleep) => ipcRenderer.send('ps-stop', sleep),
    onVideo: (cb) => ipcRenderer.on('ps-v', (e, d) => cb(d)),
    onAudioHeader: (cb) => ipcRenderer.on('ps-ah', (e, d) => cb(d)),
    onAudio: (cb) => ipcRenderer.on('ps-a', (e, d) => cb(d)),
    onEvent: (cb) => ipcRenderer.on('ps-ev', (e, d) => cb(d))
  }
});
