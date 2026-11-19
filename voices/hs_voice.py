"""Hóng Sub: Vietnamese AI voices (VieNeu-TTS v3 Turbo, Apache-2.0 code) running on the CPU.
Reads one JSON command per line on stdin, writes one JSON message per line on stdout.
  {"cmd":"speak","id":7,"text":"...","voice":"Trúc Ly"}  -> {"type":"audio","id":7,"i":0,"last":false,"wav":"<base64>"}...
  {"cmd":"stop"}  /  {"cmd":"quit"}  /  {"cmd":"drop","id":7}
  {"cmd":"clone","id":"c1","name":"Giọng Nhi","path":".../clones/c1.wav","gender":"male"} -> {"type":"cloned",...} or {"type":"clonefail",...}
  {"cmd":"unclone","name":"Giọng Nhi"} -> {"type":"voices","voices":[...]}
A cloned voice (a short clip of a person speaking, made by the person with their consent) is kept in clones/ next to
this file and enrolled again the first time it is used after a restart.
Lines are made in the order asked; several can wait, so the next line is ready while one is playing.
"stop" forgets every waiting line, "drop" forgets one."""
import sys, os, json, io, base64, time, threading, queue, re

HERE = os.path.dirname(os.path.abspath(__file__))
if os.path.isdir(os.path.join(HERE, 'hf')):
    os.environ['HF_HOME'] = os.path.join(HERE, 'hf')
    if os.environ.get('HS_VOICE_ONLINE') != '1':
        os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stdin.reconfigure(encoding='utf-8')
except Exception:
    pass

_out = threading.Lock()
def send(o):
    with _out:
        sys.stdout.write(json.dumps(o, ensure_ascii=False) + '\n')
        sys.stdout.flush()

def split_text(t):
    t = re.sub(r'\s+', ' ', t or '').strip()
    if not t:
        return []
    parts = [p for p in re.split(r'(?<=[.!?…])\s+', t) if p]
    out = []
    for p in parts:
        while len(p) > 140:                       # long sentence: cut at a comma near the middle
            cut = max(p.rfind(',', 0, 140), p.rfind(';', 0, 140))
            if cut < 30:
                break
            out.append(p[:cut + 1]); p = p[cut + 1:].strip()
        if p:
            out.append(p)
    return out

def main():
    import numpy as np
    import soundfile as sf
    t0 = time.time()
    from vieneu import Vieneu
    prec = os.environ.get('HS_VOICE_PREC', 'fp32')
    tts = Vieneu(backend='onnx', precision=prec, threads=int(os.environ.get('HS_VOICE_THREADS', '0') or 0))
    voices = []
    for label, vid in tts.list_preset_voices():
        meta = tts.get_preset_voice(vid) if hasattr(tts, 'get_preset_voice') else {}
        voices.append({'id': vid, 'gender': meta.get('gender', ''), 'region': meta.get('region', ''), 'desc': meta.get('description', '')})
    sr = getattr(tts, 'sample_rate', 48000)

    # ---- cloned voices ----
    cdir = os.path.join(HERE, 'clones')
    clones = {}                                    # name -> {'path','gender','ok'}
    try:
        for f in sorted(os.listdir(cdir)):
            if f.endswith('.json'):
                try:
                    meta = json.load(open(os.path.join(cdir, f), encoding='utf-8'))
                    wav = os.path.join(cdir, f[:-5] + '.wav')
                    if meta.get('name') and os.path.isfile(wav):
                        clones[meta['name']] = {'path': wav, 'gender': meta.get('gender', ''), 'ok': False, 'file': f[:-5]}
                except Exception:
                    pass
    except OSError:
        pass

    def all_voices():
        return voices + [{'id': n, 'gender': c['gender'], 'region': '', 'desc': 'Giọng nhân bản', 'clone': True} for n, c in clones.items()]

    def speaker_ready():
        """The voice-print model is only needed to clone: an older voice pack does not have it, fetch it once."""
        eng = getattr(tts, 'engine', None)
        if eng is None or getattr(eng, 'speaker_encoder', None) is not None or not hasattr(eng, '_ensure_speaker_encoder'):
            return
        try:
            eng._ensure_speaker_encoder(); return
        except Exception:
            pass
        import huggingface_hub.constants as hc
        was = hc.HF_HUB_OFFLINE
        hc.HF_HUB_OFFLINE = False; os.environ['HF_HUB_OFFLINE'] = '0'
        try:
            try:
                from huggingface_hub.utils import _http
                if hasattr(_http, 'reset_sessions'):
                    _http.reset_sessions()
            except Exception:
                pass
            eng._ensure_speaker_encoder()
        finally:
            hc.HF_HUB_OFFLINE = was; os.environ['HF_HUB_OFFLINE'] = '1' if was else '0'

    def enroll(name):
        c = clones[name]
        if c['ok']:
            return
        speaker_ready()
        tts.add_voice(name, c['path'], denoise=True, gender=c.get('gender', ''), description='Giọng nhân bản')
        c['ok'] = True

    send({'type': 'ready', 'ms': int((time.time() - t0) * 1000), 'voices': all_voices(), 'sr': sr, 'prec': prec})

    want = set()                                   # ids still wanted (a line being played, or waiting)
    jobs = queue.Queue()

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except Exception:
                continue
            c = m.get('cmd')
            if c == 'speak':
                want.add(m.get('id')); jobs.put(m)
            elif c in ('clone', 'unclone'):
                jobs.put(m)
            elif c == 'drop':
                want.discard(m.get('id'))
            elif c == 'stop':
                want.clear()
            elif c == 'quit':
                os._exit(0)
        os._exit(0)
    threading.Thread(target=reader, daemon=True).start()

    while True:
        m = jobs.get()
        mid = m.get('id')
        if m.get('cmd') == 'clone':
            name = str(m.get('name') or '').strip()[:32]
            path = str(m.get('path') or '')
            t1 = time.time()
            if not name or not os.path.isfile(path) or os.path.dirname(os.path.abspath(path)) != os.path.abspath(cdir):
                send({'type': 'clonefail', 'id': mid, 'err': 'arg'}); continue
            if name in clones:
                try:
                    tts.remove_voice(name)
                except Exception:
                    pass
            clones[name] = {'path': path, 'gender': m.get('gender', ''), 'ok': False, 'file': os.path.basename(path)[:-4]}
            try:
                enroll(name)
                with open(path[:-4] + '.json', 'w', encoding='utf-8') as f:
                    json.dump({'name': name, 'gender': m.get('gender', '')}, f, ensure_ascii=False)
                send({'type': 'cloned', 'id': mid, 'name': name, 'ms': int((time.time() - t1) * 1000), 'voices': all_voices()})
            except Exception as e:
                clones.pop(name, None)
                send({'type': 'clonefail', 'id': mid, 'err': str(e)[:300]})
            continue
        if m.get('cmd') == 'unclone':
            name = str(m.get('name') or '')
            c = clones.pop(name, None)
            if c:
                try:
                    tts.remove_voice(name)
                except Exception:
                    pass
                for ext in ('.wav', '.json'):
                    try:
                        os.remove(os.path.join(cdir, c['file'] + ext))
                    except OSError:
                        pass
            send({'type': 'voices', 'voices': all_voices()})
            continue
        if mid not in want:
            continue
        v = m.get('voice') or None
        if v in clones and not clones[v]['ok']:
            try:
                enroll(v)
            except Exception as e:
                send({'type': 'error', 'id': mid, 'err': 'clone: ' + str(e)[:280]}); want.discard(mid); continue
        parts = split_text(m.get('text', ''))
        for i, p in enumerate(parts):
            if mid not in want:
                break
            t1 = time.time()
            try:
                wav = tts.infer(p, voice=m.get('voice') or None)
            except Exception as e:
                send({'type': 'error', 'id': mid, 'err': str(e)[:300]}); break
            if mid not in want:
                break
            wav = np.asarray(wav, dtype=np.float32)
            buf = io.BytesIO()
            sf.write(buf, wav, sr, format='WAV', subtype='PCM_16')
            send({'type': 'audio', 'id': mid, 'i': i, 'last': i == len(parts) - 1,
                  'ms': int((time.time() - t1) * 1000), 'sec': round(len(wav) / sr, 2),
                  'wav': base64.b64encode(buf.getvalue()).decode('ascii')})
        want.discard(mid)

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        import traceback
        send({'type': 'fatal', 'err': str(e)[:500], 'trace': traceback.format_exc()[-1500:]})
        sys.exit(1)
