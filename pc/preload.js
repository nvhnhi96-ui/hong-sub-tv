'use strict';
// Bridge between the Hóng Sub page and the Windows app (main.js). Exposed as window.hsDesktop.
const { contextBridge, ipcRenderer } = require('electron');

const selftest = process.argv.includes('--hs-selftest');
let audio = null, seq = 0;

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
  voices: () => ipcRenderer.invoke('voices'),
  speak: async (text, voice, rate) => {
    const my = ++seq;
    if (audio) { audio.pause(); audio = null; }
    if (!text) return;
    const res = await ipcRenderer.invoke('speak', text, voice, rate);
    if (my !== seq || !res || !res.wav) return;
    audio = new Audio('data:audio/wav;base64,' + res.wav);
    audio.play().catch(() => {});
  },
  voiceSettings: () => ipcRenderer.send('voice-settings'),
  update: () => ipcRenderer.invoke('update')
});
