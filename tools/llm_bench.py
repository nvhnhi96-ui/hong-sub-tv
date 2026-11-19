"""Benchmark small local models for Hóng Sub's on-device translation (runs in CI: needs internet).
Downloads llama.cpp's llama-server and each model, translates a few game lines with the same prompt the app uses,
prints the Vietnamese and the time per line."""
import json, os, subprocess, sys, tarfile, time, urllib.request

LLAMA = os.environ.get('LLAMA_TAG', 'b12540')
MODELS = [
    ('qwen3.5-4b', 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf'),
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

GAME2 = "Marvel's Spider-Man 2"
NOTES2 = ('Peter Parker và Mary Jane (MJ) là người yêu: Peter xưng "anh", gọi MJ là "em"; MJ xưng "em", gọi Peter là "anh". '
          'Miles Morales là học trò của Peter: Miles gọi Peter là "anh Peter", xưng "em"; Peter gọi Miles là "nhóc" hoặc "em". '
          'Kraven là thợ săn, kẻ thù, xưng "ta", gọi Spider-Man là "ngươi". Giữ nguyên: Spider-Man, Venom, symbiote, New York.')
LINES2 = [
    "PETER: MJ, I'm sorry. I should have told you sooner.",
    "MJ: You don't get to decide that for me, Peter.",
    "MILES: Pete! Are you okay? You look terrible.",
    "KRAVEN: At last, a worthy prey. Show me what you are made of, Spider!",
    "Hold [R2] to swing faster.",
]

def split_speaker(t):
    import re
    m = re.match(r"^([A-Z][A-Za-z .'\-]{0,24}):\s+(.+)$", t, re.S)
    return (m.group(1), m.group(2)) if m else ('', t)

def sysprompt(game, notes, lang):
    """the text the app sends (pc/web.html localSys)"""
    if lang == 'vi':
        return ('Bạn dịch phụ đề game sang tiếng Việt nói tự nhiên, như lời thoại phim lồng tiếng.\n'
                + ('Game: ' + game + '\n' if game else '')
                + ('Nhân vật và cách xưng hô: ' + notes + '\n' if notes else '')
                + 'Quy tắc:\n- Chỉ dịch câu sau "Dịch:". Không viết tên người nói.\n'
                  '- Xưng hô đúng theo ghi chú và theo các câu trước (ai nói, nói với ai). Không dùng "bạn" trừ khi ghi chú bảo vậy.\n'
                  '- Giữ nguyên tiếng Anh cho tên riêng, địa danh, thuật ngữ game và tên nút bấm.\n'
                  '- Dịch đủ ý, đúng thứ tự câu và dấu câu, không thêm, không bớt, không giải thích.\n'
                  '- Chỉ trả lời bản dịch tiếng Việt.')
    return ('You translate video game subtitles into natural spoken Vietnamese, like a dubbed film.\n'
            + ('Game: ' + game + '\n' if game else '')
            + ('Characters and how they address each other in Vietnamese: ' + notes + '\n' if notes else '')
            + 'Rules:\n- Translate only the text after "Translate:". Never write the speaker name.\n'
              '- Use the Vietnamese pronouns the notes give for who is speaking to whom, and keep the ones used in the previous lines. Do not use "bạn" unless the notes say so.\n'
              '- Keep names, places, game terms and button names in English.\n'
              '- Translate everything, in the same order, with the same punctuation. Add nothing, explain nothing.\n'
              '- Reply with only the Vietnamese translation.')

def user_msg(hist, line):
    sp, t = split_speaker(line)
    h = ('Previous lines:\n' + '\n'.join(f'{e} => {v}' for e, v in hist[-3:]) + '\n') if hist else ''
    return h + (f'Speaker: {sp}\n' if sp else '') + 'Translate:\n' + t

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
        p = subprocess.Popen([srv, '-m', gguf, '-c', '4096', '--host', '127.0.0.1', '--port', str(port), '-np', '1', '--jinja', '--reasoning', 'off', '-ngl', '99'],
                             stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, LD_LIBRARY_PATH=os.path.dirname(srv)))
        t0 = time.time()
        while time.time() - t0 < 180:
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=2).read(); break
            except Exception: time.sleep(1)
        print(f'\n=== {name}: server up in {time.time()-t0:.1f}s', flush=True)
        for lang in ('en', 'vi'):
            for game, notes, lines in ((GAME, NOTES, LINES), (GAME2, NOTES2, LINES2)):
                print(f'--- prompt {lang} / {game}', flush=True)
                hist = []; sp = sysprompt(game, notes, lang); tot = 0
                for line in lines:
                    user = user_msg(hist, line)
                    if lang == 'vi': user = user.replace('Previous lines:', 'Các câu trước:').replace('Speaker:', 'Người nói:').replace('Translate:', 'Dịch:')
                    body = {'messages': [{'role': 'system', 'content': sp}, {'role': 'user', 'content': user}],
                            'temperature': 0.3, 'top_p': 0.8, 'top_k': 20, 'max_tokens': 160, 'cache_prompt': True,
                            'chat_template_kwargs': {'enable_thinking': False}}
                    t = time.time()
                    try: j = post('/v1/chat/completions', body, port)
                    except Exception as e: print('  ERR', e); break
                    ms = (time.time() - t) * 1000; tot += ms
                    out = j['choices'][0]['message'].get('content', '').strip()
                    tm = j.get('timings', {})
                    print(f'  {ms:6.0f}ms pp {tm.get("prompt_n")} gen {tm.get("predicted_n")} | {line}  =>  {out}', flush=True)
                    hist.append((line, out))
                print(f'  avg {tot/len(lines):.0f}ms', flush=True)
        p.terminate(); p.wait(); os.remove(gguf)
        print(open(f'llm/{name}.log').read()[-600:])

if __name__ == '__main__':
    main()
