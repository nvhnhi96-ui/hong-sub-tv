/* Hóng Sub: đọc chữ ngay trên máy (PaddleOCR PP-OCRv3, Apache-2.0) chạy bằng onnxruntime-web.
   HsOcr.init(base) rồi HsOcr.read(canvas) -> {lines:[{text,conf,x,y,w,h}], text, conf, ms} */
(function(){
'use strict';
var ort=null, det=null, rec=null, chars=null, loading=null, BASE='', ORT='';
function script(src){ return new Promise(function(ok,bad){ var s=document.createElement('script'); s.src=src; s.async=true; s.onload=ok; s.onerror=function(){bad(new Error('Không tải được '+src));}; document.head.appendChild(s); }); }
async function init(base,ortBase){
  if(det&&rec) return true;
  if(loading) return loading;
  BASE=new URL(base.replace(/\/?$/,'/'),location.href).href; ORT=new URL((ortBase||BASE).replace(/\/?$/,'/'),location.href).href;
  loading=(async function(){
    if(!window.ort) await script(ORT+'ort.wasm.min.js');
    ort=window.ort;
    ort.env.wasm.wasmPaths=ORT;
    ort.env.wasm.numThreads=(self.crossOriginIsolated&&navigator.hardwareConcurrency)?Math.min(4,navigator.hardwareConcurrency):1;
    var opt={executionProviders:['wasm'],graphOptimizationLevel:'all'};
    var r=await Promise.all([
      fetch(BASE+'det.onnx').then(function(x){if(!x.ok) throw new Error('det '+x.status); return x.arrayBuffer();}),
      fetch(BASE+'rec.onnx').then(function(x){if(!x.ok) throw new Error('rec '+x.status); return x.arrayBuffer();}),
      fetch(BASE+'keys.txt').then(function(x){if(!x.ok) throw new Error('keys '+x.status); return x.text();})
    ]);
    det=await ort.InferenceSession.create(new Uint8Array(r[0]),opt);
    rec=await ort.InferenceSession.create(new Uint8Array(r[1]),opt);
    chars=['']; r[2].split(/\r?\n/).forEach(function(c){ if(c!=='') chars.push(c); }); chars.push(' ');
    return true;
  })().catch(function(e){ loading=null; throw e; });
  return loading;
}

var cv=document.createElement('canvas'), cx=cv.getContext('2d',{willReadFrequently:true});
function pixels(src,sx,sy,sw,sh,dw,dh){
  cv.width=dw; cv.height=dh; cx.imageSmoothingEnabled=true; cx.imageSmoothingQuality='high';
  cx.drawImage(src,sx,sy,sw,sh,0,0,dw,dh);
  return cx.getImageData(0,0,dw,dh).data;
}

/* ---- detection ---- */
async function detect(src,W,H){
  var lim=960, s=Math.min(1,lim/Math.max(W,H));
  var dw=Math.max(32,Math.round(W*s/32)*32), dh=Math.max(32,Math.round(H*s/32)*32);
  var d=pixels(src,0,0,W,H,dw,dh), n=dw*dh, t=new Float32Array(3*n);
  var M=[0.485,0.456,0.406], SD=[0.229,0.224,0.225];
  for(var i=0;i<n;i++){ /* channel order B,G,R like PaddleOCR (OpenCV) */
    t[i]=(d[i*4+2]/255-M[0])/SD[0]; t[n+i]=(d[i*4+1]/255-M[1])/SD[1]; t[2*n+i]=(d[i*4]/255-M[2])/SD[2];
  }
  var out=await det.run({x:new ort.Tensor('float32',t,[1,3,dh,dw])});
  var p=out[det.outputNames[0]].data;
  /* connected regions of the probability map */
  var lab=new Int32Array(n), boxes=[], stack=new Int32Array(n), id=0;
  for(var k=0;k<n;k++){
    if(lab[k]||p[k]<0.3) continue;
    id++; var sp=0, x0=1e9,y0=1e9,x1=-1,y1=-1,sum=0,cnt=0; stack[sp++]=k; lab[k]=id;
    while(sp){
      var q=stack[--sp], qx=q%dw, qy=(q/dw)|0; sum+=p[q]; cnt++;
      if(qx<x0)x0=qx; if(qx>x1)x1=qx; if(qy<y0)y0=qy; if(qy>y1)y1=qy;
      if(qx>0&&!lab[q-1]&&p[q-1]>=0.3){lab[q-1]=id; stack[sp++]=q-1;}
      if(qx<dw-1&&!lab[q+1]&&p[q+1]>=0.3){lab[q+1]=id; stack[sp++]=q+1;}
      if(qy>0&&!lab[q-dw]&&p[q-dw]>=0.3){lab[q-dw]=id; stack[sp++]=q-dw;}
      if(qy<dh-1&&!lab[q+dw]&&p[q+dw]>=0.3){lab[q+dw]=id; stack[sp++]=q+dw;}
    }
    var bw=x1-x0+1, bh=y1-y0+1;
    if(Math.min(bw,bh)<3||sum/cnt<0.5) continue;
    var dist=bw*bh*1.6/(2*(bw+bh)); /* "unclip" like DBNet */
    boxes.push({x:(x0-dist)/dw*W, y:(y0-dist)/dh*H, w:(bw+2*dist)/dw*W, h:(bh+2*dist)/dh*H});
  }
  boxes.forEach(function(b){ b.x=Math.max(0,b.x); b.y=Math.max(0,b.y); b.w=Math.min(W-b.x,b.w); b.h=Math.min(H-b.y,b.h); });
  return boxes.filter(function(b){return b.w>4&&b.h>4;});
}

/* ---- recognition ---- */
async function recognize(src,b){
  var IH=48, IW=Math.min(1600,Math.max(48,Math.ceil(IH*b.w/b.h/8)*8));
  var d=pixels(src,b.x,b.y,b.w,b.h,IW,IH), n=IW*IH, t=new Float32Array(3*n);
  for(var i=0;i<n;i++){ t[i]=d[i*4+2]/127.5-1; t[n+i]=d[i*4+1]/127.5-1; t[2*n+i]=d[i*4]/127.5-1; }
  var out=await rec.run({x:new ort.Tensor('float32',t,[1,3,IH,IW])});
  var o=out[rec.outputNames[0]], T=o.dims[1], C=o.dims[2], p=o.data;
  var s='', last=0, conf=0, m=0;
  for(var j=0;j<T;j++){
    var best=0, bv=-1, base=j*C;
    for(var c=0;c<C;c++){ if(p[base+c]>bv){bv=p[base+c]; best=c;} }
    if(best!==0&&best!==last){ s+=chars[best]||''; conf+=bv; m++; }
    last=best;
  }
  return {text:s.trim(), conf:m?conf/m:0};
}

/* boxes on the same text line are joined left to right */
function lineUp(items){
  items.sort(function(a,b){return (a.y+a.h/2)-(b.y+b.h/2);});
  var lines=[];
  items.forEach(function(it){
    var L=lines[lines.length-1];
    if(L&&Math.abs((it.y+it.h/2)-(L.y+L.h/2))<Math.min(it.h,L.h)*0.5){ L.parts.push(it); L.y=Math.min(L.y,it.y); L.h=Math.max(L.y+L.h,it.y+it.h)-L.y; }
    else lines.push({y:it.y,h:it.h,parts:[it]});
  });
  return lines.map(function(L){
    L.parts.sort(function(a,b){return a.x-b.x;});
    var text=L.parts.map(function(p){return p.text;}).join(' ').replace(/\s+/g,' ').trim();
    var conf=L.parts.reduce(function(a,p){return a+p.conf*p.text.length;},0)/Math.max(1,L.parts.reduce(function(a,p){return a+p.text.length;},0));
    var x=Math.min.apply(null,L.parts.map(function(p){return p.x;})), x2=Math.max.apply(null,L.parts.map(function(p){return p.x+p.w;}));
    return {text:text,conf:conf,x:x,y:L.y,w:x2-x,h:L.h};
  }).filter(function(l){return l.text;});
}

async function read(src,opts){
  if(!det||!rec) throw new Error('OCR chưa sẵn sàng');
  var t0=performance.now(), W=src.width, H=src.height;
  var boxes=await detect(src,W,H), items=[];
  if(opts&&opts.maxBoxes) boxes=boxes.slice(0,opts.maxBoxes);
  for(var i=0;i<boxes.length;i++){ var r=await recognize(src,boxes[i]); if(r.text){ boxes[i].text=r.text; boxes[i].conf=r.conf; items.push(boxes[i]); } }
  var lines=lineUp(items);
  var tl=lines.reduce(function(a,l){return a+l.text.length;},0);
  return {lines:lines, text:lines.map(function(l){return l.text;}).join('\n'), conf:tl?lines.reduce(function(a,l){return a+l.conf*l.text.length;},0)/tl:0, ms:Math.round(performance.now()-t0)};
}

window.HsOcr={init:init, read:read, ready:function(){return !!(det&&rec);}};
})();
