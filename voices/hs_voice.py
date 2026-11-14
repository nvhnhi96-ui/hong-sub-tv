"""Hóng Sub: Vietnamese AI voices (VieNeu-TTS v3 Turbo, Apache-2.0 code) running on the CPU.
Reads one JSON command per line on stdin, writes one JSON message per line on stdout.
  {"cmd":"speak","id":7,"text":"...","voice":"Trúc Ly"}  -> {"type":"audio","id":7,"i":0,"last":false,"wav":"<base64>"}...
  {"cmd":"stop"}  /  {"cmd":"quit"}"""
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
    send({'type': 'ready', 'ms': int((time.time() - t0) * 1000), 'voices': voices, 'sr': sr, 'prec': prec})

    cur = {'id': None}
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
                cur['id'] = m.get('id'); jobs.put(m)
            elif c == 'stop':
                cur['id'] = None
            elif c == 'quit':
                os._exit(0)
        os._exit(0)
    threading.Thread(target=reader, daemon=True).start()

    while True:
        m = jobs.get()
        if m.get('id') != cur['id']:
            continue
        parts = split_text(m.get('text', ''))
        for i, p in enumerate(parts):
            if m.get('id') != cur['id']:
                break
            t1 = time.time()
            try:
                wav = tts.infer(p, voice=m.get('voice') or None)
            except Exception as e:
                send({'type': 'error', 'id': m.get('id'), 'err': str(e)[:300]}); break
            if m.get('id') != cur['id']:
                break
            wav = np.asarray(wav, dtype=np.float32)
            buf = io.BytesIO()
            sf.write(buf, wav, sr, format='WAV', subtype='PCM_16')
            send({'type': 'audio', 'id': m.get('id'), 'i': i, 'last': i == len(parts) - 1,
                  'ms': int((time.time() - t1) * 1000), 'sec': round(len(wav) / sr, 2),
                  'wav': base64.b64encode(buf.getvalue()).decode('ascii')})

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        import traceback
        send({'type': 'fatal', 'err': str(e)[:500], 'trace': traceback.format_exc()[-1500:]})
        sys.exit(1)
