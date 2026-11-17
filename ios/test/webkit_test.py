"""CI check on macOS: the iPhone page in real WebKit, served by the Remote Play core the way the iPhone app does it,
gets a test H.264 picture through the core's WebSocket and decodes it (WebCodecs).
   python3 webkit_test.py <hsrp-test binary> <web root> <sample.h264>"""
import asyncio, subprocess, sys, time
from playwright.async_api import async_playwright
BIN, ROOT, SAMPLE = sys.argv[1], sys.argv[2], sys.argv[3]
async def main():
    core = subprocess.Popen([BIN, '47124', 'tok', ROOT], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    print('core port', core.stdout.readline().decode().strip())
    ok = False
    try:
        async with async_playwright() as p:
            b = await p.webkit.launch()
            ctx = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=3)
            pg = await ctx.new_page(); errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
            await pg.add_init_script("window.HSIOS={port:47124,token:'tok',ver:'test'}; window.webkit=window.webkit||{}; window.webkit.messageHandlers={hs:{postMessage:function(m){ if(m.cmd==='psnLogin') setTimeout(function(){ hsNat(m.id,{ok:true,account:'AQIDBAUGBwg=',onlineId:'ci'}); },50); }}};")
            await pg.goto('http://127.0.0.1:47124/index.html'); await pg.wait_for_timeout(3000)
            print('VideoDecoder', await pg.evaluate("typeof VideoDecoder"), 'class', await pg.evaluate("document.documentElement.className"))
            print('core', await pg.evaluate("hsPsApi.dps.ping()"))
            await pg.evaluate("hsPsApi.login()"); await pg.wait_for_timeout(300)
            print('login', await pg.evaluate("document.getElementById('hsPsAcc').innerText.replace(/\\n/g,' ')"))
            await pg.evaluate("hsPsApi.PS.host={id:'X',name:'CI'}; hsPsApi.view(); hsPsApi.dps.raw('feed %s 30')" % SAMPLE)
            await pg.wait_for_timeout(4000)
            r = await pg.evaluate("(function(PS){return {packets:PS.pk,frames:PS.frames,codec:PS.codec,w:PS.cvs&&PS.cvs.width}})(hsPsApi.PS)")
            print('picture', r, 'errors', errs)
            await pg.screenshot(path='webkit-ios.png')
            ok = r['packets'] > 0
            print('DECODED' if r['frames'] > 0 else 'NOT DECODED')
            await b.close()
    finally:
        core.kill()
    sys.exit(0 if ok else 1)
asyncio.run(main())
