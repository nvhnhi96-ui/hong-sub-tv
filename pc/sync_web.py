"""Copy the Hóng Sub web page into the Windows app and add the on-device text reader."""
import sys, pathlib
src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/home/claude/hongsub/index.html')
s = src.read_text(encoding='utf-8')
tag = '<script src="../node_modules/tesseract.js/dist/tesseract.min.js"></script>\n</head>'
assert '</head>' in s
s = s.replace('</head>', tag, 1)
out = pathlib.Path(__file__).parent / 'app' / 'index.html'
out.parent.mkdir(exist_ok=True)
out.write_text(s, encoding='utf-8')
print('wrote', out, len(s))
