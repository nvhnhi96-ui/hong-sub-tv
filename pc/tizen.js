'use strict';
/* TV Samsung: Hóng Sub on the computer puts its TV app on a Samsung TV.
   Samsung only takes apps from outside its store when they are signed with a Samsung certificate made for that TV,
   and only through Samsung's own tools (Tizen Studio). So the person installs Tizen Studio and makes the certificate once;
   everything after that is one button here: find the TV, check Developer Mode, sign the app with that certificate,
   install it, open it. The TV app already knows its code and this computer, so nothing has to be typed on the TV. */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dgram = require('dgram');

const PKG_ID = 'HongSubTv1.HongSub';
const WGT_URL = 'https://github.com/nvhnhi96-ui/hong-sub-tv/releases/latest/download/hong-sub-samsung.wgt';

/* where Tizen Studio usually is */
function roots(extra) {
  const home = os.homedir(), list = [];
  if (extra) list.push(extra);
  ['C:', 'D:', 'E:'].forEach((d) => list.push(d + '\\tizen-studio'));
  list.push(path.join(home, 'tizen-studio'));
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'tizen-studio'));
  return list;
}
function tools(extra) {
  for (const r of roots(extra)) {
    const sdb = path.join(r, 'tools', 'sdb.exe'), cli = path.join(r, 'tools', 'ide', 'bin', 'tizen.bat');
    if (fs.existsSync(sdb) && fs.existsSync(cli)) return { root: r, sdb, cli, data: r + '-data' };
  }
  return null;
}

/* certificate profiles made in Certificate Manager (tizen-studio-data/profile/profiles.xml) */
function profiles(t) {
  if (!t) return { list: [], active: '' };
  const f = path.join(t.data, 'profile', 'profiles.xml');
  let x = '';
  try { x = fs.readFileSync(f, 'utf8'); } catch (e) { return { list: [], active: '' }; }
  return parseProfiles(x);
}
function parseProfiles(x) {
  const active = (/<profiles[^>]*\sactive="([^"]*)"/.exec(x) || [])[1] || '';
  const list = [];
  const re = /<profile\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/profile>/g;
  let m;
  while ((m = re.exec(x))) {
    const body = m[2];
    /* a Samsung certificate (needed for TVs) names Samsung's certificate authority, not the plain Tizen one */
    const samsung = /samsung/i.test(body) && !/tizen-distributor-ca|tizen-developer-ca/i.test((/ca="([^"]*)"/.exec(body) || [])[1] || '');
    list.push({ name: m[1], samsung: samsung || /samsung/i.test(body) });
  }
  return { list, active };
}

/* Samsung TVs on the home network (they answer DIAL / Samsung discovery) */
function find() {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { resolve([]); return; }
    const done = () => { try { sock.close(); } catch (e) { /* ignore */ } resolve([...found.values()]); };
    sock.on('message', (msg, rinfo) => {
      const s = msg.toString();
      if (!/samsung|tizen/i.test(s) || found.has(rinfo.address)) return;
      found.set(rinfo.address, { ip: rinfo.address, name: 'TV Samsung ' + rinfo.address });
    });
    sock.on('error', done);
    sock.bind(0, () => {
      const q = (st) => Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ' + st + '\r\n\r\n');
      ['urn:samsung.com:device:RemoteControlReceiver:1', 'urn:dial-multiscreen-org:service:dial:1', 'ssdp:all'].forEach((st, i) =>
        setTimeout(() => { try { sock.send(q(st), 1900, '239.255.255.250'); } catch (e) { /* ignore */ } }, i * 300));
    });
    setTimeout(done, 3000);
  }).then(async (list) => {
    for (const tv of list) { const i = await info(tv.ip); if (i.ok && i.name) tv.name = i.name; tv.info = i; }
    return list;
  });
}

/* what the TV says about itself on port 8001: name, model, and whether Developer Mode is on and for which computer */
function info(ip) {
  return new Promise((resolve) => {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ''))) { resolve({ ok: false, err: 'ip' }); return; }
    const rq = http.get({ host: ip, port: 8001, path: '/api/v2/', timeout: 2500 }, (res) => {
      let x = ''; res.setEncoding('utf8');
      res.on('data', (d) => { x += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(x), d = j.device || {};
          resolve({ ok: true, name: String(d.name || j.name || '').replace(/^\[TV\]\s*/, ''), model: d.modelName || '', os: d.OS || '',
            dev: String(d.developerMode) === '1', devIp: String(d.developerIP || ''), tizen: /tizen/i.test(String(d.OS || j.type || '')) });
        } catch (e) { resolve({ ok: false, err: 'answer' }); }
      });
    });
    rq.on('timeout', () => { rq.destroy(); resolve({ ok: false, err: 'timeout' }); });
    rq.on('error', (e) => resolve({ ok: false, err: e.code || e.message }));
  });
}

/* this computer's addresses on the home network */
function myIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

function run(exe, args, ms, onLine) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = /\.bat$/i.test(exe) ? spawn('cmd.exe', ['/d', '/c', exe].concat(args), { windowsHide: true })   /* a .bat file runs through cmd */
        : spawn(exe, args, { windowsHide: true });
    } catch (e) { resolve({ code: -1, out: String(e.message || e) }); return; }
    const t = setTimeout(() => { try { p.kill(); } catch (e) { /* ignore */ } resolve({ code: -2, out: out + '\n(timeout)' }); }, ms || 120000);
    const take = (d) => { const s = d.toString(); out += s; if (onLine) s.split(/\r?\n/).forEach((l) => { if (l.trim()) onLine(l.trim()); }); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + String(e.message || e) }); });
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

/* plain Vietnamese for what Samsung's tools answer when something is wrong */
function explain(out) {
  const s = String(out || '');
  if (/certificate|signature|author|distributor|DUID|not match/i.test(s) && /fail|error|invalid|mismatch|not/i.test(s))
    return 'TV không nhận chứng chỉ. Chứng chỉ Samsung phải tạo khi TV đang nối với Tizen Studio (để có mã DUID của TV này). Mở Certificate Manager, tạo lại chứng chỉ Samsung với TV này rồi bấm Cài lại.';
  if (/refused|unable to connect|failed to connect|cannot connect|no device|not found/i.test(s))
    return 'Máy tính chưa nối được với TV. Kiểm tra Developer Mode trên TV đang bật và ô Host PC IP là đúng IP máy tính này, rồi tắt TV hẳn và bật lại.';
  if (/java|jre|jdk/i.test(s)) return 'Tizen Studio thiếu Java. Cài lại Tizen Studio bản có sẵn Java (bản "with IDE installer") rồi thử lại.';
  if (/profile/i.test(s)) return 'Chưa chọn được chứng chỉ. Mở Certificate Manager trong Tizen Studio, tạo chứng chỉ Samsung rồi bấm Kiểm tra lại.';
  return '';
}

function setup({ ipcMain, net, getWin, cfgDir, lanAddr }) {
  try { fs.mkdirSync(cfgDir, { recursive: true }); } catch (e) { /* ignore */ }
  const cfgFile = path.join(cfgDir, 'samsung.json');
  const cfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) { return {}; } };
  const saveCfg = (o) => { try { fs.writeFileSync(cfgFile, JSON.stringify(Object.assign(cfg(), o))); } catch (e) { /* ignore */ } };
  const say = (t) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('tz-progress', t); };

  async function state() {
    const t = tools(cfg().root), pr = profiles(t), k = cfg();
    return { tools: !!t, root: t ? t.root : '', profiles: pr.list, active: pr.active, ip: k.ip || '', installed: !!k.installed, at: k.at || 0, profile: k.profile || '', pcIps: myIps() };
  }

  async function install(ip, profile, code) {
    const t = tools(cfg().root);
    if (!t) return { ok: false, err: 'Chưa thấy Tizen Studio trên máy. Cài Tizen Studio (bước 2) rồi bấm Kiểm tra lại.' };
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip || ''))) return { ok: false, err: 'Gõ IP của TV Samsung, hoặc bấm Tìm TV Samsung.' };
    const pr = profiles(t);
    profile = profile || pr.active || (pr.list[0] || {}).name || '';
    if (!profile) return { ok: false, err: 'Chưa có chứng chỉ Samsung. Làm bước 3 (Certificate Manager) rồi bấm Kiểm tra lại.' };
    /* a short path with plain letters: Samsung's tools stumble on accented user names */
    const work = path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'HongSub', 'samsung'); const src = path.join(work, 'app'), outDir = path.join(work, 'out');
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    fs.mkdirSync(outDir, { recursive: true });

    say('Đang kiểm tra TV...');
    const i = await info(ip);
    if (i.ok && !i.dev) return { ok: false, err: 'TV chưa bật Developer Mode. Làm bước 1: Ứng dụng › bấm 1 2 3 4 5 › Developer mode On, Host PC IP gõ ' + (myIps()[0] || 'IP máy tính') + ', rồi rút điện TV 30 giây và bật lại.' };
    const rev = String(i.devIp || '').split('.').reverse().join('.');
    if (i.ok && i.devIp && myIps().indexOf(i.devIp) < 0 && myIps().indexOf(rev) >= 0) return { ok: false, err: 'TV lưu Host PC IP bị đảo ngược (' + i.devIp + '). Vào lại bảng Developer mode trên TV, gõ IP theo thứ tự ngược: ' + i.devIp.split('.').reverse().join('.').split('.').reverse().join('.') + ', rồi khởi động lại TV.' };
    if (i.ok && i.devIp && myIps().indexOf(i.devIp) < 0) return { ok: false, err: 'Developer Mode trên TV đang ghi Host PC IP là ' + i.devIp + ', không phải máy tính này (' + myIps().join(', ') + '). Sửa lại IP trên TV, tắt TV hẳn và bật lại.' };

    say('Đang tải app Hóng Sub cho TV Samsung...');
    const wgt = path.join(work, 'hong-sub-samsung.wgt');
    try {
      const r = await net.fetch(WGT_URL, { headers: { 'User-Agent': 'HongSub' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fs.writeFileSync(wgt, Buffer.from(await r.arrayBuffer()));
    } catch (e) { return { ok: false, err: 'Chưa tải được app (' + e.message + '). Kiểm tra mạng rồi thử lại.' }; }
    const ex = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Add-Type -A System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('" + wgt.replace(/'/g, "''") + "','" + src.replace(/'/g, "''") + "')"], 60000);
    if (!fs.existsSync(path.join(src, 'config.xml'))) return { ok: false, err: 'Không mở được gói app: ' + ex.out.slice(-200) };
    ['author-signature.xml', 'signature1.xml'].forEach((f) => { try { fs.unlinkSync(path.join(src, f)); } catch (e) { /* ignore */ } });
    /* the TV app starts already paired: same code as here, and the address of this computer on the home network */
    const pc = lanAddr ? await lanAddr() : '';
    fs.writeFileSync(path.join(src, 'preset.js'), 'window.HS_PRESET=' + JSON.stringify({ code: String(code || '').toUpperCase(), pc: pc || '' }) + ';\n');

    say('Đang nối với TV ' + ip + '...');
    await run(t.sdb, ['disconnect', ip + ':26101'], 15000);
    const c = await run(t.sdb, ['connect', ip + ':26101'], 30000);
    if (!/connected to/i.test(c.out) || /fail|unable|refused/i.test(c.out)) return { ok: false, err: explain(c.out) || ('Chưa nối được TV: ' + c.out.trim().slice(-200)) };
    const serial = ip + ':26101';

    say('Đang ký app bằng chứng chỉ "' + profile + '"...');
    const pk = await run(t.cli, ['package', '-t', 'wgt', '-s', profile, '-o', outDir, '--', src], 180000);
    const signed = (fs.readdirSync(outDir).filter((f) => /\.wgt$/i.test(f))[0]) || '';
    if (!signed) return { ok: false, err: explain(pk.out) || ('Chưa ký được app: ' + pk.out.trim().slice(-300)) };
    /* Samsung's tools name the file after the app ("Hóng Sub.wgt"); the accent and the space break the copy on the TV,
       so the file gets a plain name before it is sent */
    const WGT = 'HongSub.wgt';
    if (signed !== WGT) { try { fs.renameSync(path.join(outDir, signed), path.join(outDir, WGT)); } catch (e) { return { ok: false, err: 'Chưa đổi tên được gói app: ' + e.message }; } }

    const bad = (o) => /fail|error/i.test(o) && !/success|completed|installed/i.test(o);
    say('Đang cài lên TV...');
    let inst = await run(t.cli, ['install', '-n', WGT, '-s', serial, '--', outDir], 180000);
    if (bad(inst.out)) {
      /* an older Hóng Sub signed with another certificate blocks the new one: remove it, then install again */
      say('TV chưa nhận, gỡ bản Hóng Sub cũ trên TV rồi cài lại...');
      await run(t.cli, ['uninstall', '-p', PKG_ID.split('.')[0], '-s', serial], 90000);
      inst = await run(t.cli, ['install', '-n', WGT, '-s', serial, '--', outDir], 180000);
    }
    if (bad(inst.out)) {
      /* last try straight through sdb, which also says why the TV refused */
      say('Đang cài lại theo cách khác...');
      const remote = '/home/owner/share/tmp/sdk_tools/tmp/' + WGT;
      await run(t.sdb, ['-s', serial, 'shell', 'mkdir', '-p', '/home/owner/share/tmp/sdk_tools/tmp'], 30000);
      const push = await run(t.sdb, ['-s', serial, 'push', path.join(outDir, WGT), remote], 120000);
      const vd = await run(t.sdb, ['-s', serial, 'shell', '0', 'vd_appinstall', PKG_ID, remote], 180000);
      const out = inst.out + '\n' + push.out + '\n' + vd.out;
      if (!/install completed|result.*success|successfully|100%/i.test(vd.out) || /fail|error|refused/i.test(vd.out))
        return { ok: false, err: explain(out) || ('TV chưa nhận app. Thông báo của TV: ' + (vd.out.trim() || inst.out.trim()).slice(-300)) };
    }

    say('Đang mở Hóng Sub trên TV...');
    await run(t.cli, ['run', '-p', PKG_ID, '-s', serial], 60000);
    saveCfg({ ip, profile, installed: true, at: Date.now(), code: String(code || '') });
    return { ok: true };
  }

  async function launch() {
    const t = tools(cfg().root), k = cfg();
    if (!t || !k.ip) return { ok: false, err: 'Chưa cài app từ máy này.' };
    const serial = k.ip + ':26101';
    await run(t.sdb, ['connect', serial], 20000);
    const r = await run(t.cli, ['run', '-p', PKG_ID, '-s', serial], 60000);
    return { ok: !/fail|error/i.test(r.out), err: explain(r.out) || r.out.trim().slice(-200) };
  }

  ipcMain.handle('tz-state', () => state());
  ipcMain.handle('tz-find', () => find());
  ipcMain.handle('tz-info', (e, ip) => info(ip));
  ipcMain.handle('tz-install', (e, ip, profile, code) => install(ip, profile, code).catch((err) => ({ ok: false, err: String(err && err.message || err) })));
  ipcMain.handle('tz-launch', () => launch());
  ipcMain.handle('tz-root', (e, dir) => { if (dir && tools(dir)) { saveCfg({ root: dir }); return true; } return false; });
  return { state };
}

module.exports = { setup, parseProfiles, explain, roots };
