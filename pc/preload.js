'use strict';
// Bridge between the Hóng Sub page and the Windows app (main.js). Exposed as window.hsDesktop.
const { contextBridge, ipcRenderer } = require('electron');

const selftest = process.argv.includes('--hs-selftest');
let audio = null, seq = 0;
let aiId = 0, aiQueue = [], aiPlaying = false, aiRate = 1, aiPitch = 1;
function aiNext() {
  if (aiPlaying || !aiQueue.length) return;
  const m = aiQueue.shift(); aiPlaying = true;
  audio = new Audio('data:audio/wav;base64,' + m.wav);
  /* each character can have its own pitch: play a little faster/slower without keeping the pitch */
  audio.preservesPitch = aiPitch === 1; audio.playbackRate = aiRate * aiPitch;
  const done = () => { aiPlaying = false; audio = null; aiNext(); };
  audio.onended = done; audio.onerror = done;
  audio.play().catch(done);
}
ipcRenderer.on('aiv-audio', (e, m) => { if (m.type !== 'audio' || m.id !== aiId) return; aiQueue.push(m); aiNext(); });

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
  tv: {
    find: () => ipcRenderer.invoke('tv-find'),
    ping: (ip) => ipcRenderer.invoke('tv-ping', ip),
    send: (ip, msg) => ipcRenderer.invoke('tv-send', ip, msg)
  },
  onFull: (cb) => ipcRenderer.on('full', (e, d) => cb(d)),
  onZone: (cb) => ipcRenderer.on('zone', (e, d) => cb(d)),
  zoneSize: (id, w, h) => ipcRenderer.send('zone-size', id, w, h),
  zonesReset: () => ipcRenderer.invoke('zones-reset'),
  zonesPanel: (on) => ipcRenderer.invoke('zones-panel', on),
  voices: () => ipcRenderer.invoke('voices'),
  speak: async (text, voice, rate, pitch) => {
    const my = ++seq;
    if (audio) { audio.pause(); audio = null; }
    aiQueue = []; aiPlaying = false; if (aiId) { ipcRenderer.send('aiv-stop'); aiId = 0; }
    if (!text) return;
    if (String(voice || '').startsWith('ai:')) {             /* AI voice: sentences arrive one by one and play in order */
      aiId = my; aiRate = rate || 1; aiPitch = pitch || 1; aiPlaying = false;
      ipcRenderer.send('aiv-speak', { id: my, text, voice: String(voice).slice(3) });
      return;
    }
    const res = await ipcRenderer.invoke('speak', text, voice, rate);
    if (my !== seq || !res || !res.wav) return;
    audio = new Audio('data:audio/wav;base64,' + res.wav);
    if (pitch && pitch !== 1) { audio.preservesPitch = false; audio.playbackRate = pitch; }
    audio.play().catch(() => {});
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
    input: (line) => ipcRenderer.send('ps-input', line),
    stop: (sleep) => ipcRenderer.send('ps-stop', sleep),
    onVideo: (cb) => ipcRenderer.on('ps-v', (e, d) => cb(d)),
    onAudioHeader: (cb) => ipcRenderer.on('ps-ah', (e, d) => cb(d)),
    onAudio: (cb) => ipcRenderer.on('ps-a', (e, d) => cb(d)),
    onEvent: (cb) => ipcRenderer.on('ps-ev', (e, d) => cb(d))
  }
});
