'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
/* Mac: replace the app by itself.
   The new disk image is opened out of sight, the new Hóng Sub is copied next to the one running (same folder, so the
   swap is instant), then a small script waits for Hóng Sub to close, swaps the two and opens the new one. The
   Screen Recording permission stays (the app keeps the same designated requirement from 1.0.177 on). When Hóng Sub
   runs from a place it may not write to (straight from the disk image, a read-only folder), it goes to
   Applications instead, if Hóng Sub may write there. */
function macRun(cmd, args, ms) {
  return new Promise((ok, bad) => {
    require('child_process').execFile(cmd, args, { timeout: ms || 120000, maxBuffer: 4 << 20 }, (e, so, se) => (e ? bad(new Error((se || e.message || '').toString().trim().slice(0, 300))) : ok(String(so || ''))));
  });
}
async function prepare(dmg, cur) {
  if (!/\.app$/.test(cur)) return { ok: false, err: 'không thấy gói app' };
  const writable = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch (e) { return false; } };
  let dest = cur;
  if (/\/AppTranslocation\/|^\/Volumes\//.test(cur) || !writable(path.dirname(cur)) || !writable(cur)) {
    if (!writable('/Applications')) return { ok: false, err: 'không có quyền ghi vào thư mục của app' };
    dest = path.join('/Applications', path.basename(cur));
    if (fs.existsSync(dest) && !writable(dest)) return { ok: false, err: 'không có quyền ghi vào Applications' };
  }
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'hsupd-'));
  await macRun('/usr/bin/hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mnt, dmg], 180000);
  let stage = '';
  try {
    const appName = fs.readdirSync(mnt).find((f) => /\.app$/.test(f));
    if (!appName) throw new Error('trong file cài không có app');
    stage = path.join(path.dirname(dest), '.' + path.basename(dest, '.app') + '-new-' + Date.now() + '.app');
    await macRun('/usr/bin/ditto', [path.join(mnt, appName), stage], 300000);
    try { await macRun('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', stage], 60000); } catch (e) { /* none */ }
    await macRun('/usr/bin/codesign', ['--verify', '--deep', stage], 120000);
  } catch (e) {
    try { await macRun('/usr/bin/hdiutil', ['detach', mnt, '-force', '-quiet'], 30000); } catch (x) { /* ignore */ }
    if (stage) try { fs.rmSync(stage, { recursive: true, force: true }); } catch (x) { /* ignore */ }
    throw e;
  }
  try { await macRun('/usr/bin/hdiutil', ['detach', mnt, '-force', '-quiet'], 30000); } catch (x) { /* ignore */ }
  try { fs.unlinkSync(dmg); } catch (x) { /* ignore */ }
  const sh = path.join(os.tmpdir(), 'hong-sub-update.sh');
  fs.writeFileSync(sh, [
    '#!/bin/sh',
    'PID="$1"; NEW="$2"; DEST="$3"',
    'i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 120 ]; do sleep 0.5; i=$((i+1)); done',
    'OLD="$DEST.old-$$"',
    'if [ -d "$DEST" ]; then mv "$DEST" "$OLD" || { open "$DEST"; exit 1; }; fi',
    'if mv "$NEW" "$DEST"; then rm -rf "$OLD"; else [ -d "$OLD" ] && mv "$OLD" "$DEST"; fi',
    'open "$DEST"',
    'rm -f "$0"'
  ].join('\n') + '\n', { mode: 0o755 });
  return { ok: true, dest, stage, script: sh };
}

module.exports = { prepare };
