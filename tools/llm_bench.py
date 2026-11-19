"""Benchmark small local models for Hóng Sub's on-device translation (runs in CI: needs internet).
Downloads llama.cpp's llama-server and each model, translates a few game lines with the same prompt the app uses,
prints the Vietnamese and the time per line."""
import json, os, subprocess, sys, tarfile, time, urllib.request

LLAMA = os.environ.get('LLAMA_TAG', 'b12540')
MODELS = [
    ('qwen3.5-4b', 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf'),
    ('qwen3-4b', 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf'),
    ('qwen3.5-2b', 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf'),
]
GAME = 'God of War Ragnarök'
NOTES = ('Thần thoại Bắc Âu. Kratos là cha, Atreus là con trai. Kratos gọi Atreus là "con" ("Boy" dịch là "nhóc"), xưng "ta"; '
         'Atreus gọi Kratos là "cha", xưng "con". Mimir (cái đầu biết nói) gọi Kratos là "người anh em", xưng "tôi". '
         'Freya là nữ thần, thù Kratos. Giữ nguyên: Midgard, Asgard, Ragnarök, Odin, Thor.')
LINES = [
    "ATREUS: Father, I don't think we should go to Asgard.",
    'KRATOS: Boy. We do not have a choice.',
    "MIMIR: Brother, if Odin finds out, we're all dead.",
    "I know you're angry. But you have to trust me on this.",
    "Stay close. Whatever happens, don't let go of my hand.",
    "FREYA: You took everything from me, Kratos!",
    "Press R1 to throw your axe.",
    "We'll need to find another way across the river before nightfall.",
]

def sysprompt(game, notes):
    """the same text the app sends (pc/web.html localPrompt)"""
    return ('You translate video game subtitles into natural spoken Vietnamese for a Vietnamese player.\n'
            + ('Game: ' + game + '\n' if game else '')
            + ('Characters and how they address each other in Vietnamese: ' + notes + '\n' if notes else '')
            + 'Rules: translate only the line after "Translate:". If it starts with a speaker name and a colon, that name tells who speaks: '
              'do not translate or repeat the name. Use the pronoun pairs from the notes and keep the ones used in the previous lines. '
              'Keep names, places and game terms in English. Keep the same sentences, order and punctuation. '
              'If the text is a button prompt or menu, translate it short. Reply with only the Vietnamese translation, nothing else.')

def fetch(url, dst):
    if os.path.exists(dst): return
    t = time.time(); urllib.request.urlretrieve(url, dst + '.part'); os.rename(dst + '.part', dst)
    print(f'downloaded {os.path.basename(dst)} {os.path.getsize(dst)/1e9:.2f} GB in {time.time()-t:.0f}s', flush=True)

def post(path, body, port):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=300) as r: return json.loads(r.read())

def main():
    os.makedirs('llm', exist_ok=True)
    tgz = f'llm/llama-{LLAMA}.tar.gz'
    fetch(f'https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA}/llama-{LLAMA}-bin-ubuntu-x64.tar.gz', tgz)
    with tarfile.open(tgz) as t: t.extractall('llm/bin')
    srv = next(os.path.join(r, f) for r, _, fs in os.walk('llm/bin') for f in fs if f == 'llama-server')
    os.chmod(srv, 0o755)
    print('cpus', os.cpu_count(), flush=True)
    for name, url in MODELS:
        gguf = 'llm/' + url.rsplit('/', 1)[1]
        try: fetch(url, gguf)
        except Exception as e: print(name, 'DOWNLOAD FAILED', e); continue
        port = 8099
        log = open(f'llm/{name}.log', 'w')
        p = subprocess.Popen([srv, '-m', gguf, '-c', '4096', '--host', '127.0.0.1', '--port', str(port), '-np', '1', '--jinja', '-ngl', '99'],
                             stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, LD_LIBRARY_PATH=os.path.dirname(srv)))
        t0 = time.time()
        while time.time() - t0 < 180:
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=2).read(); break
            except Exception: time.sleep(1)
        print(f'\n=== {name}: server up in {time.time()-t0:.1f}s', flush=True)
        hist = []
        sp = sysprompt(GAME, NOTES)
        for line in LINES:
            user = ('Previous lines:\n' + '\n'.join(f'{e} => {v}' for e, v in hist[-3:]) + '\n' if hist else '') + 'Translate:\n' + line
            body = {'messages': [{'role': 'system', 'content': sp}, {'role': 'user', 'content': user}],
                    'temperature': 0.3, 'top_p': 0.8, 'top_k': 20, 'max_tokens': 160, 'cache_prompt': True,
                    'chat_template_kwargs': {'enable_thinking': False}}
            t = time.time()
            try: j = post('/v1/chat/completions', body, port)
            except Exception as e: print('  ERR', e); break
            ms = (time.time() - t) * 1000
            out = j['choices'][0]['message'].get('content', '').strip()
            tm = j.get('timings', {})
            print(f'  {ms:6.0f}ms  pp {tm.get("prompt_n")}tok {tm.get("prompt_per_second", 0):.0f}/s  gen {tm.get("predicted_n")}tok {tm.get("predicted_per_second", 0):.1f}/s', flush=True)
            print(f'    EN: {line}\n    VI: {out}', flush=True)
            hist.append((line, out))
        p.terminate(); p.wait(); os.remove(gguf)
        print(open(f'llm/{name}.log').read()[-600:])

if __name__ == '__main__':
    main()
