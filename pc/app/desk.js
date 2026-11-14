/* Hóng Sub for Windows: page navigation and the settings that only the Windows app has.
   The translating engine (shared with the web page) runs before this file and exposes window.hsApi. */
(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
var D=window.hsDesktop, A=window.hsApi;
if(!D||!A) return;
var S=A.S;

/* ---------- pages ---------- */
var TITLES={choi:'Màn hình chơi',ketnoi:'Kết nối PS5 / PS4',dich:'Dịch',giong:'Giọng đọc',phude:'Phụ đề và độ trễ',nhanvat:'Nhân vật',phim:'Phím tắt',khac:'TV và hỗ trợ'};
function go(p){
  if(!TITLES[p]) p='choi';
  document.querySelectorAll('.dk-nav button').forEach(function(b){ b.classList.toggle('on',b.dataset.p===p); if(b.dataset.p===p) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
  document.querySelectorAll('.dk-page').forEach(function(s){ s.classList.toggle('on',s.id==='p-'+p); });
  $('dkTitle').textContent=TITLES[p]; A.save('dkPage',p);
  document.querySelector('.dk-body').scrollTop=0;
  if(p==='phim') keysLoad();
}
document.querySelectorAll('.dk-nav button').forEach(function(b){ b.addEventListener('click',function(){ go(b.dataset.p); }); });
document.querySelectorAll('[data-go]').forEach(function(b){ b.addEventListener('click',function(){ go(b.dataset.go); }); });
document.querySelectorAll('[data-url]').forEach(function(b){ b.addEventListener('click',function(){ D.openUrl(b.dataset.url); }); });
go(A.load('dkPage','choi'));

/* when a picture arrives, show the play page */
new MutationObserver(function(){ if($('hsEmpty').hidden) go('choi'); }).observe($('hsEmpty'),{attributes:true,attributeFilter:['hidden']});
new MutationObserver(function(){ if(!$('hsPsFull').classList.contains('hs-off')) go('choi'); }).observe($('hsPsFull'),{attributes:true,attributeFilter:['class']});

/* ---------- sources ---------- */
$('hsPsGo').addEventListener('click',function(){ setTimeout(function(){ if($('hsPsFull').classList.contains('hs-off')) go('ketnoi'); },400); });
$('dkSrcPs').addEventListener('click',function(){ $('hsPsGo').click(); });
$('dkSrcCam').addEventListener('click',function(){ A.pickCam(); });
$('dkSrcWin').addEventListener('click',function(){ A.pick(true); });
var sony='';
function sonyInfo(){
  return D.sonyRp().then(function(r){
    sony=r.path||'';
    $('dkSonyState').textContent=sony?'Máy đã cài app PS Remote Play. Bấm Mở, đăng nhập và kết nối PS5 trong app đó; Hóng Sub tự nhận cửa sổ và đọc phụ đề.':'Máy chưa cài app PS Remote Play của Sony. Không cần app này nếu chơi ngay trong Hóng Sub.';
    $('dkSonyOpen').disabled=!sony; $('dkSonyNote').textContent=sony?'Mở app của Sony, Hóng Sub tự đọc cửa sổ đó':'Chưa cài, bấm để tải';
  });
}
sonyInfo();
function openSony(){
  if(!sony){ D.openUrl('https://www.playstation.com/en-vn/support/games/playstation-remote-play-on-pc-and-mac/'); A.status('warn','Máy chưa có app PS Remote Play. Tải và cài xong thì bấm lại.'); return; }
  D.openSonyRp().then(function(r){
    if(!r.ok){ A.status('err','Không mở được PS Remote Play'); return; }
    A.status('busy','Đang chờ cửa sổ PS Remote Play... Đăng nhập và kết nối PS5 trong app của Sony.');
    var t0=Date.now();
    (function wait(){
      D.windows().then(function(w){
        if(w.some(function(x){return /remote play/i.test(x.name);})){ setTimeout(function(){ A.pick(false); },1500); return; }
        if(Date.now()-t0<60000) setTimeout(wait,1500); else A.status('warn','Chưa thấy cửa sổ PS Remote Play. Mở xong thì bấm Đổi nguồn hình.');
      }).catch(function(){});
    })();
  });
}
$('dkSrcSony').addEventListener('click',openSony);
$('dkSonyOpen').addEventListener('click',openSony);
$('dkSonyGet').addEventListener('click',function(){ D.openUrl('https://www.playstation.com/en-vn/support/games/playstation-remote-play-on-pc-and-mac/'); });

/* ---------- translation ---------- */
$('dkFree').checked=S.allowFree;
$('dkFree').addEventListener('change',function(){ A.setFree(this.checked); });

/* ---------- subtitle look ---------- */
var ST=A.load('ovStyle',{color:'#FFFFFF',bg:74,width:80});
function applyStyle(push){
  document.querySelectorAll('#dkColor button').forEach(function(b){ b.classList.toggle('on',b.dataset.c.toLowerCase()===ST.color.toLowerCase()); });
  $('dkBg').value=ST.bg; $('dkBgV').textContent=ST.bg+'%'; $('dkWidth').value=ST.width; $('dkWidthV').textContent=ST.width+'%';
  var prev=$('dkPrev').firstElementChild; prev.style.background='rgba(8,8,10,'+(ST.bg/100)+')';
  $('dkPrevVi').style.color=ST.color; $('dkPrevVi').style.fontSize=Math.min(26,Math.round((+$('hsSize').value)*.75))+'px';
  $('dkPrevEn').style.display=$('hsShowEn').checked?'':'none';
  $('hsVi').style.color=ST.color==='#FFFFFF'?'':ST.color;
  if(push!==false) D.sub({style:{color:ST.color,bg:ST.bg/100}});
  A.save('ovStyle',ST);
}
document.querySelectorAll('#dkColor button').forEach(function(b){ b.addEventListener('click',function(){ ST.color=b.dataset.c; applyStyle(); }); });
$('dkBg').addEventListener('input',function(){ ST.bg=+this.value; applyStyle(); });
$('dkWidth').addEventListener('input',function(){ ST.width=+this.value; applyStyle(false); });
$('dkWidth').addEventListener('change',function(){ D.overlaySize(ST.width); });
$('hsSize').addEventListener('input',function(){ applyStyle(false); });
$('hsShowEn').addEventListener('change',function(){ applyStyle(false); });
applyStyle();
$('dkMove').addEventListener('click',function(){ D.overlay('move'); });
$('dkReset').addEventListener('click',function(){ D.overlayReset().then(function(){ D.overlaySize(ST.width); }); });
D.onOverlay(function(st){ $('dkOvl').checked=!st.hidden; $('dkMove').textContent=st.move?'Xong, giữ chỗ này':'Kéo phụ đề tới chỗ khác'; });
$('dkOvl').addEventListener('change',function(){ D.overlay('toggle'); });

/* ---------- timing ---------- */
function secTxt(ms){ return (ms/1000).toFixed(1).replace('.',',').replace(/,0$/,'')+' giây'; }
function timing(){
  $('dkScan').value=S.interval; $('dkScanV').textContent=secTxt(S.interval);
  $('dkWait').value=S.wait; $('dkWaitV').textContent=secTxt(S.wait);
  $('dkHold').value=S.hold; $('dkHoldV').textContent=S.hold?S.hold+' giây':'đến câu sau';
}
$('dkScan').addEventListener('input',function(){ A.setScan(+this.value); timing(); });
$('dkWait').addEventListener('input',function(){ A.setWait(+this.value); timing(); });
$('dkHold').addEventListener('input',function(){ A.setHold(+this.value); timing(); });
timing();
$('dkDefaults').addEventListener('click',function(){
  A.setScan(700); A.setWait(900); A.setHold(10); timing();
  $('hsSize').value=28; $('hsSize').dispatchEvent(new Event('input'));
  ST={color:'#FFFFFF',bg:74,width:80}; applyStyle(); D.overlaySize(80);
});

/* ---------- characters ---------- */
function castEmpty(){ $('dkCastEmpty').hidden=!$('hsCastBox').hidden; }
new MutationObserver(castEmpty).observe($('hsCastBox'),{attributes:true,attributeFilter:['hidden']}); castEmpty();

/* ---------- shortcuts ---------- */
var KEYN={toggle:'Bật / tắt dịch',now:'Dịch ngay câu đang hiện',full:'Dịch cả màn hình (menu, nhiệm vụ)',ovl:'Ẩn / hiện phụ đề nổi',move:'Di chuyển phụ đề nổi'};
var KEYS={}, KST={}, rec=null;
function keysDraw(){
  $('dkKeys').innerHTML=Object.keys(KEYN).map(function(id){
    var st=KST[id]==='busy'?'<span class="st">app khác đang dùng phím này</span>':KST[id]==='bad'?'<span class="st">phím không hợp lệ</span>':'';
    return '<tr'+(rec===id?' class="rec"':'')+'><td>'+KEYN[id]+'</td><td><kbd>'+(rec===id?'Nhấn phím...':(KEYS[id]||'Không dùng'))+'</kbd>'+st+'</td><td><button class="hs-btn" type="button" data-k="'+id+'">'+(rec===id?'Hủy':'Đổi')+'</button></td></tr>';
  }).join('');
  $('dkKeys').querySelectorAll('button').forEach(function(b){ b.addEventListener('click',function(){ if(rec===b.dataset.k) stopRec(); else startRec(b.dataset.k); }); });
  $('dkKeys2').textContent=(KEYS.toggle||'F7')+' bật/tắt dịch';
}
function keysLoad(){ return D.hotkeys().then(function(r){ KEYS=r.keys; KST=r.state; keysDraw(); }); }
function keyMsg(cls,t){ var m=$('dkKeysMsg'); m.hidden=!t; m.className='hs-msg '+cls; m.textContent=t||''; }
function startRec(id){ rec=id; keyMsg('',''); D.pauseHotkeys(true); keysDraw(); }
function stopRec(){ rec=null; D.pauseHotkeys(false); keysDraw(); }
function accel(e){
  var k=e.key, code=e.code, main='';
  if(/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) main=k;
  else if(/^Key[A-Z]$/.test(code)) main=code.slice(3);
  else if(/^Digit[0-9]$/.test(code)) main=code.slice(5);
  else if(/^Numpad[0-9]$/.test(code)) main='num'+code.slice(6);
  else if(code==='Space') main='Space';
  else if(/^(Insert|Delete|Home|End|PageUp|PageDown)$/.test(code)) main=code;
  if(!main) return null;
  var mods=[]; if(e.ctrlKey) mods.push('Ctrl'); if(e.altKey) mods.push('Alt'); if(e.shiftKey) mods.push('Shift');
  if(!mods.length&&!/^F\d/.test(main)&&!/^(Insert|Delete|Home|End|PageUp|PageDown)$/.test(main)) return {err:'Phím chữ, số hoặc Space phải kèm Ctrl hoặc Alt, nếu không sẽ bắt mất phím khi gõ chữ.'};
  return {acc:mods.concat([main]).join('+')};
}
document.addEventListener('keydown',function(e){
  if(!rec) return;
  e.preventDefault(); e.stopPropagation();
  if(e.key==='Escape'){ stopRec(); return; }
  if(/^(Control|Alt|Shift|Meta)$/.test(e.key)) return;
  var a=accel(e); if(!a){ keyMsg('warn','Phím này không dùng được, chọn phím F1 đến F12 hoặc tổ hợp có Ctrl / Alt.'); return; }
  if(a.err){ keyMsg('warn',a.err); return; }
  var dup=Object.keys(KEYS).filter(function(id){return id!==rec&&KEYS[id]===a.acc;})[0];
  if(dup){ keyMsg('warn','Phím '+a.acc+' đang dùng cho "'+KEYN[dup]+'". Chọn phím khác.'); return; }
  var o={}; o[rec]=a.acc; rec=null;
  D.setHotkeys(o).then(function(r){ KEYS=r.keys; KST=r.state; keysDraw(); keyMsg(r.state[Object.keys(o)[0]]==='ok'?'ok':'warn',r.state[Object.keys(o)[0]]==='ok'?'Đã đổi thành '+a.acc+'.':'Đã lưu '+a.acc+' nhưng app khác đang giữ phím này. Chọn phím khác.'); });
},true);
$('dkKeysReset').addEventListener('click',function(){ D.setHotkeys({toggle:'F7',now:'F8',ovl:'F9',move:'F10',full:'F11'}).then(function(r){ KEYS=r.keys; KST=r.state; keysDraw(); keyMsg('ok','Đã về phím mặc định F7 đến F11.'); }); });
keysLoad();

/* ---------- left rail summary ---------- */
function srcName(){
  if(!$('hsPsFull').classList.contains('hs-off')) return 'PS5 / PS4 trong Hóng Sub';
  if(!S.stream) return 'chưa chọn';
  if(S.demo) return 'xem thử';
  var t=S.stream.getVideoTracks()[0], l=(t&&t.label)||'';
  var set=(t&&t.getSettings)?t.getSettings():{};
  if(set.displaySurface||/^(screen|window|web-contents)[:-]/i.test(l)) return /remote play/i.test(l)?'PS Remote Play':'cửa sổ game';
  return 'capture card';
}
function rail(){
  var g=$('hsGame').value.trim()||'chưa chọn', k=$('hsKeys').value.split(/[\s,]+/).filter(function(x){return x.length>20;}).length, q=$('hsGroq').value.split(/[\s,]+/).filter(function(x){return x.length>20;}).length;
  var via=k?('Gemini, '+k+' mã'):q?('Groq, '+q+' mã'):(S.allowFree?'máy dịch miễn phí':'chưa có mã');
  var src=srcName(), voice=$('hsSpeak').checked?($('hsVoice').selectedOptions[0]?$('hsVoice').selectedOptions[0].textContent:'bật'):'tắt';
  [['dkSrc',src],['dkGame',g],['dkGame2',g],['dkVia',via],['dkVia2',via],['dkVoice2',voice]].forEach(function(x){ if($(x[0]).textContent!==x[1]) $(x[0]).textContent=x[1]; });
  $('dkKeyBadge').hidden=!!(k||q);
}
setInterval(rail,1000); rail();
D.version().then(function(v){ $('dkVer').textContent='Bản '+v; $('dkVerNote').textContent='Đang dùng bản '+v+'. Có bản mới Hóng Sub tự báo ở trên cùng.'; });
})();
