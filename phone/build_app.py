#!/usr/bin/env python3
"""Build the phone page (Android and iPhone apps): the same page as the Windows app (pc/app/index.html, made by
pc/sync_web.py) with the Windows-only layout switched off, desk.js inlined and the phone design (phone/phone.css).
Usage: python3 pc/sync_web.py && python3 phone/build_app.py  -> phone/src/main/assets/app.html"""
import pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
src = ROOT / 'pc' / 'app' / 'index.html'
out = ROOT / 'phone' / 'src' / 'main' / 'assets' / 'app.html'
t = src.read_text(encoding='utf-8')


def rep(a, b, n=1):
    global t
    if t.count(a) != n:
        sys.exit('phone build: expected %d of %r, found %d' % (n, a[:70], t.count(a)))
    t = t.replace(a, b)


# not the Windows app: the web/phone parts show, the Windows-only parts hide (body:not(.desk) .dk-only)
rep('<body class="desk">', '<body>')
# the page is loaded from text in the app: desk.js goes inside it
desk = (ROOT / 'pc' / 'desk.js').read_text(encoding='utf-8')
rep('<script src="desk.js"></script>', '<script>\n' + desk.replace('</script>', '<\\/script>') + '\n</script>')
# the phone design, after every other style so it wins
css = (ROOT / 'phone' / 'phone.css').read_text(encoding='utf-8')
rep('</head>', '<style id="hsPhoneCss">\n' + css + '\n</style>\n</head>')
rep('<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="theme-color" content="#0E1115">')
# the settings chips sit right under the top bar, whatever its height
rep('</body>', '<script>(function(){ function f(){ var t=document.querySelector(".dk-top"); if(t) document.documentElement.style.setProperty("--hs-topH",Math.round(t.getBoundingClientRect().bottom)+"px"); }'
    ' window.addEventListener("resize",f); setInterval(f,800); f(); })();</script>\n</body>')
out.write_text(t, encoding='utf-8')
print('wrote', out, len(t))
