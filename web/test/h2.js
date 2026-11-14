(function(){
if(window.HSRUN) return 'already';
window.HSRUN=true;
var SCENES=[
  {id:'basic', bg:'calm', dur:3800, style:{size:30},
   lines:['We should rest here tonight. The road ahead is dangerous.','I never wanted any of this. I just wanted to go home.','Keep your voice down. They can hear us from the tower.','If we leave now, we can reach the village before dark.','You saved my life back there. I won\'t forget it.','Stay behind me and don\'t touch anything.','The old bridge collapsed years ago. We\'ll need another way across.','Whatever happens, we finish this together.']},
  {id:'speaker', bg:'cave', dur:4000, style:{size:30,nameColor:'#7CC4FF'},
   lines:['MARA: Did you hear that? Something is moving in the trees.','OREN: It\'s just the wind. Keep walking.','MARA: You said that last time, right before the wolves showed up.','OREN: Fine. Draw your bow and watch the left side.','ELDER VASK: Strangers are not welcome in this valley.','MARA: We only need supplies. We\'ll be gone by morning.','ELDER VASK: Then pay what you owe, and keep your weapons sheathed.','OREN: Thank you, Elder. We mean no harm.']},
  {id:'action', bg:'action', dur:3200, style:{size:30},
   lines:['Get down! They\'re shooting from the rooftops!','I\'m out of ammo. Cover me while I reload!','Move to the truck, now! We\'re leaving!','Hold on to something, this is going to hurt.','They\'re right behind us. Faster!','The bridge is out! Hang on, I\'m going to jump it!']},
  {id:'snow', bg:'snow', dur:3800, style:{size:30},
   lines:['It\'s freezing. We won\'t survive another night out here.','Look, smoke over the hill. Someone made a fire.','Stay on the path. The ice is thin near the lake.','Your hands are shaking. Take my gloves.','We\'ll reach the outpost by noon if the storm holds off.']},
  {id:'rolling', bg:'calm', dur:3600, mode:'rolling', style:{size:28,box:true},
   lines:['The ship arrived three days ago.','Nobody has come off it since.','The harbor master sent two men to check.','Neither of them came back.','So tonight, we go aboard ourselves.','Bring lanterns, and bring rope.']},
  {id:'yellow', bg:'space', dur:3800, style:{size:22,color:'#FFD34D',weight:500},
   lines:['Captain, the engines are failing. We\'re losing altitude.','Divert all power to the shields and brace for impact.','Sensors show a second ship behind the moon.','Open a channel. I want to hear what they have to say.','Sir, they\'re not answering. Their weapons are online.']},
  {id:'fast', bg:'action', dur:1600, gap:true, style:{size:30},
   lines:['Over here, quickly!','Watch out, on your right!','I\'ve got him, go!','Grab the key and run!','The door is locked, find another way!','Behind you!','Let\'s go, let\'s go!','We did it. We actually did it.']},
  {id:'twoline', bg:'cave', dur:5200, style:{size:28},
   lines:['I spent ten years looking for the people who burned my village,\nand now that I found them, I don\'t know what to do.','The map says the temple is on the other side of the mountain,\nbut nobody who went there ever came back to tell us.','If you open that door, there is no going back.\nWhatever is inside will follow us forever.']},
  {id:'hud', bg:'calm', dur:3000, style:{size:28},
   lines:[{text:'Press ✕ to open the gate',expect:'skip'},{text:'Finally. I thought we\'d never get inside.',expect:'translate'},{text:'+250 XP',expect:'skip'},{text:'Something feels wrong. It\'s too quiet in here.',expect:'translate'},{text:'Hold □ to pick up',expect:'skip'},{text:'Don\'t worry. I\'ve been in worse places than this.',expect:'translate'}]},
];


var W=1280,H=720,cv=document.createElement('canvas'); cv.width=W; cv.height=H; var x=cv.getContext('2d');
function rnd(i){ var s=Math.sin(i*12.9898)*43758.5453; return s-Math.floor(s); }
function bgCalm(t){
  var g=x.createLinearGradient(0,0,0,H); g.addColorStop(0,'#2B2F55'); g.addColorStop(.55,'#B35A55'); g.addColorStop(1,'#2A1C2A'); x.fillStyle=g; x.fillRect(0,0,W,H);
  x.fillStyle='rgba(255,214,140,.9)'; x.beginPath(); x.arc(860,300+Math.sin(t/4000)*6,70,0,7); x.fill();
  x.fillStyle='#3B2440'; x.beginPath(); x.moveTo(0,470); for(var i=0;i<=16;i++){ x.lineTo(i*80, 430-rnd(i)*120); } x.lineTo(W,H); x.lineTo(0,H); x.fill();
  x.fillStyle='#1E1424'; x.beginPath(); x.moveTo(0,560); for(var j=0;j<=10;j++){ x.lineTo(j*128, 520-rnd(j+40)*70); } x.lineTo(W,H); x.lineTo(0,H); x.fill();
  x.fillStyle='#0E0A12'; x.fillRect(470,470,34,100); x.fillRect(520,450,40,120);
}
function bgAction(t){
  x.fillStyle='#3A2B1E'; x.fillRect(0,0,W,H);
  for(var i=0;i<40;i++){
    var s=t/(300+rnd(i)*500), px=((rnd(i+1)*W+s*90*(i%2?1:-1))%(W+300)+W+300)%(W+300)-150, py=rnd(i+7)*H;
    x.fillStyle='hsl('+Math.round(rnd(i+3)*60+10)+','+Math.round(40+rnd(i)*50)+'%,'+Math.round(25+rnd(i+9)*60)+'%)';
    x.fillRect(px,py,60+rnd(i+2)*240,30+rnd(i+5)*140);
  }
  if(Math.floor(t/700)%4===0){ x.fillStyle='rgba(255,240,200,.35)'; x.fillRect(0,0,W,H); }   /* explosion flash */
  for(var k=0;k<14;k++){ x.fillStyle='rgba(255,255,255,.85)'; x.fillRect(((t*0.6+k*97)%W),((k*53+t*0.3)%H),4,26); }  /* sparks over the subtitle area */
}
function bgSnow(t){
  var g=x.createLinearGradient(0,0,0,H); g.addColorStop(0,'#DCE6EE'); g.addColorStop(1,'#F7FAFC'); x.fillStyle=g; x.fillRect(0,0,W,H);
  x.fillStyle='#B9C7D3'; x.beginPath(); x.moveTo(0,420); for(var i=0;i<=8;i++){ x.lineTo(i*160,330-rnd(i+20)*140); } x.lineTo(W,H); x.lineTo(0,H); x.fill();
  x.fillStyle='#FFFFFF'; x.fillRect(0,520,W,200);
  for(var k=0;k<120;k++){ x.fillStyle='rgba(255,255,255,.95)'; var sy=(rnd(k)*H+t*(0.04+rnd(k+4)*0.08))%H; x.beginPath(); x.arc((rnd(k+1)*W+Math.sin(t/900+k)*20),sy,2+rnd(k+2)*3,0,7); x.fill(); }
}
function bgCave(t){
  x.fillStyle='#07080B'; x.fillRect(0,0,W,H);
  var fl=.6+.4*Math.sin(t/120)*Math.sin(t/77);
  var g=x.createRadialGradient(640,420,20,640,420,520); g.addColorStop(0,'rgba(255,150,60,'+(.35*fl+.2)+')'); g.addColorStop(1,'rgba(0,0,0,0)'); x.fillStyle=g; x.fillRect(0,0,W,H);
  x.fillStyle='#15181F'; for(var i=0;i<12;i++){ x.beginPath(); x.moveTo(i*120,0); x.lineTo(i*120+60,90+rnd(i)*120); x.lineTo(i*120+120,0); x.fill(); }
}
function bgSpace(t){
  x.fillStyle='#04060D'; x.fillRect(0,0,W,H);
  for(var i=0;i<220;i++){ var b=.4+.6*rnd(i+3); x.fillStyle='rgba(255,255,255,'+b+')'; x.fillRect(((rnd(i)*W-t*0.02*(1+rnd(i+1)*3))%W+W)%W,rnd(i+2)*H,2,2); }
  x.fillStyle='#1C2A44'; x.beginPath(); x.arc(980,240,150,0,7); x.fill();
  x.strokeStyle='#5AA9FF'; x.lineWidth=3; x.strokeRect(80,80,1120,560);   /* cockpit frame */
  x.fillStyle='rgba(90,169,255,.18)'; x.fillRect(80,560,1120,80);
}
var BG={calm:bgCalm,action:bgAction,snow:bgSnow,cave:bgCave,space:bgSpace,};
function subLine(text,y,style){
  var size=style.size||30, m=/^([A-Z][A-Z .'-]{0,24}):\s+(.*)$/.exec(text);
  x.font=(style.weight||600)+' '+size+'px "Segoe UI",Arial'; x.textAlign='left'; x.lineJoin='round';
  var name=m?m[1]+': ':'', body=m?m[2]:text, wn=x.measureText(name).width, wb=x.measureText(body).width, sx=640-(wn+wb)/2;
  if(style.box){ x.fillStyle='rgba(0,0,0,.62)'; x.fillRect(sx-14,y-size+2,wn+wb+28,size+16); }
  x.lineWidth=Math.max(3,size/7); x.strokeStyle='rgba(0,0,0,.85)'; x.strokeText(name,sx,y); x.strokeText(body,sx+wn,y);
  if(name){ x.fillStyle=style.nameColor||'#7CC4FF'; x.fillText(name,sx,y); }
  x.fillStyle=style.color||'#FFFFFF'; x.fillText(body,sx+wn,y);
}
var CF=window.HSCFG||{}; if(CF.scenes) SCENES=SCENES.filter(function(sc){return CF.scenes.indexOf(sc.id)>=0;});
var plan=[]; SCENES.forEach(function(sc){ if(sc.mode==='menu') return; sc.lines.forEach(function(L,i){ plan.push({sc:sc,i:i,text:L.text||L,expect:L.expect||'translate',dur:sc.dur||3500}); }); });
var R={shown:[],out:[],start:Date.now(),done:false,status:[],log:[]};
window.HSTEST=R;
var cur=-1, curT=0, gapUntil=0;
function frame(){
  var now=Date.now(), t=performance.now();
  if(cur<0||now-curT>plan[cur].dur){
    cur++; if(cur>=plan.length){ R.done=true; finish(); return; }
    curT=now; var p=plan[cur]; gapUntil=p.sc.gap?now+200:0;
    R.shown.push({k:cur,scene:p.sc.id,text:p.text,expect:p.expect,t:now-R.start});
  }
  var p=plan[cur], sc=p.sc;
  (BG[sc.bg]||bgCalm)(t);
  if(now>=gapUntil){
    if(sc.mode==='rolling'){ var prev=sc.lines[p.i-1]; if(prev) subLine(prev.text||prev,600,sc.style); subLine(p.text,648,sc.style); }
    else { var parts=p.text.split('\n'); parts.forEach(function(q,i){ subLine(q,648-(parts.length-1-i)*((sc.style.size||30)+12),sc.style); }); }
  }
  setTimeout(frame,33);
}
var S=window.__hongsub, A=window.hsApi, SEEN=new WeakSet(); (S.hist||[]).forEach(function(h){SEEN.add(h);});
var spk=document.getElementById('hsSpeak'), spkWas=spk.checked; spk.checked=false;
var LG=A.logs?A.logs():null, lgN=LG?LG.length:0;
var poll=setInterval(function(){
  if(LG){ while(lgN<LG.length){ R.log.push((Date.now()-R.start)+' '+LG[lgN++].slice(9)); } }
  S.hist.forEach(function(h){ if(!SEEN.has(h)){ SEEN.add(h); R.out.push({en:h.en,vi:h.vi,who:h.who,t:Date.now()-R.start,via:S.via}); } });
  var st=document.getElementById('hsStatusTxt').textContent; if(!R.status.length||R.status[R.status.length-1].s!==st) R.status.push({s:st,t:Date.now()-R.start});
},80);
function finish(){ clearInterval(poll); A.stop(); spk.checked=spkWas; }
navigator.mediaDevices.getDisplayMedia=function(){ return Promise.resolve(cv.captureStream(30)); };
setTimeout(frame,33);
S.region={x:.08,y:.78,w:.84,h:.18};
A.pick(false).then(function(){ setTimeout(function(){ R.startAt=Date.now()-R.start; A.start(); },CF.startDelay==null?500:CF.startDelay); });
window.HSTEST_STARTED='started '+plan.length+' lines';
})();
