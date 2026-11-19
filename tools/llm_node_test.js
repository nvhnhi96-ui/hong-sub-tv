/* CI test of pc/llm.js outside Electron: download the program and the model, start it, translate a line.
   Run: node tools/llm_node_test.js  (needs internet; Linux, Windows or Mac runner) */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const handlers = {};
const sent = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsllm-'));
process.env.LOCALAPPDATA = tmp;
const cfg = {};
const E = {
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  app: { getPath: () => tmp },
  net: { fetch: (u, o) => fetch(u, o) },
  getWin: () => ({ isDestroyed: () => false, webContents: { send: (ch, s) => sent.push(s) } }),
  get cfg() { return cfg; },
  saveCfg: () => {}
};
const llm = require('../pc/llm.js');
llm.setup(E);
(async () => {
  const t0 = Date.now();
  let last = 0;
  const tick = setInterval(() => { const s = llm.state(); if (s.busy && Date.now() - last > 5000) { last = Date.now(); console.log('busy', s.busy, Math.round(s.got / 1e6), '/', Math.round(s.total / 1e6), 'MB'); } }, 1000);
  const st = await handlers['llm-install']();
  clearInterval(tick);
  console.log('install done in', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify(st));
  if (st.err) throw new Error(st.err);
  for (let i = 0; i < 240 && !llm.state().ready; i++) await new Promise(r => setTimeout(r, 500));
  const s2 = llm.state();
  console.log('state', JSON.stringify(s2));
  if (!s2.ready) { console.log(llm._test.L.buf.slice(-3000)); throw new Error('not ready'); }
  for (const line of ['Boy. We do not have a choice.', 'Stay close. Whatever happens, do not let go of my hand.']) {
    const t = Date.now();
    const r = await handlers['llm-chat'](null, { messages: [{ role: 'system', content: 'Translate the user text into natural Vietnamese. Reply with only the translation.' }, { role: 'user', content: line }], max_tokens: 80, temperature: 0.2 });
    console.log((Date.now() - t) + 'ms', line, '=>', r.text, JSON.stringify(r.timings && { pp: r.timings.prompt_n, gen: r.timings.predicted_n }));
    if (!/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(r.text)) throw new Error('no Vietnamese in the answer');
  }
  /* turning it off stops the program; on starts it again */
  await handlers['llm-on'](null, false);
  if (llm.state().running) throw new Error('still running after off');
  await handlers['llm-on'](null, true);
  for (let i = 0; i < 240 && !llm.state().ready; i++) await new Promise(r => setTimeout(r, 500));
  console.log('restarted ready:', llm.state().ready, 'gpu:', llm.state().gpu || '(cpu)');
  llm.stop();
  console.log('LLM OK');
  process.exit(0);
})().catch((e) => { console.error('LLM FAIL', e); try { llm.stop(); } catch (x) { /* ignore */ } process.exit(1); });
