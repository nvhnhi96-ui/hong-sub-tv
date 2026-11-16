#!/usr/bin/env python3
"""Hóng Sub for Samsung TVs (Tizen): built from the LG (webOS) app so both stay the same.
What differs on Samsung: the HDMI picture comes from tizen.tvwindow (shown behind a see-through page),
Back is key 10009, the app quits through tizen.application, and the TV's IP comes from webapis/systeminfo.
Usage: python3 tizen/build.py <version>   -> writes tizen/app/ (index.html, config.xml, icon.png, fonts/)"""
import pathlib, re, shutil, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'webos'
OUT = ROOT / 'tizen' / 'app'
ver = (sys.argv[1] if len(sys.argv) > 1 else '1.0.0').strip()
if not re.fullmatch(r'\d+\.\d+\.\d+', ver):
    sys.exit('version must look like 1.0.76')

t = (SRC / 'index.html').read_text(encoding='utf-8')

def rep(a, b, n=1):
    global t
    if t.count(a) != n:
        sys.exit('tizen build: expected %d of %r, found %d' % (n, a[:70], t.count(a)))
    t = t.replace(a, b)

rep("var VERSION='1.0.0';", "var VERSION='%s';" % ver)
# Samsung's own scripts (the IP of the TV); missing in a browser, harmless
rep('<script>\n', '<script src="$WEBAPIS/webapis/webapis.js"></script>\n<script>\n', 1)
rep("var packaged=location.protocol==='file:';", "var packaged=typeof tizen!=='undefined';   /* installed on a Samsung TV */")
# keys: Back on a Samsung remote is 10009
rep("if(k===461||k===27||k===8){ if($('home').className==='off'&&P.src)", "if(k===461||k===10009||k===27||k===8){ if($('home').className==='off'&&P.src)")
rep("else if(k===461||k===27||k===8){ panel(false); }", "else if(k===461||k===10009||k===27||k===8){ panel(false); }")
rep("'Hóng Sub '+VERSION+(packaged?' cho TV LG':' trên trình duyệt')", "'Hóng Sub '+VERSION+(packaged?' cho TV Samsung':' trên trình duyệt')")
rep("function quit(){ sayStop(); try{ if(window.webOS&&window.webOS.platformBack) window.webOS.platformBack(); else window.close(); }catch(e){ window.close(); } }",
    "function quit(){ sayStop(); try{ tizen.tvwindow.hide(function(){},function(){}); }catch(e){} try{ tizen.application.getCurrentApplication().exit(); }catch(e){ window.close(); } }")

TIZEN = r"""
/* ---------- Samsung (Tizen) ----------
   The HDMI picture is drawn by the TV itself in a window under the page: the page turns see-through where the game shows. */
function setSource(n){
  srcOk=false;
  try{ video.style.display='none'; }catch(e){}
  if(!n||!window.tizen||!tizen.tvwindow){ document.documentElement.className=''; try{ tizen.tvwindow.hide(function(){},function(){}); }catch(e){} if(!n) homeShow(); else srcFail(n); return; }
  tizen.tvwindow.setSource({type:'HDMI',number:n},function(){
    tizen.tvwindow.show(function(){ srcOk=true; document.documentElement.className='see'; homeHide(); },
      function(){ document.documentElement.className=''; srcFail(n); },['0px','0px',window.screen.width+'px',window.screen.height+'px'],'MAIN');
  },function(){ document.documentElement.className=''; srcFail(n); });
  homeBtns();
}
function gameSound(){}
function ipAsk(){
  try{ if(window.webapis&&webapis.network&&webapis.network.getIp){ ipShow(webapis.network.getIp()); return; } }catch(e){}
  try{ tizen.systeminfo.getPropertyValue('ETHERNET_NETWORK',function(n){ if(n&&n.ipAddress) ipShow(n.ipAddress); },function(){}); }catch(e){}
  try{ tizen.systeminfo.getPropertyValue('WIFI_NETWORK',function(n){ if(n&&n.ipAddress) ipShow(n.ipAddress); },function(){}); }catch(e){}
}
try{ ['ColorF0Red','ColorF1Green','ColorF2Yellow','ColorF3Blue','Info','1','2','3','4'].forEach(function(k){ try{ tizen.tvinputdevice.registerKey(k); }catch(e){} }); }catch(e){}
document.addEventListener('visibilitychange',function(){ if(document.hidden){ try{ tizen.tvwindow.hide(function(){},function(){}); }catch(e){} } });
"""
rep("window.hsTv={handle:handle,P:P,version:VERSION};", TIZEN + "window.hsTv={handle:handle,P:P,version:VERSION};")
# see-through page while the game shows
rep("</style>", "html.see,html.see body{background:transparent!important}\n</style>", 1)

if OUT.exists():
    shutil.rmtree(OUT)
(OUT / 'fonts').mkdir(parents=True)
(OUT / 'index.html').write_text(t, encoding='utf-8')
for f in (SRC / 'fonts').iterdir():
    shutil.copy(f, OUT / 'fonts' / f.name)
shutil.copy(SRC / 'largeIcon.png', OUT / 'icon.png')
(OUT / 'config.xml').write_text('''<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="https://honggame.store/hongsub" version="%s" viewmodes="maximized">
    <tizen:application id="HongSubTv1.HongSub" package="HongSubTv1" required_version="2.3"/>
    <content src="index.html"/>
    <feature name="http://tizen.org/feature/screen.size.all"/>
    <icon src="icon.png"/>
    <name>Hóng Sub</name>
    <description>Phụ đề tiếng Việt cho game PS5 trên TV, từ Hóng Sub trên máy tính.</description>
    <author href="https://honggame.store">Hóng Game Store</author>
    <tizen:profile name="tv-samsung"/>
    <access origin="*" subdomains="true"/>
    <tizen:privilege name="http://tizen.org/privilege/internet"/>
    <tizen:privilege name="http://tizen.org/privilege/tv.window"/>
    <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
    <tizen:privilege name="http://tizen.org/privilege/application.launch"/>
    <tizen:privilege name="http://developer.samsung.com/privilege/network.public"/>
    <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="disable" encryption="disable" install-location="auto" hwkey-event="enable"/>
</widget>
''' % ver, encoding='utf-8')
print('tizen app', ver, '->', OUT)
