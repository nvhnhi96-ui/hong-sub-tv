"""honggame.store/hstv: the Hóng Sub TV page (webos/index.html) for a TV's own web browser, no app to install.
Written into a WordPress page as a small loader that replaces the whole page with the TV page (no site header/footer).
The menu font is put inside the page; other subtitle fonts fall back to the TV's own fonts."""
import base64, pathlib, re, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
ver = sys.argv[1] if len(sys.argv) > 1 else '1.0.0'
h = (ROOT / 'webos' / 'index.html').read_text(encoding='utf-8')
h = h.replace("var VERSION='1.0.0';", "var VERSION='%s';" % ver, 1)
def inline(m):
    f = ROOT / 'webos' / m.group(1)
    if f.name.startswith('be-vietnam-pro-'):
        return 'url(data:font/woff2;base64,' + base64.b64encode(f.read_bytes()).decode() + ')'
    return 'url(about:blank)'
h = re.sub(r'url\((fonts/[^)]+\.woff2)\)', inline, h)
h = h.replace('<head>', '<head><meta name="robots" content="noindex">', 1)
import json
# the same way honggame.store/hong-sub carries its script (a data: script file): an inline script that decodes a long
# encoded blob and writes it over the page made the site's firewall drop the page
js = 'document.open();document.write(' + json.dumps(h) + ');document.close();'
b64 = base64.b64encode(js.encode('utf-8')).decode()
page = ('<!-- wp:html -->\n<style>html,body{background:#000!important}body>*{visibility:hidden}</style>\n'
        '<script data-no-optimize="1" data-no-defer="1" data-cfasync="false" src="data:text/javascript;charset=utf-8;base64,' + b64 + '"></script>\n<!-- /wp:html -->')
out = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else '/home/claude/wp/tv-page.txt')
out.write_text(page, encoding='utf-8')
pathlib.Path('/tmp/tvweb.html').write_text(h, encoding='utf-8')
print(out, len(page))
