"""Build the Windows app page: the desktop layout (shell.html) + the translating engine and styles
from the Hóng Sub web page, plus the on-device text reader files."""
import sys, re, pathlib, shutil
root = pathlib.Path(__file__).parent
src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'web.html'
web = src.read_text(encoding='utf-8')
if src.resolve() != (root / 'web.html').resolve():
    (root / 'web.html').write_text(web, encoding='utf-8')     # keep a copy of the web page the app was built from
css = web[web.index('<style>') + 7:web.index('</style>')]
engine = '\n'.join('<script>' + js + '</script>' for js in re.findall(r'<script>([\s\S]*?)</script>', web))
shell = (root / 'shell.html').read_text(encoding='utf-8')
assert '/*WEBCSS*/' in shell and '<!--ENGINE-->' in shell
page = shell.replace('/*WEBCSS*/', css).replace('<!--ENGINE-->', engine)
out = root / 'app' / 'index.html'
out.parent.mkdir(exist_ok=True)
out.write_text(page, encoding='utf-8')
shutil.copy(root / 'desk.js', root / 'app' / 'desk.js')
# every element the engine looks up must exist in the desktop layout
ids = set(re.findall(r"\$\('([A-Za-z0-9_]+)'\)", engine)) | set(re.findall(r"getElementById\('([A-Za-z0-9_]+)'\)", engine))
have = set(re.findall(r'id="([^"]+)"', page))
missing = sorted(i for i in ids if i not in have and i not in ('vi', 'en', 'hsPsIn', 'hsPsOut', 'hsPsPass', 'hsPsPassGo', 'hsCastClear'))
if missing:
    raise SystemExit('desktop layout is missing ids: ' + ', '.join(missing))
ocr = root / 'app' / 'ocr'
ocr.mkdir(exist_ok=True)
for f in ['det.onnx', 'rec.onnx', 'keys.txt', 'LICENSE-Apache-2.0.txt']:
    shutil.copy(root.parent / 'web' / 'ocr' / f, ocr / f)
ort = root / 'node_modules' / 'onnxruntime-web' / 'dist'
for f in ['ort.wasm.min.js', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']:
    if (ort / f).exists():
        shutil.copy(ort / f, ocr / f)
    else:
        print('missing', f, '(run npm install first)')
print('wrote', out, len(page))
