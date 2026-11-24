'use strict';
// Bridge between the Hóng Sub page and the Windows app (main.js). Exposed as window.hsDesktop.
const { contextBridge, ipcRenderer } = require('electron');

const selftest = process.argv.includes('--hs-selftest');
let audio = null, seq = 0;
/* Every line is read in full, in order (11/2026, the owner's choice: "đọc đủ"): a line being read is never cut and a
   waiting line is never left out. The voice keeps up in other ways:
   - the voice of a line is made BEFORE its Vietnamese shows when the page can tell which line comes next (voiceWarm),
     and every voice made is kept on this computer (main.js, voice-cache): such a line starts with no wait;
   - a line not expected: its first clause is made first and starts while the rest is made;
   - the speed of a line comes from the real length of its sound and the time the character talks (fit);
   - when lines come faster than they can be read, the line being read speeds up and the waiting ones are read
     faster the more of them wait (up to 1.8x). */
const lines = []; let cur = null;
const STUCK_MS = 9000, BACKLOG_MAX = 12;   /* 12 lines waiting: only a broken voice gets there */
/* a line that made no sound for STUCK_MS (its voice was never made): it goes and the next line is read; before, one
   such line kept the reading silent for the rest of the session */
setInterval(() => { if (cur && !cur.playing && !cur.startAt && Date.now() - Math.max(cur.at, cur.curAt || 0) > STUCK_MS) { said(cur, false, 'giọng không trả lời, bỏ qua câu'); cutCur(); startNext(); } }, 1500);
function lineDrop(L) { if (L) L.dropped = true; if (L && L.ai && L.id) ipcRenderer.send('aiv-drop', L.id); }
function stopAll() {
  seq++; if (audio) { try { audio.pause(); } catch (e) { /* ignore */ } audio = null; }
  lineDrop(cur); lines.forEach(lineDrop);   /* only our own lines: a voice clip being made for the TV goes on */
  cur = null; lines.length = 0;
}
/* start making the voice of a line now (it plays later) */
/* what happened to the last line read aloud (for the problem report) */
let lastSpeak = null;
const waits = [];   /* ms from a line being asked to its first sound (the last 30 lines) */
function said(L, ok, err) { lastSpeak = { at: new Date().toTimeString().slice(0, 8), voice: (L.ai ? 'ai:' : '') + (L.voice || 'mặc định'), ok: !!ok, err: err || '' }; }
/* the chosen voice made nothing: the line is read again with this computer's own Vietnamese voice, never silent */
function fallback(L, why) {
  if (L.fell) { said(L, false, why); L.ended = true; if (cur === L) playPart(); return; }
  L.fell = true; L.ai = false; L.voice = '';
  ipcRenderer.invoke('speak', L.text, '', L.rate).then((res) => {
    if (res && res.wav) { L.parts.push({ wav: res.wav, mime: res.mime, rateApply: !!res.rateApply, last: true }); said(L, true, why + ', đọc bằng giọng máy'); } else said(L, false, why + ', giọng máy cũng không đọc được');
    L.ended = true; if (cur === L) playPart(); else takeOver(L);
  }).catch((e) => { said(L, false, why + ': ' + (e && e.message)); L.ended = true; if (cur === L) playPart(); });
}
function splitLine(t) {
  const a = String(t || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/).filter(Boolean), out = [];
  a.forEach((x) => { if (out.length && out[out.length - 1].length < 24) out[out.length - 1] += ' ' + x; else out.push(x); });
  let r = out.length > 3 ? [out[0], out.slice(1).join(' ')] : out;
  /* a long first sentence: its first clause (to the first comma) is a piece of its own, its sound is ready sooner */
  const f = r[0] || '';
  if (f.length > 70) { const m = /^(.{8,60}?[,;:])\s+(.{12,})$/.exec(f); if (m) r = [m[1], m[2]].concat(r.slice(1)); }
  return r;
}
function prepare(L) {
  L.id = ++seq; L.parts = []; L.ended = false; L.at = Date.now();
  if (L.pre) { L.parts.push({ wav: L.pre.b64, mime: L.pre.mime, rateApply: true, last: true, frac: 1 }); L.ended = true; return; }   /* a clip made already (also sent to the TV) */
  if (L.ai) {
    const ask = () => {
      if (L.dropped) return;
      ipcRenderer.send('aiv-speak', { id: L.id, text: L.text, voice: L.voice });
      /* the AI voice says nothing within 6 s (stopped, busy, starting): this computer's voice reads the line */
      setTimeout(() => { if (!L.got && !L.fell && !L.dropped) { ipcRenderer.send('aiv-drop', L.id); fallback(L, 'giọng AI không trả lời'); } }, 6000);
    };
    /* made ahead of time, or kept from before: it plays now */
    (L.text.length <= 600 ? ipcRenderer.invoke('voice-get', L.text, 'ai:' + L.voice) : Promise.resolve(null)).then((r) => {
      if (L.dropped) return;
      if (!(r && r.wav)) { ask(); return; }
      L.got = true; L.kept = true; said(L, true); L.parts.push({ wav: r.wav, mime: r.mime, last: true, frac: 1 }); L.ended = true;
      if (cur === L) playPart(); else takeOver(L);
    }, ask);
    return;
  }
  /* a line of several sentences: the first sentence's voice is made first and starts while the rest is made, so the
     reading begins sooner after the Vietnamese shows */
  const pieces = splitLine(L.text);
  if (pieces.length > 1) {
    const got = new Array(pieces.length), all = pieces.reduce((n, x) => n + x.length, 0) || 1; let next = 0;
    const flush = () => {
      if (L.dropped) return;
      while (next < pieces.length && got[next] !== undefined) { const r = got[next]; if (r && r.wav) { if (!L.parts.length && !L.startAt) said(L, true); L.parts.push({ wav: r.wav, mime: r.mime, rateApply: !!r.rateApply, last: next === pieces.length - 1, frac: pieces[next].length / all }); } next++; }
      if (next >= pieces.length) {
        if (!L.parts.length && !L.startAt) { if (L.voice) { fallback(L, 'giọng ' + L.voice + ' không đọc được'); return; } said(L, false, 'không đọc được'); }
        L.ended = true;
      }
      if (cur === L) playPart(); else if (L.parts.length) takeOver(L);
    };
    pieces.forEach((t, i) => { ipcRenderer.invoke('speak', t, L.voice, L.rate).then((r) => { got[i] = r || null; flush(); }).catch(() => { got[i] = null; flush(); }); });
    return;
  }
  ipcRenderer.invoke('speak', L.text, L.voice, L.rate).then((res) => {
    if (res && res.wav) { L.parts.push({ wav: res.wav, mime: res.mime, rateApply: !!res.rateApply, last: true, frac: 1 }); said(L, true); }
    else if (L.voice) { fallback(L, 'giọng ' + L.voice + ' không đọc được'); return; }
    else said(L, !!(res && res.ok !== false), res && res.err ? String(res.err) : '');
    L.ended = true; if (cur === L) playPart(); else if (L.parts.length) takeOver(L);
  }).catch((e) => { if (L.voice) { fallback(L, 'giọng lỗi: ' + (e && e.message)); return; } said(L, false, e && e.message); L.ended = true; if (cur === L) playPart(); });
}
function finish(L) { if (cur === L) { cur = null; audio = null; startNext(); } }
/* a waiting line has its voice: it is read as soon as nothing else is (never over or instead of the line being read) */
function takeOver(L) { if (!cur) startNext(); }
function speedOf(c) { return Math.max(1, Math.min(1.8, c.boost * (c.hurry || 1), 2.4 / Math.max(1, c.rate || 1))); }   /* never faster than 2.4x in all */
/* the speed a line starts at: faster the more lines wait behind it */
function backlogBoost() { return lines.length ? Math.min(1.6, 1.15 + 0.12 * lines.length) : 1; }
function cutCur() { const c = cur; if (!c) return; if (audio) { try { audio.pause(); } catch (e) { /* ignore */ } } audio = null; lineDrop(c); cur = null; }
function playPart() {
  const c = cur;
  if (!c || c.playing) return;
  const p = c.parts.shift();
  if (!p) { if (c.ended) finish(c); return; }
  c.playing = true; if (!c.startAt) { c.startAt = Date.now(); waits.push(c.startAt - c.at); if (waits.length > 30) waits.shift(); }
  audio = new Audio('data:' + (p.mime || 'audio/wav') + ';base64,' + p.wav);
  c.applyRate = !!(c.ai || p.rateApply);
  const sp = speedOf(c);
  audio.preservesPitch = c.pitch === 1;
  if (c.applyRate) audio.playbackRate = c.rate * c.pitch * sp;
  else if (c.pitch !== 1 || sp !== 1) audio.playbackRate = c.pitch * sp;
  const a = audio;
  /* the speed from the real length of the sound: the whole line must fit in the time the character talks (before: from
     a count of syllables, often too fast or too slow) */
  if (c.fit && !c.fitted && p.frac && c.applyRate) a.addEventListener('loadedmetadata', () => {
    if (cur !== c || audio !== a || c.fitted || !isFinite(a.duration) || a.duration <= 0) return;
    c.fitted = true;
    const total = a.duration / p.frac, left = Math.max(c.fit.floor || 1300, c.fit.due - Date.now()) / 1000;
    c.rate = Math.max(c.fit.base || 1, Math.min(2, total / left));
    a.playbackRate = c.rate * c.pitch * speedOf(c);
  });
  const done = () => { if (cur !== c || audio !== a) return; c.playing = false; audio = null; if (p.last) finish(c); else playPart(); };
  a.onended = done; a.onerror = done; a.play().catch(done);
}
function startNext() {
  if (cur) return;
  while (lines.length) {
    const L = lines.shift();
    if (L.dropped) continue;
    L.curAt = Date.now(); L.boost = Math.max(L.boost || 1, backlogBoost());
    cur = L; L.playing = false; playPart(); return;
  }
}
/* a new line arrived while one is being read: read the current one a little faster so the voice keeps up */
function hurry() {
  if (!cur) return;
  cur.hurry = Math.min(1.6, (cur.hurry || 1) * 1.25);
  if (audio) { const sp = speedOf(cur); audio.playbackRate = cur.applyRate ? cur.rate * cur.pitch * sp : cur.pitch * sp; }
}
function enqueue(L, queue) {
  if (!queue) stopAll();
  else {
    while (lines.length >= BACKLOG_MAX) lineDrop(lines.shift());
    if (cur) hurry();                                    /* the line being read goes faster: the next one is waiting */
    lines.forEach((x) => { x.boost = Math.max(x.boost || 1, 1.15 + 0.12 * lines.length); });
  }
  prepare(L); lines.push(L); startNext();
}
ipcRenderer.on('aiv-audio', (e, m) => {
  const L = (cur && cur.id === m.id) ? cur : lines.find(x => x.id === m.id);
  if (!L || L.fell) return;   /* already read by this computer's voice */
  if (m.type === 'error') { if (!L.got) { fallback(L, 'giọng AI lỗi'); return; } L.ended = true; if (cur === L && !L.playing) playPart(); return; }   /* the AI voice failed before saying anything: this computer's voice reads it */
  if (m.type !== 'audio') return;
  if (!L.got) said(L, true); L.got = true;
  L.parts.push({ wav: m.wav, last: !!m.last }); if (m.last) L.ended = true;
  if (cur === L) playPart(); else takeOver(L);
});

/* TV Samsung without Tizen Studio (Windows and Mac): the same lines and events as the phone apps' core (see tzraw.js) */
const tzRaw = (() => {
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
    })();
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
    say: (ip, msg) => ipcRenderer.invoke('tv-say', ip, msg),
    audio: (ip, bytes) => ipcRenderer.send('tv-audio', ip, bytes)
  },
  onFull: (cb) => ipcRenderer.on('full', (e, d) => cb(d)),
  onZone: (cb) => ipcRenderer.on('zone', (e, d) => cb(d)),
  zoneSize: (id, w, h) => ipcRenderer.send('zone-size', id, w, h),
  zonesReset: () => ipcRenderer.invoke('zones-reset'),
  zonesPanel: (on) => ipcRenderer.invoke('zones-panel', on),
  voices: () => ipcRenderer.invoke('voices'),
  /* queue=true for subtitles (wait for the line being read), false for samples and tests (cut in right away) */
  speakState: () => (lastSpeak ? Object.assign({}, lastSpeak, { cho: waits.length ? Math.round(waits.slice().sort((x, y) => x - y)[waits.length >> 1]) : null, choMax: waits.length ? Math.max.apply(null, waits) : null, dangCho: lines.length }) : lastSpeak),
  /* fit: {due: when the character stops talking (ms), floor: the least time to give the line (ms), base: the speed set in the app} */
  speak: async (text, voice, rate, pitch, queue, fit) => {
    if (!text) { stopAll(); return; }
    const v = String(voice || '');
    enqueue({ text, ai: v.startsWith('ai:'), voice: v.startsWith('ai:') ? v.slice(3) : v, rate: rate || 1, pitch: pitch || 1, boost: 1, fit: fit && fit.due ? fit : null }, queue);
  },
  /* make the voice of a line expected next, now (it is kept; speak() and voiceClip() then answer at once) */
  voiceWarm: (text, voice, clip) => {
    const v = String(voice || ''); text = String(text || '').trim(); if (!text) return Promise.resolve(false);
    if (clip || v.startsWith('ai:')) return ipcRenderer.invoke('voice-warm', 'C', text, v);
    return Promise.all(splitLine(text).map((t) => ipcRenderer.invoke('voice-warm', 'S', t, v)));
  },
  voiceSettings: () => ipcRenderer.send('voice-settings'),
  az: {
    set: (key, region) => ipcRenderer.invoke('az-set', key, region),
    state: () => ipcRenderer.invoke('az-state'),
    test: () => ipcRenderer.invoke('az-test')
  },
  netInfo: (tvIp) => ipcRenderer.invoke('net-info', tvIp || ''),
  voiceClip: (text, voice) => ipcRenderer.invoke('voice-clip', text, voice),
  /* play a clip made by voiceClip here too (same queue as the subtitles read aloud) */
  playClip: (clip, rate, pitch, queue, fit) => {
    if (!clip || !clip.b64) return;
    enqueue({ text: '', ai: false, pre: { b64: clip.b64, mime: clip.mime }, rate: rate || 1, pitch: pitch || 1, boost: 1, fit: fit && fit.due ? fit : null }, queue);
  },
  llm: {
    state: () => ipcRenderer.invoke('llm-state'),
    install: () => ipcRenderer.invoke('llm-install'),
    on: (v) => ipcRenderer.invoke('llm-on', v),
    remove: () => ipcRenderer.invoke('llm-remove'),
    chat: (body) => ipcRenderer.invoke('llm-chat', body),
    onState: (cb) => ipcRenderer.on('llm-state', (e, s) => cb(s))
  },
  aiv: {
    state: () => ipcRenderer.invoke('aiv-state'),
    install: () => ipcRenderer.invoke('aiv-install'),
    start: () => ipcRenderer.invoke('aiv-start'),
    fast: (on) => ipcRenderer.invoke('aiv-fast', on),
    remove: () => ipcRenderer.invoke('aiv-remove'),
    clone: (o) => ipcRenderer.invoke('aiv-clone', o),
    unclone: (name) => ipcRenderer.invoke('aiv-unclone', name),
    onState: (cb) => ipcRenderer.on('aiv-state', (e, s) => cb(s))
  },
  update: () => ipcRenderer.invoke('update'),
  updateNotes: (from, to) => ipcRenderer.invoke('update-notes', from, to),
  version: () => ipcRenderer.invoke('app-version'),
  getJson: (u) => ipcRenderer.invoke('get-json', u),
  netReq: (u, o) => ipcRenderer.invoke('net-req', u, o),
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
    raw: tzRaw,
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
api.tzraw = tzRaw;   /* kept on the Mac too, where the PS5 part is left out */
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
