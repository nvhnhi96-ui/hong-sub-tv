"""Copy the on-device text reader (same files as Hóng Sub) into the test app."""
import pathlib, shutil
root = pathlib.Path(__file__).parent
ocr = root / 'ui' / 'ocr'
ocr.mkdir(parents=True, exist_ok=True)
for f in ['det.onnx', 'rec.onnx', 'keys.txt', 'LICENSE-Apache-2.0.txt']:
    shutil.copy(root.parent / 'web' / 'ocr' / f, ocr / f)
ort = root / 'node_modules' / 'onnxruntime-web' / 'dist'
for f in ['ort.wasm.min.js', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']:
    shutil.copy(ort / f, ocr / f)
print('ok', sorted(p.name for p in ocr.iterdir()))
