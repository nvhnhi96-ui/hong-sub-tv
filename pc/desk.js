/* Hóng Sub for Windows: page navigation and the settings that only the Windows app has.
   The translating engine (shared with the web page) runs before this file and exposes window.hsApi. */
/* On the web page there is no Windows app behind the page: a stand-in answers for it, and the parts only the
   app can do are hidden by the .dk-only class. */
window.hsDeskApi=window.hsDesktop||{
  web:true,
  openUrl:function(u){ window.open(u,'_blank','noopener'); },
  sonyRp:function(){ return Promise.resolve({path:''}); }, openSonyRp:function(){ return Promise.resolve({ok:false}); }, windows:function(){ return Promise.resolve([]); },
  sub:function(){}, overlay:function(){}, overlaySize:function(){}, overlayReset:function(){ return Promise.resolve(); }, onOverlay:function(){},
  hotkeys:function(){ return Promise.resolve({keys:{toggle:'Space',full:'T',zones:'N',speak:'R'},state:{}}); }, pauseHotkeys:function(){}, setHotkeys:function(){ return this.hotkeys(); },
  version:function(){ return Promise.resolve('trên web'); },
  update:function(){ return Promise.resolve({}); }, updateInstall:function(){ return Promise.resolve({ok:false,err:'web'}); }
};
(function(){
'use strict';
var $=function(id){return document.getElementById(id);};
var D=window.hsDeskApi, A=window.hsApi;
if(!D||!A) return;
var S=A.S;

/* ---------- pages ---------- */
var TITLES={choi:'Màn hình chơi',game:'Cài đặt › Game đang chơi',vung:'Cài đặt › Vùng dịch',ketnoi:'Kết nối PS5/PS4 và TV',dich:'Cài đặt › Dịch và mã AI',giong:'Cài đặt › Giọng đọc',phude:'Cài đặt › Phụ đề và độ trễ',nhanvat:'Cài đặt › Nhân vật',phim:'Cài đặt › Phím tắt',khac:'Hỗ trợ'};
var SETP=['game','dich','vung','giong','phude','nhanvat','phim'];
function subOpen(on){ $('dkSub').classList.toggle('open',on); $('dkSetBtn').classList.toggle('open',on); $('dkSetBtn').setAttribute('aria-expanded',on?'true':'false'); }
function go(p){
  if(!TITLES[p]) p='choi';
  var inSet=SETP.indexOf(p)>=0; subOpen(inSet);
  document.querySelectorAll('.dk-nav button').forEach(function(b){ b.classList.toggle('on',b.dataset.p===p); if(b.dataset.p===p) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current'); });
  document.querySelectorAll('.dk-page').forEach(function(s){ s.classList.toggle('on',s.id==='p-'+p); });
  $('dkTitle').textContent=TITLES[p]; A.save('dkPage',p); if(inSet) A.save('dkSet',p);
  document.querySelector('.dk-body').scrollTop=0;
  if(p==='phim') keysLoad();
  if(p==='choi') setTimeout(function(){ try{ window.dispatchEvent(new Event('resize')); }catch(e){} },60);   /* the picture is visible again: put boxes back in place */
}
document.querySelectorAll('.dk-nav button[data-p]').forEach(function(b){ b.addEventListener('click',function(){ go(b.dataset.p); }); });
$('dkSetBtn').addEventListener('click',function(){ var open=$('dkSub').classList.contains('open'); if(open&&SETP.indexOf(A.load('dkPage','choi'))<0) subOpen(false); else if(!open) go(A.load('dkSet','dich')); });
document.querySelectorAll('[data-go]').forEach(function(b){ b.addEventListener('click',function(){ go(b.dataset.go); }); });
document.querySelectorAll('[data-url]').forEach(function(b){ b.addEventListener('click',function(){ D.openUrl(b.dataset.url); }); });
window.hsGo=go;
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
if((D.web===true)){ TITLES.ketnoi='Kết nối TV'; $('dkSonyNote').textContent='Mở app của Sony rồi chọn cửa sổ đó'; $('dkSrcWin').querySelector('small').textContent='Game trên máy tính, phim, tab khác'; if(A.load('dkPage','choi')==='ketnoi') $('dkTitle').textContent=TITLES.ketnoi; }
else sonyInfo();
function openSony(){
  if((D.web===true)){ A.pick(false); return; }
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
var ST=A.load('ovStyle',{color:'#FFFFFF',bg:74,width:80,font:'bevn'}); if(!ST.font||!A.fonts[ST.font]) ST.font='bevn';
(function(){ var sel=$('dkFont'); if(!sel) return;
  sel.innerHTML=Object.keys(A.fonts).map(function(k){ return '<option value="'+k+'">'+A.fonts[k].n+'</option>'; }).join('');
  sel.value=ST.font; sel.addEventListener('change',function(){ ST.font=sel.value; applyStyle(); }); })();
function applyStyle(push){
  if(!A.fonts[ST.font]) ST.font='bevn';   /* an old or unknown font name: back to the default */
  document.querySelectorAll('#dkColor button').forEach(function(b){ b.classList.toggle('on',b.dataset.c.toLowerCase()===ST.color.toLowerCase()); });
  $('dkBg').value=ST.bg; $('dkBgV').textContent=ST.bg+'%'; $('dkWidth').value=ST.width; $('dkWidthV').textContent=ST.width+'%';
  var prev=$('dkPrev').firstElementChild; prev.style.background='rgba(8,8,10,'+(ST.bg/100)+')'; prev.style.width=ST.width+'%'; prev.style.boxSizing='border-box'; prev.style.marginLeft='auto'; prev.style.marginRight='auto';
  $('dkPrevVi').style.color=ST.color; A.fontLoad(ST.font); $('dkPrevVi').style.fontFamily=A.fonts[ST.font].css; $('hsVi').style.fontFamily=ST.font==='bevn'?'':A.fonts[ST.font].css; $('dkPrevVi').style.fontSize=Math.min(26,Math.round((+$('hsSize').value)*.75))+'px';
  $('dkPrevEn').style.display=$('hsShowEn').checked?'':'none';
  $('hsVi').style.color=ST.color==='#FFFFFF'?'':ST.color;
  A.save('ovStyle',ST);
  if(push!==false) D.sub({style:{color:ST.color,bg:ST.bg/100,family:A.fonts[ST.font].css,fontUrl:A.fontUrl(ST.font)}});
}
document.querySelectorAll('#dkColor button').forEach(function(b){ b.addEventListener('click',function(){ ST.color=b.dataset.c; applyStyle(); }); });
$('dkBg').addEventListener('input',function(){ ST.bg=+this.value; applyStyle(); });
var wT=0; $('dkWidth').addEventListener('input',function(){ ST.width=+this.value; applyStyle(false); clearTimeout(wT); wT=setTimeout(function(){ D.overlaySize(ST.width); },120); });
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
  A.setScan(300); A.setWait(900); A.setHold(10); timing();
  $('hsSize').value=28; $('hsSize').dispatchEvent(new Event('input'));
  ST={color:'#FFFFFF',bg:74,width:80,font:'bevn'}; if($('dkFont')) $('dkFont').value='bevn'; applyStyle(); D.overlaySize(80);
});

/* ---------- characters ---------- */
function castEmpty(){ $('dkCastEmpty').hidden=!$('hsCastBox').hidden; }
new MutationObserver(castEmpty).observe($('hsCastBox'),{attributes:true,attributeFilter:['hidden']}); castEmpty();

/* ---------- shortcuts ---------- */
var KEYN={toggle:'Bật / tắt dịch',now:'Dịch ngay câu đang hiện',full:'Bật / tắt dịch cả màn hình (đè lên chữ Anh)',ovl:'Ẩn / hiện phụ đề nổi',move:'Di chuyển phụ đề nổi',zones:'Dịch các vùng nhiệm vụ, vật phẩm',speak:'Bật / tắt đọc phụ đề'};
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
$('dkKeysReset').addEventListener('click',function(){ D.setHotkeys({toggle:'F7',now:'F8',ovl:'F9',move:'F10',full:'F11',zones:'F6',speak:'F5'}).then(function(r){ KEYS=r.keys; KST=r.state; keysDraw(); keyMsg('ok','Đã về phím mặc định F5 đến F11.'); }); });
keysLoad();

/* ---------- AI voices ---------- */
var AI={st:null};
function mb(n){ return Math.round(n/1048576)+' MB'; }
function aiDraw(st){
  AI.st=st; var m=$('dkAiState'), bar=$('dkAiBar');
  bar.hidden=!(st.busy==='download'&&st.total);
  if(st.total) bar.firstElementChild.style.width=Math.round(st.got/st.total*100)+'%';
  $('dkAiGet').hidden=st.installed&&!st.busy; $('dkAiGet').disabled=!!st.busy;
  $('dkAiOpts').hidden=!st.installed||!!st.busy;
  if(st.busy==='download'){ m.className='hs-msg'; m.textContent='Đang tải bộ giọng: '+mb(st.got)+(st.total?' / '+mb(st.total)+' ('+Math.round(st.got/st.total*100)+'%)':'')+'. Vẫn dùng Hóng Sub bình thường trong lúc tải.'; }
  else if(st.busy==='unzip'){ m.className='hs-msg'; m.textContent='Đang giải nén bộ giọng...'; }
  else if(st.err){ m.className='hs-msg err'; m.textContent='Lỗi: '+st.err+'. Bấm Tải bộ giọng AI để thử lại, hoặc gửi lỗi cho shop.'; $('dkAiGet').hidden=false; }
  else if(!st.installed){ m.className='hs-msg'; m.textContent='Chưa tải. Gói nặng khoảng 510 MB, tải một lần rồi dùng mãi, không cần mạng khi đọc.'; }
  else if(!st.ready){ m.className='hs-msg'; m.textContent='Đang mở bộ giọng AI...'; }
  else { m.className='hs-msg ok'; m.textContent='Bộ giọng AI đã sẵn sàng: '+st.voices.length+' giọng ('+st.voices.filter(function(v){return v.gender==='male';}).length+' nam, '+st.voices.filter(function(v){return v.gender==='female';}).length+' nữ).'; }
  $('dkAiFast').checked=!!st.fast;
  if(st.ready){
    var cur=A.narrator();
    $('dkNarr').innerHTML=st.voices.map(function(v){return '<option value="'+v.id+'"'+(v.id===cur?' selected':'')+'>'+v.id+' ('+(v.gender==='male'?'nam':'nữ')+', '+v.region+')</option>';}).join('');
    $('dkAiList').innerHTML=st.voices.map(function(v){return '<button type="button" data-v="'+v.id+'"><svg viewBox="0 0 10 10"><path d="M2 1l7 4-7 4z"/></svg><b>'+v.id+'</b><small>'+(v.gender==='male'?'nam':'nữ')+' · '+v.region+'</small></button>';}).join('');
    $('dkAiList').querySelectorAll('button').forEach(function(b){ b.addEventListener('click',function(){ A.sample('ai:'+b.dataset.v,'Xin chào, tôi là '+b.dataset.v+'. Chúng ta phải rời khỏi đây trước khi trời sáng.'); }); });
  }
}
if(D.aiv){
  D.aiv.onState(aiDraw); D.aiv.state().then(aiDraw);
  $('dkAiGet').addEventListener('click',function(){ D.aiv.install(); });
  $('dkAiOn').checked=!A.aiv.off;
  $('dkAiOn').addEventListener('change',function(){ A.aiv.off=!this.checked; A.save('aivOff',A.aiv.off); });
  $('dkAiFast').addEventListener('change',function(){ D.aiv.fast(this.checked); });
  $('dkNarr').addEventListener('change',function(){ A.save('narrator',this.value); A.sample('ai:'+this.value,'Đây là giọng đọc lời dẫn và những câu không có tên người nói.'); });
  $('dkAiRemove').addEventListener('click',function(){ if(confirm('Gỡ bộ giọng AI khỏi máy? Muốn dùng lại thì phải tải lại.')) D.aiv.remove(); });
}

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
  var o=$('hsOr')?$('hsOr').value.split(/[\s,]+/).filter(function(x){return x.length>20;}).length:0;
  var via=(k?('Gemini, '+k+' mã'):q?('Groq, '+q+' mã'):o?'AI thông minh':(S.allowFree?'máy dịch miễn phí':'chưa có mã'))+(o&&(k||q)?' + AI thông minh':'');
  var src=srcName(), voice=$('hsSpeak').checked?($('hsVoice').selectedOptions[0]?$('hsVoice').selectedOptions[0].textContent:'bật'):'tắt';
  var lang=$('hsLang')&&$('hsLang').selectedOptions[0]?$('hsLang').selectedOptions[0].textContent:'Tiếng Anh';
  [['dkSrc',src],['dkGame',g],['dkGame2',g],['dkVia',via],['dkVia2',via],['dkVoice2',voice],['dkLang2',lang]].forEach(function(x){ if($(x[0]).textContent!==x[1]) $(x[0]).textContent=x[1]; });
  $('dkKeyBadge').hidden=!!(k||q||o);
}
setInterval(rail,1000); rail();
D.version().then(function(v){ $('dkVer').textContent='Bản '+v; $('dkVerNote').textContent='Đang dùng bản '+v+'. Hóng Sub tự xem bản mới 15 phút một lần và báo bằng nút xanh ở trên cùng; bấm Kiểm tra cập nhật để xem ngay.'; });
/* Phiên bản: check now, update in one click, and see what changed */
(function(){
  var btn=$('dkVerCheck'), go=$('dkVerGo'), res=$('dkVerRes'), cur='', last=null;
  if(!btn) return;
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function check(){
    btn.disabled=true; btn.textContent='Đang kiểm tra...'; res.hidden=false; res.textContent='Đang xem có bản mới không...'; go.hidden=true;
    Promise.all([D.version(),D.update()]).then(function(a){
      cur=String(a[0]||''); var u=a[1]; last=u;
      if(!u||!u.version){ res.textContent='Chưa kiểm tra được (máy đang mất mạng?). Thử lại sau ít phút.'; return; }
      if(u.newer){
        res.innerHTML='Có bản mới <b>'+esc(u.version)+'</b> (đang dùng '+esc(cur)+'). Bấm <b>Cập nhật lên '+esc(u.version)+'</b>: Hóng Sub tự tải, tự cài và mở lại, mã và cài đặt vẫn giữ nguyên.';
        go.hidden=false; go.textContent='Cập nhật lên '+u.version;
      } else {
        res.textContent='Đang dùng bản mới nhất ('+cur+').';
      }
    }).catch(function(){ res.textContent='Chưa kiểm tra được. Thử lại sau ít phút.'; })
      .then(function(){ btn.disabled=false; btn.textContent='Kiểm tra cập nhật'; });
  }
  btn.addEventListener('click',check);
  go.addEventListener('click',function(){ if(window.hsUpdateNow){ go.disabled=true; go.textContent='Đang tải bản mới...'; window.hsUpdateNow(last); } });
  if(D.onUpdateProgress) D.onUpdateProgress(function(p){ if(go.disabled) go.textContent='Đang tải bản mới '+Math.round(p*100)+'%'; });
})();
})();

/* floating panel for the extra areas */
(function(){
  var cb=document.getElementById('dkZonePanel'); var hsDesktop=window.hsDeskApi; if(!cb||!hsDesktop||!hsDesktop.zonesPanel) return;
  if(hsDesktop.onOverlay) hsDesktop.onOverlay(function(st){ cb.checked=!st.zonesHidden; });
  cb.addEventListener('change',function(){ hsDesktop.zonesPanel(cb.checked); });
})();

/* zones page: buttons that only the Windows app has, and the short card on the play page */
(function(){
  var hsDesktop=window.hsDeskApi, add2=document.getElementById('dkZoneAdd2'), sum=document.getElementById('dkZoneSum');
  if(add2) add2.addEventListener('click',function(){ var b=document.getElementById('hsZoneAdd'); if(!b.disabled) b.click(); else window.hsApi.status('warn','Chọn nguồn hình trước rồi mới thêm vùng.'); });
  var mv=document.getElementById('dkZoneMove'); if(mv) mv.addEventListener('click',function(){ hsDesktop.overlay('move'); });
  var rs=document.getElementById('dkZoneReset'); if(rs) rs.addEventListener('click',function(){ if(hsDesktop.zonesReset) hsDesktop.zonesReset(); });
  if(hsDesktop.onOverlay&&mv) hsDesktop.onOverlay(function(st){ mv.textContent=st.move?'Xong di chuyển':'Di chuyển các khung'; });
  function upd(){
    var zs=window.hsApi.S.zones||[], on=zs.filter(function(z){return z.on;}).length;
    if(sum) sum.textContent=zs.length?(zs.length+' vùng, '+on+' đang bật'):'chưa có';
    if(add2){ add2.disabled=zs.length>=8; var cn=document.getElementById('dkZoneCnt'); if(cn){ cn.hidden=!zs.length; cn.textContent=zs.length; } }
  }
  setInterval(upd,1000); upd();
})();

/* ---------- play page: current source, quick switches, read-aloud chip ---------- */
(function(){
  var $=function(id){return document.getElementById(id);}, A=window.hsApi, D=window.hsDeskApi, S=A.S;
  /* a quick switch mirrors a setting that lives on a settings page */
  function mirror(qid,id,after){
    var q=$(qid), o=$(id); if(!q||!o) return;
    function pull(){ q.checked=o.checked; if(after) after(); }
    q.addEventListener('change',function(){ if(id==='hsSpeak'){ A.setSpeak(q.checked); } else { o.checked=q.checked; o.dispatchEvent(new Event('change')); } pull(); });
    o.addEventListener('change',pull); o.addEventListener('hs-speak',pull); pull();
  }
  function chip(){ var on=$('hsSpeak').checked; $('dkSpeakChip').setAttribute('aria-pressed',on?'true':'false'); $('dkSpeakTx').textContent='Đọc phụ đề: '+(on?'bật':'tắt'); }
  mirror('dkQSpeak','hsSpeak',chip); mirror('dkQOvl','dkOvl'); mirror('dkQCast','hsCastAuto'); mirror('dkQCover','hsCover'); mirror('dkQFs','hsFsAuto');
  $('dkSpeakChip').addEventListener('click',function(){ A.setSpeak(!$('hsSpeak').checked); chip(); });
  $('hsSpeak').addEventListener('hs-speak',chip); $('hsSpeak').addEventListener('change',chip); chip();
  $('dkNow').addEventListener('click',function(){ A.now(); });
  function cur(){
    var on=!!S.stream; $('dkCur').hidden=!on; $('dkSrcPick').hidden=on&&!S.pickOpen; $('dkNow').disabled=!on;
    if(on){ var n=$('dkSrc').textContent; $('dkCurName').textContent='Đang nhận hình: '+n; }
  }
  $('dkCurChange').addEventListener('click',function(){ S.pickOpen=!S.pickOpen; cur(); });
  setInterval(cur,800); cur();
  $('dkBuyZalo').addEventListener('click',function(){
    var msg='Chào shop, mình muốn nhờ nạp tiền OpenRouter để dùng AI dịch thông minh trên Hóng Sub.';
    try{ navigator.clipboard.writeText(msg).catch(function(){}); }catch(e){}
    A.status('idle','Đã chép sẵn tin nhắn, dán (Ctrl+V) vào Zalo của shop.');
    D.openUrl('https://zalo.me/0949099992');
  });
})();

/* ---------- notifications: new version, new games, AI voices, news from the shop ---------- */
(function(){
  var $=function(id){return document.getElementById(id);}, A=window.hsApi, D=window.hsDeskApi;
  var FEED='https://raw.githubusercontent.com/nvhnhi96-ui/hong-sub-tv/main/web/notices.json';
  var GAMES='https://raw.githubusercontent.com/nvhnhi96-ui/hong-sub-tv/main/presets/games.json';
  var list=A.load('notices',[]);
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function when(t){ var d=new Date(t); return d.toLocaleDateString('vi-VN')+' '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2); }
  function draw(){
    var n=list.filter(function(x){return !x.read;}).length;
    $('dkBellN').hidden=!n; $('dkBellN').textContent=n>9?'9+':n;
    $('dkNotiList').innerHTML=list.length?list.map(function(x){
      return '<div class="it'+(x.read?'':' new')+'"><i></i><b>'+esc(x.title)+'</b><p>'+esc(x.body||'')+'</p>'+
        (x.upd?'<button class="dk-link" type="button" data-upd="1">'+esc(x.btn||'Cập nhật')+'</button>':x.go?'<button class="dk-link" type="button" data-go2="'+esc(x.go)+'">'+esc(x.btn||'Mở')+'</button>':x.url?'<button class="dk-link" type="button" data-url2="'+esc(x.url)+'">'+esc(x.btn||'Mở')+'</button>':'')+
        '<small>'+when(x.t)+'</small></div>';
    }).join(''):'<p class="dk-empty" style="padding:10px 12px">Chưa có thông báo nào.</p>';
    $('dkNotiList').querySelectorAll('[data-go2]').forEach(function(b){ b.onclick=function(){ $('dkNoti').hidden=true; window.hsGo(b.dataset.go2); }; });
    $('dkNotiList').querySelectorAll('[data-upd]').forEach(function(b){ b.onclick=function(){ $('dkNoti').hidden=true; if(window.hsUpdateNow) window.hsUpdateNow(); }; });
    $('dkNotiList').querySelectorAll('[data-url2]').forEach(function(b){ b.onclick=function(){ D.openUrl(b.dataset.url2); }; });
  }
  function toast(x){
    var t=document.createElement('div'); t.className='dk-toast'; t.setAttribute('role','status');
    t.innerHTML='<b>'+esc(x.title)+'</b>'+esc(x.body||'');
    t.onclick=function(){ t.remove(); $('dkNoti').hidden=false; draw(); };
    ($('hs')||document.body).appendChild(t); setTimeout(function(){ t.remove(); },7000);
  }
  function add(x){
    if(list.some(function(y){return y.id===x.id;})) return;
    x.t=x.t||Date.now(); x.read=false; list.unshift(x); list=list.slice(0,30); A.save('notices',list); draw(); toast(x);
  }
  $('dkBell').addEventListener('click',function(e){ e.stopPropagation(); var h=!$('dkNoti').hidden; $('dkNoti').hidden=h; $('dkBell').setAttribute('aria-expanded',h?'false':'true'); draw(); });
  $('dkNotiRead').addEventListener('click',function(){ list.forEach(function(x){x.read=true;}); A.save('notices',list); draw(); });
  document.addEventListener('click',function(e){ if(!$('dkNoti').hidden&&!$('dkNoti').contains(e.target)) $('dkNoti').hidden=true; });
  draw();
  function check(){
    /* a newer Hóng Sub */
    D.update().then(function(u){ if(u&&u.newer) add({id:'upd-'+u.version,title:'Có bản Hóng Sub mới '+u.version,body:'Bấm Cập nhật: Hóng Sub tự tải, tự cài và mở lại, mã và cài đặt vẫn giữ nguyên.',upd:true,btn:'Cập nhật ngay'}); }).catch(function(){});
    /* games added to the list */
    fetch(GAMES+'?t='+Math.floor(Date.now()/36e5),{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      var names=(Array.isArray(j)?j:(j.games||[])).map(function(g){return g.name||g.title||'';}).filter(Boolean);
      var seen=A.load('seenGames',null);
      if(seen===null){ A.save('seenGames',names); return; }
      var fresh=names.filter(function(n){return seen.indexOf(n)<0;});
      if(fresh.length){ add({id:'games-'+fresh.join('|').slice(0,80),title:'Có '+fresh.length+' game mới trong danh sách',body:fresh.slice(0,6).join(', ')+(fresh.length>6?'...':'')+'. Chọn game để dịch đúng tên và xưng hô.',go:'dich',btn:'Chọn game'}); A.save('seenGames',names); }
    }).catch(function(){});
    /* AI voices not downloaded yet */
    if(D.aiv) D.aiv.state().then(function(st){ if(st&&!st.ready&&!st.installing) add({id:'aiv-pack-1',title:'Có bộ 25 giọng đọc AI tiếng Việt',body:'Mỗi nhân vật một giọng riêng, đọc tự nhiên, chạy ngay trên máy. Tải một lần khoảng 510 MB.',go:'giong',btn:'Tải bộ giọng'}); }).catch(function(){});
    /* news from the shop: new voices, new features */
    fetch(FEED+'?t='+Math.floor(Date.now()/36e5),{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
      (j.items||[]).slice(0,10).reverse().forEach(function(x){ if(x&&x.id&&x.title&&(!x.until||Date.parse(x.until)>Date.now())&&(window.HSPhone?(x.phone||!(x.pc||x.web)):(!x.phone&&!(x.pc&&(D.web===true))&&!(x.web&&!(D.web===true))))) add({id:'feed-'+x.id,title:x.title,body:x.body||'',url:x.url||'',go:x.go||'',btn:x.btn||'',t:x.date?Date.parse(x.date):0}); });
    }).catch(function(){});
  }
  if(D.onUpdate) D.onUpdate(function(u){ if(u&&u.newer) add({id:'upd-'+u.version,title:'Có bản Hóng Sub mới '+u.version,body:'Bấm Cập nhật: Hóng Sub tự tải, tự cài và mở lại, mã và cài đặt vẫn giữ nguyên.',upd:true,btn:'Cập nhật ngay'}); });
  setTimeout(check,4000); setInterval(check,30*60e3);
})();

/* ---------- new version: green button in the top bar, one click to update ---------- */
(function(){
  var $=function(id){return document.getElementById(id);}, A=window.hsApi, D=window.hsDeskApi;
  var btn=$('dkUpdBtn'), info=null, busy=false;
  function show(u){
    if(!u||!u.newer) return; info=u;
    if(!busy){ btn.hidden=false; btn.textContent='Cập nhật lên '+u.version; }
    var b=$('hsUpd'); if(b){ b.innerHTML='Có bản Hóng Sub mới <b>'+u.version+'</b>. Bấm nút xanh <b>Cập nhật</b> ở trên cùng: Hóng Sub tự tải, tự cài và mở lại, mã và cài đặt vẫn giữ nguyên.'; b.style.display='block'; }
  }
  window.hsUpdateNow=function(u){
    if(u&&u.newer) show(u);
    if(busy||!info) return; busy=true; btn.disabled=true; btn.textContent='Đang tải bản mới...';
    A.status('busy','Đang tải Hóng Sub '+info.version+'...');
    D.updateInstall().then(function(r){
      if(r&&r.ok){ btn.textContent='Đang cài, Hóng Sub sẽ mở lại...'; A.status('busy','Đang cài bản mới, Hóng Sub sẽ tự mở lại.'); return; }
      busy=false; btn.disabled=false; btn.textContent='Cập nhật lên '+info.version;
      A.status('warn','Chưa tự cập nhật được ('+((r&&r.err)||'lỗi')+'). Đang mở trang tải về.');
      D.openUrl('https://honggame.store/hongsubpc');
    });
  };
  btn.addEventListener('click',function(){ window.hsUpdateNow(); });
  if(D.onUpdateProgress) D.onUpdateProgress(function(p){ if(busy) btn.textContent='Đang tải bản mới '+Math.round(p*100)+'%'; });
  if(D.onUpdate) D.onUpdate(show);
  D.update().then(show).catch(function(){});
  setInterval(function(){ D.update().then(show).catch(function(){}); },15*60e3);
})();

/* ---------- TV LG: Hóng Sub installs its app on the TV (Developer Mode), so subtitles sit on the game picture ---------- */
(function(){
'use strict';
var D=window.hsDeskApi, A=window.hsApi; if(!D||!D.lg) return;
var $=function(id){return document.getElementById(id);};
var ALPHA='ABCDEFGHJKLMNPQRSTUVWXYZ23456789', busy=false;
function msg(cls,t){ var m=$('dkLgMsg'); m.hidden=!t; m.className='hs-msg'+(cls?' '+cls:''); m.textContent=t||''; }
/* the TV app is told which TV code to listen on, so nobody has to type it */
function code(){
  var v=String(A.tvCodeFor('lg')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(v.length<4){
    v=''; for(var i=0;i<6;i++) v+=ALPHA.charAt(Math.floor(Math.random()*ALPHA.length));
    if(A.tvType()==='lg'){ var el=$('hsTv'); el.value=v; el.dispatchEvent(new Event('change',{bubbles:true})); } else A.save('tv_lg',v);
  }
  return v;
}
function openOnTv(){
  msg('','Đang mở Hóng Sub trên TV...');
  return D.lg.launch(code()).then(function(r){ msg(r&&r.ok?'ok':'err',r&&r.ok?'Đã mở Hóng Sub trên TV.':'Chưa mở được: '+((r&&r.err)||'')+'. Kiểm tra TV đang bật và Developer Mode chưa hết hạn.'); if(A.tvState) A.tvState(); return r; });
}
function done(st){
  $('dkLgDone').hidden=!st.installed; $('dkLgAutoRow').hidden=!st.installed; $('dkLgAuto').checked=st.auto!==false;
  if(st.installed){
    window.hsLgOpen=openOnTv;
    $('dkLgState').innerHTML='Đã cài trên TV LG <b>'+st.ip+'</b>. Cài lại khi có bản mới hoặc khi TV đã gỡ app.';
    $('dkLgSum').textContent='Cài lại / cập nhật app trên TV LG'; $('dkLg').open=false;
    $('dkLgGo').textContent='Cài lại'; if(!$('dkLgIp').value) $('dkLgIp').value=st.ip;
  }
  if(A.tvState) A.tvState();
}
D.lg.onProgress(function(t){ msg('',t); });
$('dkLgFind').onclick=function(){
  var b=this; b.disabled=true; b.textContent='Đang tìm...'; $('dkLgList').innerHTML='';
  D.lg.find().then(function(list){
    b.disabled=false; b.textContent='Tìm TV LG';
    if(!list||!list.length){ msg('warn','Chưa thấy TV LG nào. Kiểm tra TV đang bật và cùng mạng, hoặc xem IP trong app Developer Mode trên TV rồi gõ vào.'); return; }
    msg('',''); if(list.length===1) $('dkLgIp').value=list[0].ip;
    $('dkLgList').innerHTML=list.map(function(x){ return '<button class="hs-btn" type="button" data-ip="'+x.ip+'">'+String(x.name).replace(/[<>&]/g,'')+' · '+x.ip+'</button>'; }).join('');
    [].forEach.call($('dkLgList').querySelectorAll('[data-ip]'),function(el){ el.onclick=function(){ $('dkLgIp').value=el.getAttribute('data-ip'); }; });
  });
};
$('dkLgGo').onclick=function(){
  if(busy) return;
  var ip=$('dkLgIp').value.trim(), pass=$('dkLgPass').value.trim().toUpperCase();
  if(!ip){ msg('warn','Gõ IP của TV LG, hoặc bấm Tìm TV LG.'); return; }
  if(pass.length<4){ msg('warn','Gõ mã Passphrase đang hiện trong app Developer Mode trên TV.'); return; }
  busy=true; this.disabled=true;
  if(A.tvType()!=='lg') A.setTvType('lg');
  var b=this, c=code();
  D.lg.install(ip,pass,c).then(function(r){
    busy=false; b.disabled=false;
    if(r&&r.ok){ msg('ok','Đã cài xong và mở Hóng Sub trên TV. Trên TV chọn cổng HDMI của máy PS5 là phụ đề nằm trên hình game.'); if(A.toast) A.toast('Đã cài Hóng Sub lên TV LG'); D.lg.state().then(done); }
    else msg('err',(r&&r.err)||'Chưa cài được.');
  });
};
$('dkLgOpen').onclick=function(){ openOnTv(); };
$('dkLgAuto').onchange=function(){ D.lg.auto(this.checked); };
D.lg.state().then(function(st){
  done(st);
  /* when the computer app opens, open Hóng Sub on the TV too (TV must be on) */
  if(st.installed&&st.auto!==false&&!D.selftest&&A.tvType()==='lg') setTimeout(function(){ D.lg.launch(code()).then(function(){ if(A.tvState) A.tvState(); }); },6000);
});
})();

/* ---------- TV Samsung: Hóng Sub signs and installs its app with the person's Samsung certificate (Tizen Studio) ---------- */
(function(){
'use strict';
var D=window.hsDeskApi, A=window.hsApi; if(!D||!D.samsung||!document.getElementById('dkTzGo')) return;
var $=function(id){return document.getElementById(id);};
var ALPHA='ABCDEFGHJKLMNPQRSTUVWXYZ23456789', busy=false, st=null;
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function msg(cls,t){ var m=$('dkTzMsg'); m.hidden=!t; m.className='hs-msg'+(cls?' '+cls:''); m.textContent=t||''; }
function line(id,ok,t){ var el=$(id); el.className='tzst'+(ok===true?' ok':ok===false?' bad':''); el.textContent=t?(ok===true?'✓ ':ok===false?'✗ ':'')+t:''; }
function code(){
  var v=String(A.tvCodeFor('samsung')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(v.length<4){
    v=''; for(var i=0;i<6;i++) v+=ALPHA.charAt(Math.floor(Math.random()*ALPHA.length));
    if(A.tvType()==='samsung'){ var el=$('hsTv'); el.value=v; el.dispatchEvent(new Event('change',{bubbles:true})); } else A.save('tv_samsung',v);
  }
  return v;
}
function openOnTv(){
  msg('','Đang mở Hóng Sub trên TV...');
  return D.samsung.launch().then(function(r){ msg(r&&r.ok?'ok':'err',r&&r.ok?'Đã mở Hóng Sub trên TV.':'Chưa mở được. '+((r&&r.err)||'')); if(A.tvState) A.tvState(); });
}
function tvCheck(){
  var ip=$('dkTzIp').value.trim();
  if(!ip){ line('dkTzS1',null,'Gõ IP của TV hoặc bấm Tìm TV Samsung ở dưới để kiểm tra bước này.'); return Promise.resolve(); }
  line('dkTzS1',null,'Đang hỏi TV '+ip+'...');
  return D.samsung.info(ip).then(function(i){
    var pcs=(st&&st.pcIps)||[];
    if(!i||!i.ok) line('dkTzS1',false,'Không thấy TV Samsung ở '+ip+'. Kiểm tra TV đang bật, cùng mạng wifi/modem với máy tính, IP gõ đúng.');
    else if(!i.dev) line('dkTzS1',false,(i.name||'TV')+': Developer Mode đang tắt. Làm lại bước 1 và nhớ tắt TV hẳn rồi bật lại.');
    else if(i.devIp&&pcs.indexOf(i.devIp)<0&&pcs.indexOf(i.devIp.split('.').reverse().join('.'))>=0) line('dkTzS1',false,(i.name||'TV')+': TV lưu Host PC IP bị đảo ngược ('+i.devIp+'). Vào lại bảng Developer mode, gõ IP theo thứ tự ngược: '+pcs.filter(function(x){return x===i.devIp.split('.').reverse().join('.');})[0].split('.').reverse().join('.')+', rồi khởi động lại TV.');
    else if(i.devIp&&pcs.indexOf(i.devIp)<0) line('dkTzS1',false,(i.name||'TV')+': Host PC IP đang là '+i.devIp+', phải là '+(window.hsPcIp||pcs[0]||'IP máy tính này')+'. Sửa lại trên TV rồi tắt TV hẳn, bật lại.');
    else line('dkTzS1',true,(i.name||'TV Samsung')+(i.model?' ('+i.model+')':'')+': Developer Mode đã bật cho máy tính này.');
  });
}
function draw(s){
  st=s||st||{}; var pcs=st.pcIps||[];
  $('dkTzPcIp').textContent=window.hsPcIp||pcs[0]||'IP máy tính';
  line('dkTzS2',!!st.tools,st.tools?'Đã thấy Tizen Studio ở '+st.root+'.':'Chưa thấy Tizen Studio trên máy này. Cài xong bấm Kiểm tra lại.');
  var pr=st.profiles||[], sel=$('dkTzProf'), keep=sel.value||st.profile||st.active;
  sel.innerHTML=pr.length?pr.map(function(x){ return '<option value="'+esc(x.name)+'">'+esc(x.name)+(x.samsung?' (Samsung)':' (không phải Samsung)')+'</option>'; }).join(''):'<option value="">Chưa có chứng chỉ</option>';
  if(keep&&pr.some(function(x){return x.name===keep;})) sel.value=keep;
  var sam=pr.filter(function(x){return x.samsung;});
  line('dkTzS3',!st.tools?null:sam.length?true:false,!st.tools?'':sam.length?'Đã có chứng chỉ Samsung: '+sam.map(function(x){return x.name;}).join(', ')+'.':pr.length?'Chứng chỉ đang có không phải loại Samsung. Tạo chứng chỉ chọn Samsung › TV.':'Chưa có chứng chỉ Samsung. Làm bước 3 rồi bấm Kiểm tra lại.');
  if(st.ip&&!$('dkTzIp').value) $('dkTzIp').value=st.ip;
  $('dkTzDone').hidden=!st.installed;
  if(st.installed){ window.hsTzOpen=openOnTv; $('dkTzSum').textContent='Cài lại / cập nhật app trên TV Samsung'; $('dkTzGo').textContent='Cài lại'; $('dkTz').open=false; }
  if(A.tvState) A.tvState();
}
function refresh(){ return D.samsung.state().then(draw).then(tvCheck); }
D.samsung.onProgress(function(t){ msg('',t); });
$('dkTzCheck').onclick=function(){ msg('',''); refresh(); };
$('dkTzIp').addEventListener('change',tvCheck);
$('dkTzFind').onclick=function(){
  var b=this; b.disabled=true; b.textContent='Đang tìm...'; $('dkTzList').innerHTML='';
  D.samsung.find().then(function(list){
    b.disabled=false; b.textContent='Tìm TV Samsung';
    if(!list||!list.length){ msg('warn','Chưa thấy TV Samsung nào. Kiểm tra TV đang bật và cùng mạng, hoặc xem IP trên TV (Cài đặt › Chung › Mạng › Trạng thái mạng) rồi gõ vào.'); return; }
    msg('',''); if(list.length===1){ $('dkTzIp').value=list[0].ip; tvCheck(); }
    $('dkTzList').innerHTML=list.map(function(x){ return '<button class="hs-btn" type="button" data-ip="'+esc(x.ip)+'">'+esc(x.name)+' · '+esc(x.ip)+'</button>'; }).join('');
    [].forEach.call($('dkTzList').querySelectorAll('[data-ip]'),function(el){ el.onclick=function(){ $('dkTzIp').value=el.getAttribute('data-ip'); tvCheck(); }; });
  });
};
$('dkTzGo').onclick=function(){
  if(busy) return;
  var ip=$('dkTzIp').value.trim();
  if(!ip){ msg('warn','Gõ IP của TV Samsung, hoặc bấm Tìm TV Samsung.'); return; }
  busy=true; this.disabled=true;
  if(A.tvType()!=='samsung') A.setTvType('samsung');
  var b=this, c=code();
  D.samsung.install(ip,$('dkTzProf').value,c).then(function(r){
    busy=false; b.disabled=false;
    if(r&&r.ok){ msg('ok','Đã cài xong và mở Hóng Sub trên TV. TV tự nối với máy tính (mã '+c+'). Chọn cổng HDMI của máy PS5 ở ô bên dưới là phụ đề nằm trên hình game.'); if(A.toast) A.toast('Đã cài Hóng Sub lên TV Samsung'); refresh(); }
    else msg('err',(r&&r.err)||'Chưa cài được.');
  });
};
$('dkTzOpen').onclick=function(){ openOnTv(); };
refresh();
})();

/* ---------- this computer on the home network: shown in every TV guide (found by itself, checked again every minute) ---------- */
(function(){
  var D=window.hsDeskApi; if(!D||!D.netInfo) return;
  function fill(n){
    if(!n||!n.ip) return;
    var pre=n.ip.split('.').slice(0,3).join('.')+'.';
    var html='Máy tính này: IP <b>'+n.ip+'</b>'+(n.port?', Hóng Sub nhận TV ở cổng <b>'+n.port+'</b>':'')+'. TV phải dùng chung mạng wifi/modem với máy tính: IP của TV thường bắt đầu bằng <b>'+pre+'</b>';
    document.querySelectorAll('[data-pcinfo]').forEach(function(el){ el.innerHTML=html; el.hidden=false; });
    ['hsTvGuidePcIp','dkTzPcIp'].forEach(function(id){ var el=document.getElementById(id); if(el) el.textContent=n.ip; });
    window.hsPcIp=n.ip;
  }
  function look(){ D.netInfo().then(fill).catch(function(){}); }
  look(); setInterval(look,60000);
  window.hsNetLook=look;
})();

/* ---------- how to put the TV app on each kind of TV ---------- */
(function(){
  var tzGo=document.getElementById('hsTvGuideTz'); if(tzGo) tzGo.addEventListener('click',function(){ var A2=window.hsApi; document.getElementById('hsTvGuide').classList.remove('open'); if(A2&&A2.setTvType) A2.setTvType('samsung'); var b=document.querySelector('[data-p=ketnoi]'); if(b) b.click(); setTimeout(function(){ var d=document.getElementById('dkTz'); if(d){ d.open=true; d.scrollIntoView({behavior:'smooth',block:'start'}); } },150); });
  var $=function(id){return document.getElementById(id);}, A=window.hsApi, D=window.hsDeskApi, m=$('hsTvGuide'); if(!m) return;
  function tab(g){
    m.querySelectorAll('.hs-tabs [data-g]').forEach(function(b){ b.setAttribute('aria-selected',b.dataset.g===g?'true':'false'); });
    m.querySelectorAll('.hs-gd').forEach(function(d){ d.hidden=d.dataset.g!==g; });
  }
  function open(g){
    var t=g||(A&&A.tvType&&A.tvType())||'android'; tab(t==='samsung'||t==='lg'?t:'android');
    m.classList.add('open'); var x=$('hsTvGuideX'); if(x) x.focus();
    if(window.hsNetLook) window.hsNetLook();
  }
  function close(){ m.classList.remove('open'); }
  m.querySelectorAll('.hs-tabs [data-g]').forEach(function(b){ b.addEventListener('click',function(){ tab(b.dataset.g); }); });
  $('hsTvGuideX').addEventListener('click',close);
  m.addEventListener('click',function(e){ if(e.target===m) close(); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&m.classList.contains('open')) close(); });
  document.querySelectorAll('[data-tvguide]').forEach(function(b){ b.addEventListener('click',function(){ open(b.dataset.tvguide); }); });
  window.hsTvGuide=open;
})();
