'use strict';
// Bridge between the Hóng Sub page and the Windows app (main.js). Exposed as window.hsDesktop.
const { contextBridge, ipcRenderer } = require('electron');

const selftest = process.argv.includes('--hs-selftest');
let audio = null, seq = 0;
/* Read-aloud lines play one after another: a new subtitle waits for the one being read instead of cutting it off.
   Each line's voice is made as soon as the line arrives, so the next line is ready the moment the current one ends.
   When reading falls behind the subtitles: the line being read speeds up, waiting lines are read faster,
   at most two lines wait, and a line that waited too long (its subtitle is long gone) is skipped. */
const lines = []; let cur = null;
const MAX_WAIT_MS = 7000;
function lineDrop(L) { if (L && L.ai && L.id) ipcRenderer.send('aiv-drop', L.id); }
function stopAll() {
  seq++; if (audio) { try { audio.pause(); } catch (e) { /* ignore */ } audio = null; }
  lineDrop(cur); lines.forEach(lineDrop);   /* only our own lines: a voice clip being made for the TV goes on */
  cur = null; lines.length = 0;
}
/* start making the voice of a line now (it plays later) */
function prepare(L) {
  L.id = ++seq; L.parts = []; L.ended = false; L.at = Date.now();
  if (L.pre) { L.parts.push({ wav: L.pre.b64, mime: L.pre.mime, rateApply: true, last: true }); L.ended = true; return; }   /* a clip made already (also sent to the TV) */
  if (L.ai) { ipcRenderer.send('aiv-speak', { id: L.id, text: L.text, voice: L.voice }); return; }
  ipcRenderer.invoke('speak', L.text, L.voice, L.rate).then((res) => {
    if (res && res.wav) L.parts.push({ wav: res.wav, mime: res.mime, rateApply: !!res.rateApply, last: true });
    L.ended = true; if (cur === L) playPart();
  }).catch(() => { L.ended = true; if (cur === L) playPart(); });
}
function finish(L) { if (cur === L) { cur = null; audio = null; startNext(); } }
function speedOf(c) { return Math.max(1, Math.min(1.6, c.boost * (c.hurry || 1), 2.3 / Math.max(1, c.rate || 1))); }   /* never faster than 2.3x in all */
function playPart() {
  const c = cur;
  if (!c || c.playing) return;
  const p = c.parts.shift();
  if (!p) { if (c.ended) finish(c); return; }
  c.playing = true;
  audio = new Audio('data:' + (p.mime || 'audio/wav') + ';base64,' + p.wav);
  c.applyRate = !!(c.ai || p.rateApply);
  const sp = speedOf(c);
  audio.preservesPitch = c.pitch === 1;
  if (c.applyRate) audio.playbackRate = c.rate * c.pitch * sp;
  else if (c.pitch !== 1 || sp !== 1) audio.playbackRate = c.pitch * sp;
  const a = audio;
  const done = () => { if (cur !== c || audio !== a) return; c.playing = false; audio = null; if (p.last) finish(c); else playPart(); };
  a.onended = done; a.onerror = done; a.play().catch(done);
}
function startNext() {
  if (cur) return;
  while (lines.length) {
    const L = lines.shift();
    if (Date.now() - L.at > MAX_WAIT_MS && !L.pre) { lineDrop(L); continue; }   /* waited too long, its subtitle is long gone: skip it */
    cur = L; L.playing = false; playPart(); return;
  }
}
/* a new line arrived while one is being read: read the current one a little faster so the voice keeps up */
function hurry() {
  if (!cur) return;
  cur.hurry = Math.min(1.35, (cur.hurry || 1) * 1.12);
  if (audio) { const sp = speedOf(cur); audio.playbackRate = cur.applyRate ? cur.rate * cur.pitch * sp : cur.pitch * sp; }
}
function enqueue(L, queue) {
  if (!queue) stopAll();
  else {
    while (lines.length >= 2) lineDrop(lines.shift());   /* far behind: drop the oldest waiting line */
    if (cur || lines.length) { L.boost = lines.length ? 1.25 : 1.12; hurry(); }
  }
  prepare(L); lines.push(L); startNext();
}
ipcRenderer.on('aiv-audio', (e, m) => {
  const L = (cur && cur.id === m.id) ? cur : lines.find(x => x.id === m.id);
  if (!L) return;
  if (m.type === 'error') { L.ended = true; if (cur === L && !L.playing) playPart(); return; }
  if (m.type !== 'audio') return;
  L.parts.push({ wav: m.wav, last: !!m.last }); if (m.last) L.ended = true;
  if (cur === L) playPart();
});

const api = {
  selftest,
  sources: () => ipcRenderer.invoke('sources'),
  windows: () => ipcRenderer.invoke('windows'),
  rpInfo: () => ipcRenderer.invoke('rp-info'),
  rpLaunch: (opengl) => ipcRenderer.invoke('rp-launch', opengl),
  onRpExit: (cb) => ipcRenderer.on('rp-exit', () => cb()),
  use: (id) => ipcRenderer.invoke('use', id),
  sub: (p) => ipcRenderer.send('sub', p),
  subPlace: (r) => ipcRenderer.send('sub-place', r),
  overlay: (cmd) => ipcRenderer.send('overlay', cmd),
  onOverlay: (cb) => ipcRenderer.on('overlay-state', (e, s) => cb(s)),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (e, k) => cb(k)),
  onSub: (cb) => ipcRenderer.on('sub', (e, p) => cb(p)),
  zones: (list) => ipcRenderer.send('zones', list),
  fullOverlay: (data) => ipcRenderer.send('full-overlay', data),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdate: (cb) => ipcRenderer.on('update-available', (e, u) => cb(u)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (e, p) => cb(p)),
  onBye: (cb) => ipcRenderer.on('bye', () => cb()),
  byeDone: () => ipcRenderer.send('bye-done'),
  tv: {
    find: () => ipcRenderer.invoke('tv-find'),
    ping: (ip) => ipcRenderer.invoke('tv-ping', ip),
    send: (ip, msg) => ipcRenderer.invoke('tv-send', ip, msg),
    relay: (msg) => ipcRenderer.invoke('tv-relay', msg),
    say: (ip, msg) => ipcRenderer.invoke('tv-say', ip, msg)
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
    const v = String(voice || '');
    enqueue({ text, ai: v.startsWith('ai:'), voice: v.startsWith('ai:') ? v.slice(3) : v, rate: rate || 1, pitch: pitch || 1, boost: 1 }, queue);
  },
  voiceSettings: () => ipcRenderer.send('voice-settings'),
  az: {
    set: (key, region) => ipcRenderer.invoke('az-set', key, region),
    state: () => ipcRenderer.invoke('az-state'),
    test: () => ipcRenderer.invoke('az-test')
  },
  netInfo: () => ipcRenderer.invoke('net-info'),
  voiceClip: (text, voice) => ipcRenderer.invoke('voice-clip', text, voice),
  /* play a clip made by voiceClip here too (same queue as the subtitles read aloud) */
  playClip: (clip, rate, pitch, queue) => {
    if (!clip || !clip.b64) return;
    enqueue({ text: '', ai: false, pre: { b64: clip.b64, mime: clip.mime }, rate: rate || 1, pitch: pitch || 1, boost: 1 }, queue);
  },
  aiv: {
    state: () => ipcRenderer.invoke('aiv-state'),
    install: () => ipcRenderer.invoke('aiv-install'),
    start: () => ipcRenderer.invoke('aiv-start'),
    fast: (on) => ipcRenderer.invoke('aiv-fast', on),
    remove: () => ipcRenderer.invoke('aiv-remove'),
    onState: (cb) => ipcRenderer.on('aiv-state', (e, s) => cb(s))
  },
  update: () => ipcRenderer.invoke('update'),
  updateNotes: (from, to) => ipcRenderer.invoke('update-notes', from, to),
  version: () => ipcRenderer.invoke('app-version'),
  getJson: (u) => ipcRenderer.invoke('get-json', u),
  hotkeys: () => ipcRenderer.invoke('hotkeys-get'),
  setHotkeys: (k) => ipcRenderer.invoke('hotkeys-set', k),
  pauseHotkeys: (on) => ipcRenderer.invoke('hotkeys-pause', on),
  sonyRp: () => ipcRenderer.invoke('sony-rp'),
  openSonyRp: () => ipcRenderer.invoke('sony-rp-open'),
  openUrl: (u) => ipcRenderer.invoke('open-url', u),
  overlayReset: () => ipcRenderer.invoke('overlay-reset'),
  overlaySize: (pct, h, hgt) => ipcRenderer.invoke('overlay-size', pct, h, hgt),
  samsung: {
    state: () => ipcRenderer.invoke('tz-state'),
    find: () => ipcRenderer.invoke('tz-find'),
    info: (ip) => ipcRenderer.invoke('tz-info', ip),
    install: (ip, profile, code) => ipcRenderer.invoke('tz-install', ip, profile, code),
    launch: () => ipcRenderer.invoke('tz-launch'),
    onProgress: (cb) => ipcRenderer.on('tz-progress', (e, t) => cb(t))
  },
  lg: {
    find: () => ipcRenderer.invoke('lg-find'),
    state: () => ipcRenderer.invoke('lg-state'),
    install: (ip, pass, code) => ipcRenderer.invoke('lg-install', ip, pass, code),
    launch: (code) => ipcRenderer.invoke('lg-launch', code),
    auto: (on) => ipcRenderer.invoke('lg-auto', on),
    push: (code, msg) => ipcRenderer.invoke('lg-push', code, msg),
    seen: (code) => ipcRenderer.invoke('lg-seen', code),
    ver: (code) => ipcRenderer.invoke('lg-ver', code),
    update: (code) => ipcRenderer.invoke('lg-update', code),
    addr: () => ipcRenderer.invoke('lg-addr'),
    onProgress: (cb) => ipcRenderer.on('lg-progress', (e, t) => cb(t))
  },
  ps: {
    /* TV Samsung without Tizen Studio: the same lines and events as the phone apps' core (see tzraw.js) */
    raw: (() => {
      const H = [], wait = [];
      ipcRenderer.on('tzr-ev', (e, j) => {
        for (let k = 0; k < wait.length; k++) if (wait[k].ev === j.ev && (!wait[k].id || wait[k].id === j.id)) { wait.splice(k, 1)[0].f(j); return; }
        H.slice().forEach((f) => { try { f(j); } catch (x) { /* ignore */ } });
      });
      return {
        call: (cmd) => ipcRenderer.invoke('tzr-call', String(cmd)),
        send: (line) => { ipcRenderer.send('tzr-send', String(line)); return Promise.resolve(true); },
        ask: (line, ev, ms, id) => new Promise((res) => {
          const x = { ev, id, f: (j) => { clearTimeout(t); res(j); } };
          const t = setTimeout(() => { const i = wait.indexOf(x); if (i >= 0) wait.splice(i, 1); res({ ev, ok: false, err: 'timeout' }); }, ms || 5000);
          wait.push(x); ipcRenderer.send('tzr-send', String(line));
        }),
        on: (f) => { H.push(f); return () => { const i = H.indexOf(f); if (i >= 0) H.splice(i, 1); }; }
      };
    })(),
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
};
/* Mac: the PS5 is played in Sony's PS Remote Play app (Hóng Sub reads its window); the built-in player and the
   downloadable AI voices are Windows only. The Mac asks once for the screen-recording permission. */
api.platform = process.platform;
if (process.platform === 'darwin') {
  delete api.ps; delete api.aiv;
  api.mac = {
    screen: () => ipcRenderer.invoke('mac-screen'),
    openScreen: () => ipcRenderer.send('mac-screen-open'),
    check: () => ipcRenderer.invoke('mac-capture-check'),
    fix: () => ipcRenderer.invoke('mac-screen-fix'),
    relaunch: () => ipcRenderer.send('mac-relaunch'),
    openVoices: () => ipcRenderer.send('voice-settings')
  };
}
contextBridge.exposeInMainWorld('hsDesktop', api);
