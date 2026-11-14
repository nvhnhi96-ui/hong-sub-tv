"""Copy the Hóng Sub web page into the Windows app, with the on-device text reader files."""
import sys, pathlib, shutil
root = pathlib.Path(__file__).parent
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/home/claude/hongsub/index.html')
s = src.read_text(encoding='utf-8')
out = root / 'app' / 'index.html'
out.parent.mkdir(exist_ok=True)
out.write_text(s, encoding='utf-8')
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
print('wrote', out, len(s))
