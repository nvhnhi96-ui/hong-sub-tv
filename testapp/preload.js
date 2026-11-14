const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hsTest', {
  sys: () => ipcRenderer.invoke('sys'),
  fetch: (url, opt) => ipcRenderer.invoke('fetch', url, opt),
  discover: (ip) => ipcRenderer.invoke('discover', ip),
  tcp: (host, port) => ipcRenderer.invoke('tcp', host, port),
  voicesWin: () => ipcRenderer.invoke('voices-win'),
  hongsub: () => ipcRenderer.invoke('hongsub'),
  sources: () => ipcRenderer.invoke('sources'),
  saveReport: (text, name) => ipcRenderer.invoke('save-report', text, name),
  open: (url) => ipcRenderer.invoke('open', url),
  version: () => ipcRenderer.invoke('version'),
  /* panel -> game */
  game: (c) => ipcRenderer.send('game-cmd', c),
  onGame: (fn) => ipcRenderer.on('game-event', (e, ev) => fn(ev)),
  /* game -> panel */
  event: (ev) => ipcRenderer.send('game-event', ev),
  onCmd: (fn) => ipcRenderer.on('game-cmd', (e, c) => fn(c)),
  fullscreen: (on) => ipcRenderer.send('game-full', on)
});
