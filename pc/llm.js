/* On-device translation ("AI dịch trên máy"): llama.cpp's llama-server running a small Qwen model on this computer.
   Both are downloaded on first use (the program from llama.cpp's GitHub releases, the model from Hugging Face),
   then translation needs no key, no quota and no internet. The graphics card is used when there is one (Vulkan on
   Windows, Metal on the Mac); otherwise it runs on the processor, more slowly. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const netMod = require('net');
const { spawn } = require('child_process');

const LLAMA_TAG = 'b12540';
/* the model can be changed for every app without a release: presets/llm.json on GitHub */
const MANIFEST = 'https://raw.githubusercontent.com/nvhnhi96-ui/hong-sub-tv/main/presets/llm.json';
const DEFAULT_MODEL = { id: 'qwen3.5-4b-q4', name: 'Qwen3.5 4B', file: 'Qwen3.5-4B-Q4_K_M.gguf', url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf', size: 2740000000, ctx: 4096 };

let E = null;   /* { app, net, getWin, cfg, saveCfg } */
const L = { proc: null, ready: false, busy: '', got: 0, total: 0, err: '', gpu: '', cpu: false, port: 0, startMs: 0, model: null, buf: '', tried: 0 };

function dir() { return path.join(process.env.LOCALAPPDATA || E.app.getPath('userData'), 'HongSub', 'llm'); }
function binName() { return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'; }
function asset() {
  if (process.platform === 'win32') return { file: 'llama-' + LLAMA_TAG + '-bin-win-vulkan-x64.zip', zip: true };
  if (process.platform === 'darwin') return { file: 'llama-' + LLAMA_TAG + '-bin-macos-' + (process.arch === 'arm64' ? 'arm64' : 'x64') + '.tar.gz', zip: false };
  return { file: 'llama-' + LLAMA_TAG + '-bin-ubuntu-x64.tar.gz', zip: false };
}
function findBin(root) {
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      const p = path.join(root, e.name);
      if (e.isFile() && e.name === binName()) return p;
      if (e.isDirectory()) { const f = findBin(p); if (f) return f; }
    }
  } catch (e) { /* missing */ }
  return '';
}
function modelInfo() { const m = E.cfg.llmModel; return m && m.file && m.url ? m : DEFAULT_MODEL; }
function modelPath() { return path.join(dir(), modelInfo().file); }
function bin() { const b = path.join(dir(), 'bin'); return fs.existsSync(path.join(dir(), 'bin.ok')) ? findBin(b) : ''; }
function hasModel() { try { return fs.statSync(modelPath()).size > 1e8; } catch (e) { return false; } }
function installed() { return !!bin() && hasModel(); }
function state() {
  const m = modelInfo();
  return { installed: installed(), running: !!L.proc, ready: L.ready, busy: L.busy, got: L.got, total: L.total, err: L.err, gpu: L.gpu, cpu: L.cpu,
    on: E.cfg.llmOn !== false, model: m.name, size: m.size, ram: Math.round(os.totalmem() / 1073741824), startMs: L.startMs };
}
function notify() { const w = E.getWin(); if (w && !w.isDestroyed()) w.webContents.send('llm-state', state()); }

/* the model to use: the manifest on GitHub, read when installing */
async function manifest() {
  try {
    const r = await E.net.fetch(MANIFEST + '?t=' + Math.floor(Date.now() / 36e5));
    if (!r.ok) return null;
    const j = await r.json();
    const m = j && j.model;
    if (m && m.file && m.url && /^https:\/\/huggingface\.co\//.test(m.url) && /^[\w.-]+\.gguf$/.test(m.file)) return m;
  } catch (e) { /* offline: the built-in choice */ }
  return null;
}

/* download to a file, continuing a broken download where it stopped */
async function download(url, dst, label) {
  let have = 0; try { have = fs.statSync(dst).size; } catch (e) { /* new */ }
  const headers = have ? { Range: 'bytes=' + have + '-' } : {};
  const r = await E.net.fetch(url, { headers });
  if (r.status === 416) return;   /* already complete */
  if (!r.ok) throw new Error('Không tải được ' + label + ' (HTTP ' + r.status + ')');
  const resumed = r.status === 206;
  if (!resumed) have = 0;
  const len = +r.headers.get('content-length') || 0;
  L.total = len ? have + len : 0; L.got = have; notify();
  const out = fs.createWriteStream(dst, { flags: resumed ? 'a' : 'w' });
  const reader = r.body.getReader(); let last = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (!out.write(Buffer.from(value))) await new Promise(res => out.once('drain', res));
      L.got += value.length;
      if (Date.now() - last > 500) { last = Date.now(); notify(); }
    }
  } finally { await new Promise(res => out.end(res)); }
  if (L.total && L.got < L.total) throw new Error('Tải ' + label + ' bị ngắt giữa chừng, bấm Tải lại để tải tiếp');
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    let er = '';
    const p = spawn(cmd, args, { windowsHide: true });
    p.stderr.on('data', d => { er += d; }); p.stdout.on('data', () => {});
    p.on('exit', c => c === 0 ? res() : rej(new Error('Giải nén lỗi (mã ' + c + ') ' + er.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200))));
    p.on('error', rej);
  });
}

async function install() {
  if (L.busy) return state();
  L.err = ''; L.got = 0; L.total = 0;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const free = (() => { try { const s = fs.statfsSync(dir()); return s.bavail * s.bsize; } catch (e) { return Infinity; } })();
    const m = (await manifest()) || modelInfo();
    if (!hasModelFile(m) && free < (m.size || 3e9) + 6e8) throw new Error('Ổ đĩa còn trống ' + (free / 1e9).toFixed(1) + ' GB, cần khoảng ' + ((m.size || 3e9) / 1e9 + 0.6).toFixed(1) + ' GB');
    /* the program */
    if (!bin()) {
      L.busy = 'bin'; notify();
      const a = asset(), tmp = path.join(E.app.getPath('temp'), a.file);
      try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
      await download('https://github.com/ggml-org/llama.cpp/releases/download/' + LLAMA_TAG + '/' + a.file, tmp, 'bộ chạy AI');
      L.busy = 'unzip'; notify();
      const b = path.join(dir(), 'bin');
      fs.rmSync(b, { recursive: true, force: true }); fs.mkdirSync(b, { recursive: true });
      if (process.platform === 'win32') {
        try { await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', tmp, '-C', b]); }
        catch (e1) { await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Expand-Archive -LiteralPath '" + tmp.replace(/'/g, "''") + "' -DestinationPath '" + b.replace(/'/g, "''") + "' -Force"]); }
      } else await run('/usr/bin/tar', ['-xzf', tmp, '-C', b]);
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      const f = findBin(b);
      if (!f) throw new Error('Gói bộ chạy AI thiếu ' + binName());
      if (process.platform !== 'win32') { try { fs.chmodSync(f, 0o755); } catch (e) { /* ignore */ } }
      fs.writeFileSync(path.join(dir(), 'bin.ok'), LLAMA_TAG);
    }
    /* the model */
    if (!hasModelFile(m)) {
      L.busy = 'model'; notify();
      const part = path.join(dir(), m.file + '.part');
      await download(m.url, part, 'mô hình AI');
      if (m.size && Math.abs(fs.statSync(part).size - m.size) > m.size * 0.02) throw new Error('File mô hình tải về không đủ dung lượng, bấm Tải lại');
      fs.renameSync(part, path.join(dir(), m.file));
      /* an older model file goes away */
      const old = modelInfo();
      if (old.file !== m.file) { try { fs.unlinkSync(path.join(dir(), old.file)); } catch (e) { /* none */ } }
    }
    E.cfg.llmModel = m; E.cfg.llmOn = true; E.saveCfg();
    L.busy = ''; notify();
    start();
  } catch (e) {
    L.busy = ''; L.err = String(e.message || e); notify();
  }
  return state();
}
function hasModelFile(m) { try { return fs.statSync(path.join(dir(), m.file)).size > 1e8; } catch (e) { return false; } }

function freePort() {
  return new Promise((res, rej) => { const s = netMod.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
function get(p, ms) {
  return new Promise((res) => {
    const rq = http.get({ host: '127.0.0.1', port: L.port, path: p, timeout: ms || 2000 }, (r) => { let b = ''; r.on('data', d => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b })); });
    rq.on('error', () => res({ status: 0 })); rq.on('timeout', () => { rq.destroy(); res({ status: 0 }); });
  });
}
/* what the program prints tells which graphics card it uses */
function readLog(s) {
  L.buf = (L.buf + s).slice(-20000);
  const m = s.match(/using device \w+ \(([^)]+)\)/) || s.match(/GPU name:\s+([^(\r\n]+)/);
  if (m && !L.gpu) { L.gpu = m[1].trim(); }
}
async function start(cpuOnly) {
  if (L.proc || !installed() || E.cfg.llmOn === false) return state();
  const b = bin(), m = modelInfo();
  L.ready = false; L.err = ''; L.gpu = ''; L.cpu = !!cpuOnly; L.buf = '';
  const t0 = Date.now();
  L.port = await freePort();
  const threads = String(Math.max(2, Math.min(8, (os.cpus() || []).length - 1)));
  const args = ['-m', modelPath(), '-c', String(m.ctx || 4096), '--host', '127.0.0.1', '--port', String(L.port), '-np', '1', '--jinja', '--reasoning', 'off', '-t', threads, '--no-webui'];
  if (cpuOnly) args.push('-ngl', '0', '--device', 'none'); else args.push('-ngl', '99');
  const env = Object.assign({}, process.env);
  if (process.platform !== 'win32') env.LD_LIBRARY_PATH = path.dirname(b);
  const proc = spawn(b, args, { cwd: path.dirname(b), windowsHide: true, env });
  L.proc = proc; notify();
  proc.stdout.on('data', d => readLog(String(d)));
  proc.stderr.on('data', d => readLog(String(d)));
  proc.on('error', (e) => { L.err = String(e.message || e); notify(); });
  proc.on('exit', (code) => {
    if (L.proc !== proc) return;
    L.proc = null; const was = L.ready; L.ready = false;
    /* the graphics driver failed: once more on the processor only */
    if (!cpuOnly && !was && code) { L.tried++; setTimeout(() => start(true), 500); return; }
    if (code && !L.err) L.err = 'AI trên máy dừng (mã ' + code + ')' + (/out of memory|failed to allocate|unable to allocate/i.test(L.buf) ? ': máy thiếu bộ nhớ' : '');
    notify();
  });
  for (let i = 0; i < 240 && L.proc === proc; i++) {
    const r = await get('/health', 1500);
    if (r.status === 200) {
      L.startMs = Date.now() - t0;
      /* a first short answer loads everything into the graphics card */
      await chat({ messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }).catch(() => {});
      if (L.proc === proc) { L.ready = true; if (!L.gpu) L.cpu = true; notify(); }
      break;
    }
    await new Promise(r2 => setTimeout(r2, 500));
  }
  return state();
}
function stop() { if (L.proc) { const p = L.proc; L.proc = null; L.ready = false; try { p.kill(); } catch (e) { /* ignore */ } notify(); } }

function chat(body) {
  return new Promise((res, rej) => {
    if (!L.proc || !L.port) { rej(new Error('AI trên máy chưa chạy')); return; }
    const data = Buffer.from(JSON.stringify(Object.assign({ cache_prompt: true, chat_template_kwargs: { enable_thinking: false } }, body || {})));
    const rq = http.request({ host: '127.0.0.1', port: L.port, path: '/v1/chat/completions', method: 'POST', timeout: 60000, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (r) => {
      let b = ''; r.setEncoding('utf8'); r.on('data', d => { b += d; });
      r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* bad */ } if (r.statusCode === 200 && j) res(j); else rej(new Error((j && j.error && j.error.message) || ('HTTP ' + r.statusCode))); });
    });
    rq.on('error', rej); rq.on('timeout', () => { rq.destroy(new Error('AI trên máy trả lời quá lâu')); });
    rq.end(data);
  });
}

function setup(o) {
  E = o;
  const { ipcMain } = o;
  ipcMain.handle('llm-state', () => state());
  ipcMain.handle('llm-install', () => install());
  ipcMain.handle('llm-on', (e, on) => { E.cfg.llmOn = !!on; E.saveCfg(); if (on) start(); else stop(); return state(); });
  ipcMain.handle('llm-remove', () => { stop(); E.cfg.llmOn = false; E.saveCfg(); setTimeout(() => { try { fs.rmSync(dir(), { recursive: true, force: true }); } catch (e) { /* ignore */ } notify(); }, 1200); return true; });
  ipcMain.handle('llm-chat', async (e, body) => {
    if (!L.ready) { if (!L.proc) start(); throw new Error('AI trên máy chưa sẵn sàng'); }
    const j = await chat(body);
    return { text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '', timings: j.timings || null };
  });
  if (installed() && E.cfg.llmOn !== false) setTimeout(() => start(), 4000);   /* after the window is up */
}

module.exports = { setup, stop, state, _test: { L, start, chat, install, dir } };
