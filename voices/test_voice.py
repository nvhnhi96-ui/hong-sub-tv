"""Build-time check: start hs_voice.py, list voices, time a few lines, save samples."""
import sys, os, json, subprocess, time, base64
here = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'samples')
prec = sys.argv[2] if len(sys.argv) > 2 else 'fp32'
os.makedirs(out, exist_ok=True)
env = dict(os.environ, HS_VOICE_PREC=prec, PYTHONIOENCODING='utf-8')
p = subprocess.Popen([sys.executable, os.path.join(here, 'hs_voice.py')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, text=True, encoding='utf-8')
def rd():
    while True:
        l = p.stdout.readline()
        if not l:
            raise SystemExit('voice engine stopped')
        try:
            return json.loads(l)
        except Exception:
            print('noise:', l.strip()[:200])
t0 = time.time(); r = rd(); print('READY', prec, r.get('ms'), 'ms', len(r.get('voices', [])), 'voices')
if r.get('type') != 'ready':
    print(r); raise SystemExit(1)
for v in r['voices']:
    print('  voice', v['id'], v['gender'], v['region'], v['desc'])
lines = ['Chúng ta phải rời khỏi đây trước khi trời sáng.', 'Bám sát vào. Cây cầu này không trụ được lâu đâu.', 'Ta đã nói rồi, nơi này bị nguyền rủa!']
picks = [v['id'] for v in r['voices'][:4]]
n = 0
for vi, voice in enumerate(picks):
    for li, text in enumerate(lines):
        n += 1
        t1 = time.time()
        p.stdin.write(json.dumps({'cmd': 'speak', 'id': n, 'text': text, 'voice': voice}, ensure_ascii=False) + '\n'); p.stdin.flush()
        first = None; total = 0
        while True:
            m = rd()
            if m.get('type') == 'error':
                print('ERROR', m); break
            if m.get('type') != 'audio' or m.get('id') != n:
                continue
            if first is None:
                first = time.time() - t1
            total += m['sec']
            if vi < 2:
                open(os.path.join(out, f'{prec}-{vi}-{li}.wav'), 'ab' if m['i'] else 'wb').write(base64.b64decode(m['wav']))
            if m['last']:
                break
        print(f'{prec} {voice}: first audio {first:.2f}s, speech {total:.2f}s, all done {time.time()-t1:.2f}s, RTF {(time.time()-t1)/max(total,0.01):.2f}')
p.stdin.write('{"cmd":"quit"}\n'); p.stdin.flush()
