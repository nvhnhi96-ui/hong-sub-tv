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

if not re.search(r"var VERSION='[^']*';", t):
    sys.exit('tizen build: VERSION line not found')
t = re.sub(r"var VERSION='[^']*';", "var VERSION='%s';" % ver, t, count=1)
# Samsung's own scripts (the IP of the TV); missing in a browser, harmless
rep('<script>\n', '<script src="$WEBAPIS/webapis/webapis.js"></script>\n<script src="preset.js"></script>\n<script>\n', 1)
# preset.js: written by Hóng Sub on the computer when it installs the app, so the TV already knows its code and the computer
# opened by Hóng Sub on a phone (POST to the TV's port 8001 with {code, pc}): that comes first, then preset.js
rep("function launchParams(){ try{ var s=window.PalmSystem", "function launchParams(){ try{ var tl=tzLaunch(); if(tl) return tl; if(window.HS_PRESET&&typeof window.HS_PRESET==='object') return window.HS_PRESET; var s=window.PalmSystem")
rep("var packaged=location.protocol==='file:';", "var packaged=typeof tizen!=='undefined';   /* installed on a Samsung TV */")
# keys: Back on a Samsung remote is 10009
rep("if(k===461||k===27||k===8){ if($('home').className==='off'&&P.src)", "if(k===461||k===10009||k===27||k===8){ if($('home').className==='off'&&P.src)")
rep("else if(k===461||k===27||k===8){ panel(false); }", "else if(k===461||k===10009||k===27||k===8){ panel(false); }")
rep("'Hóng Sub '+VERSION+(packaged?' cho TV LG':' trên trình duyệt')", "'Hóng Sub '+VERSION+(packaged?' cho TV Samsung':' trên trình duyệt')")
rep("function quit(){ sayStop(); try{ if(window.webOS&&window.webOS.platformBack) window.webOS.platformBack(); else window.close(); }catch(e){ window.close(); } }",
    "function quit(){ sayStop(); try{ tizen.tvwindow.hide(function(){},function(){}); }catch(e){} try{ tizen.application.getCurrentApplication().exit(); }catch(e){ window.close(); } }")

TIZEN = r"""
/* opened from Hóng Sub on a phone: the code and the phone's address come with the launch (the TV hands them over as
   app-control data); the same as an LG relaunch when the app is already open */
function tzLaunch(){
  try{ var r=tizen.application.getCurrentApplication().getRequestedAppControl(), d=(r&&r.appControl&&r.appControl.data)||[];
    for(var i=0;i<d.length;i++){ var vs=d[i].value||[]; for(var k=0;k<vs.length;k++){ var o=null; try{ o=JSON.parse(vs[k]); }catch(e){}
      if(o&&typeof o==='object'&&(o.code||o.pc)) return o; } } }catch(e){}
  return null;
}
window.addEventListener('appcontrol',function(){ try{ var ev=document.createEvent('Event'); ev.initEvent('webOSRelaunch',false,false); document.dispatchEvent(ev); }catch(e){} });
/* ---------- Samsung (Tizen) ----------
   The HDMI picture is drawn by the TV itself in a window under the page: the page turns see-through where the game shows. */
function setSource(n){
  srcOk=false;
  try{ video.style.display='none'; }catch(e){}
  if(!n||!window.tizen||!tizen.tvwindow){ document.documentElement.className=''; try{ tizen.tvwindow.hide(function(){},function(){}); }catch(e){} if(!n) homeShow(); else srcFail(n); return; }
  var fail=function(e){ if(P.src!==n) return; document.documentElement.className=''; srcFail(n); try{ $('hState').textContent+=' ('+((e&&(e.message||e.name))||'TV từ chối')+')'; }catch(x){} };
  var go=function(src){
    try{
      tizen.tvwindow.setSource(src,function(){
        /* BEHIND: the game picture goes under the page, so the Vietnamese subtitles stay on top (the default, FRONT, covers them) */
        tizen.tvwindow.show(function(){ if(P.src!==n) return; srcOk=true; document.documentElement.className='see'; homeHide(); },
          fail,['0px','0px','100%','100%'],'MAIN','BEHIND');
      },fail,'MAIN');
    }catch(e){ fail(e); }
  };
  /* the TV wants its own description of the input, taken from its list of connected sources */
  var once=false, plain={type:'HDMI',number:n}, pick=function(src){ if(once) return; once=true; go(src); };
  setTimeout(function(){ pick(plain); },1500);
  try{
    tizen.systeminfo.getPropertyValue('VIDEOSOURCE',function(vs){
      var list=(vs&&vs.connected)||[], hit=null;
      for(var i=0;i<list.length;i++) if(list[i].type==='HDMI'&&+list[i].number===n) hit=list[i];
      pick(hit||plain);
    },function(){ pick(plain); });
  }catch(e){ pick(plain); }
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
UPD = r"""
/* ---------- staying up to date ----------
   index.html (the loader) opens the newest Hóng Sub from the internet, so the TV never needs a reinstall.
   While the app runs it looks for a new version every half hour and switches over when nobody is reading subtitles. */
(function(){
  var LIVE='https://raw.githubusercontent.com/nvhnhi96-ui/hong-sub-tv/tv-live/samsung/', last=Date.now();
  function vn(v){ var p=String(v||'').split('.'); return (+p[0]||0)*1e8+(+p[1]||0)*1e4+(+p[2]||0); }
  try{ new MutationObserver(function(){ last=Date.now(); }).observe($('sub'),{childList:true,subtree:true,characterData:true}); }catch(e){}
  function check(){
    var x=new XMLHttpRequest();
    x.onreadystatechange=function(){
      if(x.readyState!==4||x.status!==200) return;
      var v=String(x.responseText||'').trim();
      if(!/^\d+\.\d+\.\d+$/.test(v)) return;
      if(vn(v)<=vn(VERSION)){ $('hVer').textContent='Bản '+VERSION+' · đang dùng bản mới nhất, app tự cập nhật'; return; }
      $('hVer').textContent='Bản '+VERSION+' · có bản mới '+v+', app tự chuyển sang khi đang rảnh';
      var idle=$('home').className!=='off'||Date.now()-last>20*60e3;
      if(!idle) return;
      pill('Đang cập nhật Hóng Sub lên '+v+'...',false);
      setTimeout(function(){ location.replace('index.html'); },2500);
    };
    try{ x.open('GET',LIVE+'version.txt?t='+Date.now(),true); x.send(); }catch(e){}
  }
  setTimeout(check,5000); setInterval(check,30*60e3);
})();
"""
rep("window.hsTv={handle:handle,P:P,version:VERSION};", TIZEN + UPD + "window.hsTv={handle:handle,P:P,version:VERSION};")
rep("var TVNAME='TV LG';", "var TVNAME='TV Samsung';")
# see-through page while the game shows
rep("</style>", "html.see,html.see body{background:transparent!important}\n</style>", 1)

LOADER = r"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Hóng Sub</title>
<style>html,body{margin:0;width:100%;height:100%;background:#0E1014;color:#F4F5F7;font-family:Arial,sans-serif;overflow:hidden}#m{position:fixed;left:8vw;top:46vh;font-size:3.2vh;opacity:.8}</style>
</head><body><div id="m">Hóng Sub đang mở...</div>
<script>
/* Hóng Sub for Samsung: opens the newest version from the internet (no reinstall needed);
   the copy installed on the TV (app.html) is used when the internet is slow or down. */
(function(){
  var BUNDLED='%VER%', LIVE='https://raw.githubusercontent.com/nvhnhi96-ui/hong-sub-tv/tv-live/samsung/', ls=null, done=false;
  try{ ls=window.localStorage; }catch(e){}
  function vn(v){ var p=String(v||'').split('.'); return (+p[0]||0)*1e8+(+p[1]||0)*1e4+(+p[2]||0); }
  function get(u,ms,cb){
    var x=new XMLHttpRequest(), fin=false;
    var t=setTimeout(function(){ if(fin) return; fin=true; try{ x.abort(); }catch(e){} cb(null); },ms);
    x.onreadystatechange=function(){ if(x.readyState!==4||fin) return; fin=true; clearTimeout(t); cb(x.status===200?x.responseText:null); };
    try{ x.open('GET',u+'?t='+Date.now(),true); x.send(); }catch(e){ if(!fin){ fin=true; clearTimeout(t); cb(null); } }
  }
  function local(){ if(done) return; done=true; location.replace('app.html'); }
  function boot(h){ if(done) return; done=true; document.open(); document.write(h); document.close(); }
  function saved(){ try{ var v=ls.getItem('hs.live.v'), h=ls.getItem('hs.live.html'); if(h&&vn(v)>vn(BUNDLED)&&h.indexOf("var VERSION='"+v+"'")>0) return h; }catch(e){} return null; }
  setTimeout(function(){ var s=saved(); if(s) boot(s); else local(); },15000);   /* never hang on a slow network */
  get(LIVE+'version.txt',4000,function(v){
    v=String(v||'').replace(/\s+/g,'');
    if(!/^\d+\.\d+\.\d+$/.test(v)){ var s=saved(); if(s) boot(s); else local(); return; }
    if(vn(v)<=vn(BUNDLED)){ local(); return; }
    try{ if(ls.getItem('hs.live.v')===v){ var s1=saved(); if(s1){ boot(s1); return; } } }catch(e){}
    get(LIVE+'app.html',9000,function(h){
      if(h&&h.indexOf("var VERSION='"+v+"'")>0){ try{ ls.setItem('hs.live.html',h); ls.setItem('hs.live.v',v); }catch(e){} boot(h); }
      else { var s2=saved(); if(s2) boot(s2); else local(); }
    });
  });
})();
</script></body></html>
"""

if OUT.exists():
    shutil.rmtree(OUT)
(OUT / 'fonts').mkdir(parents=True)
(OUT / 'app.html').write_text(t, encoding='utf-8')
(OUT / 'index.html').write_text(LOADER.replace('%VER%', ver), encoding='utf-8')
(OUT / 'preset.js').write_text('window.HS_PRESET=null;   /* {code, pc}: filled in by Hóng Sub on the computer when it installs the app */\n', encoding='utf-8')
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
