// =============================================================================
// WHEP VISION SENTINEL V10 — DUAL-BOX + HYBRID OPTICAL FLOW + EVIDENCE REID
// =============================================================================
// Design goals:
// 1) Preserve the proven WHEP live path.
// 2) Keep TWO geometries per object: PERSON box for OSNet, HEAD box for overlay.
// 3) Run sparse visual tracking on every fresh decoded frame between slow YOLO anchors.
// 4) Associate detections with motion-aware cost (IoU + center + scale), not IoU alone.
// 5) Suppress duplicate detections/tracks and expire ghosts by detector misses + visual loss.
// 6) Replace binary ReID counters with temporal evidence: RAW / EMA / variance / confidence.

const WIDTH: i32 = 800;
const HEIGHT: i32 = 680;
export const pixels = new Uint32Array(WIDTH * HEIGHT);
export function getWidth(): i32 { return WIDTH; }
export function getHeight(): i32 { return HEIGHT; }

const VP_X: i32 = 20;
const VP_Y: i32 = 105;
const VP_W: i32 = 510;
const VP_H: i32 = 330;
const PANEL_X: i32 = 540;
const PANEL_Y: i32 = 105;
const PANEL_W: i32 = 240;
const PANEL_H: i32 = 540;

let currentStreamUrl: string = "http://127.0.0.1:8889/live/whep";
let activeWsId: i32 = -1;
let isStreaming: bool = false;
let isEditingUrl: bool = false;
let statusMessage: string = "READY // LOAD MODELS + REFERENCE";
let mouseX: i32 = 0;
let mouseY: i32 = 0;
let lastFrameTimestamp: f64 = 0.0;
let liveFrameSeq: i32 = 0;       // host AI frame sequence / detector time base
let videoFrameSeq: i32 = 0;      // increments on every decoded video callback
let lastVisualFrameSeq: i32 = -1;

// ---------- Stream telemetry ----------
const ST_MEDIA_BITRATE: i32 = 4;
const ST_LOSS_PCT: i32 = 8;
const ST_DECODE_FPS: i32 = 12;
const ST_WIDTH: i32 = 14;
const ST_HEIGHT: i32 = 15;
const ST_JITTER_MS: i32 = 16;
const ST_JBUF_MS: i32 = 17;
const ST_RTT_MS: i32 = 22;
const ST_FAST_PATH_MODE: i32 = 40;
const ST_TRACK_FPS: i32 = 42;
const ST_TRACK_CANVAS_MS: i32 = 49;
let mediaBitrateBps: f64 = 0.0;
let packetLossPct: f64 = 0.0;
let decodeFps: f64 = 0.0;
let statWidth: f64 = 320.0;
let statHeight: f64 = 240.0;
let jitterMs: f64 = -1.0;
let jitterBufferMs: f64 = -1.0;
let rttMs: f64 = -1.0;
let fastPathMode: f64 = 0.0;
let trackFps: f64 = 0.0;
let trackCanvasMs: f64 = -1.0;
let lastStreamPoll: f64 = 0.0;

// ---------- AI host stats ----------
let detectorState: i32 = 0;
let reidState: i32 = 0;
let referenceState: i32 = 0;
let aiEnabled: bool = false;
let detectorInferMs: f64 = -1.0;
let detectorFps: f64 = 0.0;
let detectorCount: i32 = 0;
let reidAvgMs: f64 = -1.0;
let reidQueue: i32 = 0;
let reidBusy: i32 = 0;
let reidWorkers: i32 = 2;
let reidTotal: i32 = 0;
let hostHits: i32 = 0;
let detectorDropped: i32 = 0;
let reidDropped: i32 = 0;
let embeddingDim: i32 = 0;
let lastSimilarity: f64 = -1.0;
let detectorIntervalMs: f64 = 100.0;
let lastAiPoll: f64 = 0.0;
let lastDetectorBatchMs: f64 = -1.0;
let lastDetectorFrameSeq: i32 = 0;

// ---------- Identity policy ----------
// IMPORTANT: This is a decision threshold on OSNet cosine, not a display confidence.
// Confidence is derived temporally from repeated evidence and quality weighting.
let reidThreshold: f64 = 0.62;
let lockConfidencePct: f64 = 92.0;
let confirmationsRequired: i32 = 2;
const REID_RETRY_FRAMES: i32 = 8;
const REID_LOCKED_REVERIFY_FRAMES: i32 = 45;
const REID_REJECT_RETRY_FRAMES: i32 = 30;
const REID_MAX_ATTEMPTS_BEFORE_COOLDOWN: i32 = 12;

// ---------- Hybrid tracking tuning ----------
const HEAD_HEIGHT_RATIO: f64 = 0.45;
const HEAD_ASPECT_W_OVER_H: f64 = 0.85;
const MAX_DETECTOR_MISSES: i32 = 2;
const MAX_VISUAL_FAILS_HIDE: i32 = 4;
const MAX_VISUAL_FAILS_REMOVE: i32 = 8;
const DUP_TRACK_IOU: f64 = 0.72;
const DUP_TRACK_CENTER: f64 = 0.18;
const DET_NMS_IOU: f64 = 0.70;

// Sparse optical-flow tracker parameters.
const FLOW_POINTS: i32 = 24;
const PATCH_RADIUS: i32 = 2;       // 5x5 patch
const FLOW_COARSE_RADIUS: i32 = 6; // source pixels
const FLOW_FINE_RADIUS: i32 = 2;
const FLOW_MIN_POINTS: i32 = 6;
const FLOW_MIN_QUALITY: f64 = 0.34;

// ---------- Utilities ----------
function clamp64(v: f64, lo: f64, hi: f64): f64 { return v < lo ? lo : (v > hi ? hi : v); }
function clamp32(v: i32, lo: i32, hi: i32): i32 { return v < lo ? lo : (v > hi ? hi : v); }
function maxi(a:i32,b:i32):i32{return a>b?a:b;}
function mini(a:i32,b:i32):i32{return a<b?a:b;}
function abs64(v:f64):f64{return v<0.0?-v:v;}
function fmt1(v: f64): string { if (v < 0.0) return "--"; return (Math.round(v * 10.0) / 10.0).toString(); }
function fmt2(v: f64): string { if (v < 0.0) return "--"; return (Math.round(v * 100.0) / 100.0).toString(); }
function fmtPct(v:f64):string { if(v<0.0)return "--"; return (Math.round(v*10.0)/10.0).toString()+"%"; }
function fmtMbps(bps: f64): string { return (Math.round((bps / 1000000.0) * 1000.0) / 1000.0).toString() + " Mb/s"; }
function stateWord(s: i32): string { return s == 2 ? "READY" : (s == 1 ? "LOAD" : (s < 0 ? "ERR" : "NONE")); }
function stateColor(s: i32): u32 { return s == 2 ? rgba(0,255,157) : (s < 0 ? rgba(255,70,85) : rgba(255,190,70)); }
function sigmoid(x:f64):f64 { return 1.0/(1.0+Math.exp(-x)); }
function safeSqrt(x:f64):f64 { return x<=0.0?0.0:Math.sqrt(x); }

function drawThickFrame(x: i32, y: i32, w: i32, h: i32, color: u32, thickness: i32 = 2): void {
  if(w<2 || h<2) return;
  for (let i: i32 = 0; i < thickness; i++) {
    if(w-i*2>1 && h-i*2>1) drawFrame(x + i, y + i, w - i * 2, h - i * 2, color);
  }
}

function drawButton(x: i32, y: i32, w: i32, h: i32, label: string, color: u32): void {
  let hover = mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h;
  drawRect(x, y, w, h, hover ? color : rgba(25, 33, 48));
  drawFrame(x, y, w, h, hover ? rgba(235,250,255) : rgba(48,64,90));
  drawRect(x, y, w, 2, color);
  drawText(label, x + 7, y + (h / 2) - 4, rgba(245,250,255), 1);
}

// =============================================================================
// DUAL GEOMETRY DETECTION
// =============================================================================
class Detection {
  // Original PERSON box from YOLO. This is what OSNet must receive.
  px1:f64; py1:f64; px2:f64; py2:f64;
  // Derived HEAD box for overlay / sparse visual tracking only.
  hx1:f64; hy1:f64; hx2:f64; hy2:f64;
  score:f64;

  constructor(px1:f64,py1:f64,px2:f64,py2:f64,hx1:f64,hy1:f64,hx2:f64,hy2:f64,score:f64){
    this.px1=px1;this.py1=py1;this.px2=px2;this.py2=py2;
    this.hx1=hx1;this.hy1=hy1;this.hx2=hx2;this.hy2=hy2;
    this.score=score;
  }
}

function boxIou(ax1:f64,ay1:f64,ax2:f64,ay2:f64,bx1:f64,by1:f64,bx2:f64,by2:f64):f64{
  let xx1=Math.max(ax1,bx1), yy1=Math.max(ay1,by1);
  let xx2=Math.min(ax2,bx2), yy2=Math.min(ay2,by2);
  let w=Math.max(0.0,xx2-xx1), h=Math.max(0.0,yy2-yy1);
  let inter=w*h;
  let aa=Math.max(0.0,ax2-ax1)*Math.max(0.0,ay2-ay1);
  let bb=Math.max(0.0,bx2-bx1)*Math.max(0.0,by2-by1);
  return inter/Math.max(0.000001,aa+bb-inter);
}

function headFromPerson(px1:f64,py1:f64,px2:f64,py2:f64,sw:f64,sh:f64):Float64Array{
  let fullH=Math.max(4.0,py2-py1);
  let hh=fullH*HEAD_HEIGHT_RATIO;
  let hy1=clamp64(py1,0.0,sh-4.0);
  let hy2=clamp64(hy1+hh,4.0,sh);
  let hw=Math.max(4.0,(hy2-hy1)*HEAD_ASPECT_W_OVER_H);
  let cx=(px1+px2)*0.5;
  let hx1=clamp64(cx-hw*0.5,0.0,sw-4.0);
  let hx2=clamp64(cx+hw*0.5,4.0,sw);
  let out=new Float64Array(4);
  out[0]=hx1;out[1]=hy1;out[2]=hx2;out[3]=hy2;
  return out;
}

// NMS after head conversion. This suppresses duplicate person detections that would
// otherwise create two nearly identical head tracks.
function suppressDuplicateDetections(src:Array<Detection>):Array<Detection>{
  let sorted=new Array<Detection>();
  for(let i=0;i<src.length;i++){
    // AssemblyScript Array.splice() does not support JS-style insertion items.
    // Append, then perform an allocation-free insertion-sort step in place.
    sorted.push(src[i]);
    let j:i32=sorted.length-1;
    while(j>0 && sorted[j].score>sorted[j-1].score){
      let tmp=sorted[j-1];
      sorted[j-1]=sorted[j];
      sorted[j]=tmp;
      j--;
    }
  }
  let out=new Array<Detection>();
  for(let i=0;i<sorted.length;i++){
    let keep=true;
    for(let j=0;j<out.length;j++){
      let hov=boxIou(sorted[i].hx1,sorted[i].hy1,sorted[i].hx2,sorted[i].hy2,out[j].hx1,out[j].hy1,out[j].hx2,out[j].hy2);
      let pov=boxIou(sorted[i].px1,sorted[i].py1,sorted[i].px2,sorted[i].py2,out[j].px1,out[j].py1,out[j].px2,out[j].py2);
      if(hov>=DET_NMS_IOU || pov>=0.82){keep=false;break;}
    }
    if(keep) out.push(sorted[i]);
  }
  return out;
}

// =============================================================================
// TRACK STATE — PERSON MOTION + HEAD VISUAL FLOW + IDENTITY EVIDENCE
// =============================================================================
class Track {
  id:i32;

  // PERSON state in source coordinates (used for association + OSNet crop).
  pcx:f64; pcy:f64; pw:f64; ph:f64;
  pvcx:f64=0.0; pvcy:f64=0.0; pvw:f64=0.0; pvh:f64=0.0;

  // Detector-derived head anchor in source coordinates.
  anchorHcx:f64; anchorHcy:f64; anchorHw:f64; anchorHh:f64;

  // Visual head tracking state in source coordinates.
  hcx:f64; hcy:f64; hw:f64; hh:f64;
  hvx:f64=0.0; hvy:f64=0.0;

  // Display-smoothed head state (separate from tracking state).
  dcx:f64; dcy:f64; dw:f64; dh:f64;

  score:f64;
  lastDetectorFrame:i32;
  lastDetectorBatchSerial:i32=0;
  detectorMisses:i32=0;
  hits:i32=1;
  updatedThisBatch:bool=true;
  visible:bool=true;

  // Sparse flow / feature state.
  fx:Float64Array=new Float64Array(FLOW_POINTS);
  fy:Float64Array=new Float64Array(FLOW_POINTS);
  fvalid:Uint8Array=new Uint8Array(FLOW_POINTS);
  fpatch:Float64Array=new Float64Array(FLOW_POINTS*25);
  flowDx:Float64Array=new Float64Array(FLOW_POINTS);
  flowDy:Float64Array=new Float64Array(FLOW_POINTS);
  flowOldX:Float64Array=new Float64Array(FLOW_POINTS);
  flowOldY:Float64Array=new Float64Array(FLOW_POINTS);
  flowNewX:Float64Array=new Float64Array(FLOW_POINTS);
  flowNewY:Float64Array=new Float64Array(FLOW_POINTS);
  flowRobustDx:Float64Array=new Float64Array(FLOW_POINTS);
  flowRobustDy:Float64Array=new Float64Array(FLOW_POINTS);
  flowPointCount:i32=0;
  flowQuality:f64=0.0;
  flowFails:i32=0;
  needsFeatureSeed:bool=true;
  lastFlowDx:f64=0.0;
  lastFlowDy:f64=0.0;

  // ReID / evidence state.
  identityState:i32=0; // 0 unknown,1 pending,2 target,3 rejected,4 verify
  similarity:f64=-1.0;      // raw latest
  similarityEma:f64=-1.0;
  similarityVar:f64=0.0;
  bestSimilarity:f64=-1.0;
  identityLogOdds:f64=-2.2; // ~10% prior until positive evidence arrives
  identityConfidence:f64=10.0;
  positiveStreak:i32=0;
  negativeStreak:i32=0;
  positiveCount:i32=0;
  reidSamples:i32=0;
  reidAttempts:i32=0;
  lastReidFrame:i32=-100000;
  bestToken:i32=0;
  isLockedTarget:bool=false;
  hitSaved:bool=false;

  constructor(id:i32,d:Detection,seq:i32,batchSerial:i32){
    this.id=id;
    this.pcx=(d.px1+d.px2)*0.5; this.pcy=(d.py1+d.py2)*0.5;
    this.pw=Math.max(4.0,d.px2-d.px1); this.ph=Math.max(6.0,d.py2-d.py1);
    this.anchorHcx=(d.hx1+d.hx2)*0.5; this.anchorHcy=(d.hy1+d.hy2)*0.5;
    this.anchorHw=Math.max(4.0,d.hx2-d.hx1); this.anchorHh=Math.max(6.0,d.hy2-d.hy1);
    this.hcx=this.anchorHcx;this.hcy=this.anchorHcy;this.hw=this.anchorHw;this.hh=this.anchorHh;
    this.dcx=this.hcx;this.dcy=this.hcy;this.dw=this.hw;this.dh=this.hh;
    this.score=d.score;this.lastDetectorFrame=seq;this.lastDetectorBatchSerial=batchSerial;
  }

  predictPersonCx(seq:i32):f64{let dt=<f64>maxi(0,seq-this.lastDetectorFrame);return this.pcx+this.pvcx*dt;}
  predictPersonCy(seq:i32):f64{let dt=<f64>maxi(0,seq-this.lastDetectorFrame);return this.pcy+this.pvcy*dt;}
  predictPersonW(seq:i32):f64{let dt=<f64>maxi(0,seq-this.lastDetectorFrame);return Math.max(4.0,this.pw+this.pvw*dt);}
  predictPersonH(seq:i32):f64{let dt=<f64>maxi(0,seq-this.lastDetectorFrame);return Math.max(6.0,this.ph+this.pvh*dt);}

  personX1(seq:i32):f64{return this.predictPersonCx(seq)-this.predictPersonW(seq)*0.5;}
  personY1(seq:i32):f64{return this.predictPersonCy(seq)-this.predictPersonH(seq)*0.5;}
  personX2(seq:i32):f64{return this.predictPersonCx(seq)+this.predictPersonW(seq)*0.5;}
  personY2(seq:i32):f64{return this.predictPersonCy(seq)+this.predictPersonH(seq)*0.5;}

  updateFromDetection(d:Detection,seq:i32,batchSerial:i32):void{
    let dt=<f64>maxi(1,seq-this.lastDetectorFrame);
    let ncx=(d.px1+d.px2)*0.5, ncy=(d.py1+d.py2)*0.5;
    let nw=Math.max(4.0,d.px2-d.px1), nh=Math.max(6.0,d.py2-d.py1);
    let mvx=(ncx-this.pcx)/dt, mvy=(ncy-this.pcy)/dt;
    let mvw=(nw-this.pw)/dt, mvh=(nh-this.ph)/dt;

    // Alpha-beta style correction: velocity is conservative; position snaps enough to re-anchor.
    this.pvcx=this.pvcx*0.62+mvx*0.38;
    this.pvcy=this.pvcy*0.62+mvy*0.38;
    this.pvw=this.pvw*0.72+mvw*0.28;
    this.pvh=this.pvh*0.72+mvh*0.28;
    this.pcx=this.pcx*0.15+ncx*0.85;
    this.pcy=this.pcy*0.15+ncy*0.85;
    this.pw=this.pw*0.25+nw*0.75;
    this.ph=this.ph*0.25+nh*0.75;

    let ahcx=(d.hx1+d.hx2)*0.5, ahcy=(d.hy1+d.hy2)*0.5;
    let ahw=Math.max(4.0,d.hx2-d.hx1), ahh=Math.max(6.0,d.hy2-d.hy1);
    this.anchorHcx=ahcx;this.anchorHcy=ahcy;this.anchorHw=ahw;this.anchorHh=ahh;

    // If visual flow is healthy, detector is a correction, not a hard teleport.
    let anchorAlpha=this.flowQuality>=0.60?0.48:(this.flowQuality>=0.35?0.65:0.88);
    let oldHcx=this.hcx, oldHcy=this.hcy;
    this.hcx=this.hcx*(1.0-anchorAlpha)+ahcx*anchorAlpha;
    this.hcy=this.hcy*(1.0-anchorAlpha)+ahcy*anchorAlpha;
    this.hw=this.hw*0.38+ahw*0.62;
    this.hh=this.hh*0.38+ahh*0.62;
    this.hvx=this.hvx*0.60+(this.hcx-oldHcx)*0.40;
    this.hvy=this.hvy*0.60+(this.hcy-oldHcy)*0.40;

    this.score=d.score;this.lastDetectorFrame=seq;this.lastDetectorBatchSerial=batchSerial;
    this.detectorMisses=0;this.updatedThisBatch=true;this.hits++;this.visible=true;
    // Re-seed features after every semantic anchor. This prevents template drift.
    this.needsFeatureSeed=true;
  }

  markDetectorMiss():void{
    this.detectorMisses++;
    this.updatedThisBatch=false;
  }

  updateDisplay():void{
    let dist=safeSqrt((this.hcx-this.dcx)*(this.hcx-this.dcx)+(this.hcy-this.dcy)*(this.hcy-this.dcy));
    let size=Math.max(8.0,(this.hw+this.hh)*0.5);
    let nd=dist/size;
    let a=nd>0.55?0.84:(nd>0.25?0.68:(nd>0.08?0.52:0.34));
    if(this.flowQuality<0.30 && this.updatedThisBatch) a=Math.max(a,0.62);
    this.dcx=this.dcx*(1.0-a)+this.hcx*a;
    this.dcy=this.dcy*(1.0-a)+this.hcy*a;
    let sa=nd>0.45?0.55:0.32;
    this.dw=this.dw*(1.0-sa)+this.hw*sa;
    this.dh=this.dh*(1.0-sa)+this.hh*sa;
  }

  identityQualityWeight():f64{
    let vq=clamp64(this.flowQuality,0.0,1.0);
    let det=clamp64(this.score,0.0,1.0);
    let maturity=clamp64(<f64>this.hits/8.0,0.0,1.0);
    return clamp64(0.48+vq*0.22+det*0.18+maturity*0.12,0.45,1.0);
  }
}

// =============================================================================
// MOTION-AWARE ASSOCIATION
// =============================================================================
function associationCost(t:Track,d:Detection,seq:i32):f64{
  let tx=t.predictPersonCx(seq), ty=t.predictPersonCy(seq);
  let tw=t.predictPersonW(seq), th=t.predictPersonH(seq);
  let tx1=tx-tw*0.5, ty1=ty-th*0.5, tx2=tx+tw*0.5, ty2=ty+th*0.5;
  let ov=boxIou(tx1,ty1,tx2,ty2,d.px1,d.py1,d.px2,d.py2);
  let dcx=(d.px1+d.px2)*0.5, dcy=(d.py1+d.py2)*0.5;
  let dw=Math.max(4.0,d.px2-d.px1), dh=Math.max(6.0,d.py2-d.py1);
  let norm=Math.max(8.0,safeSqrt(tw*tw+th*th));
  let center=safeSqrt((dcx-tx)*(dcx-tx)+(dcy-ty)*(dcy-ty))/norm;
  let scale=abs64(Math.log(Math.max(0.05,dw/tw)))+abs64(Math.log(Math.max(0.05,dh/th)));

  // Hard gate only when both geometry and motion disagree strongly.
  if(center>1.65 && ov<0.03) return 100.0;
  if(scale>1.55 && ov<0.08) return 100.0;
  return (1.0-ov)*0.50 + center*0.37 + scale*0.13;
}

function associateHungarian(trackIdx:Array<i32>,dets:Array<Detection>,tracks:Array<Track>,seq:i32,maxCost:f64):Array<i32>{
  let R=trackIdx.length,C=dets.length;
  let result=new Array<i32>(R);for(let r=0;r<R;r++)result[r]=-1;
  if(R==0||C==0)return result;
  let N=R+C;
  let u=new Float64Array(N+1),v=new Float64Array(N+1),minv=new Float64Array(N+1);
  let p=new Int32Array(N+1),way=new Int32Array(N+1),used=new Uint8Array(N+1);
  for(let i=1;i<=N;i++){
    p[0]=i;
    for(let j=0;j<=N;j++){minv[j]=1.0e30;used[j]=0;way[j]=0;}
    let j0:i32=0;
    do{
      used[j0]=1;let i0=p[j0],delta=1.0e30,j1:i32=0;
      for(let j=1;j<=N;j++)if(used[j]==0){
        let base:f64=0.0;
        if(i0<=R&&j<=C){let c=associationCost(tracks[trackIdx[i0-1]],dets[j-1],seq);base=c<=maxCost?c:100.0;}
        else if(i0<=R||j<=C)base=maxCost+0.08;
        let cur=base-u[i0]-v[j];if(cur<minv[j]){minv[j]=cur;way[j]=j0;}if(minv[j]<delta){delta=minv[j];j1=j;}
      }
      for(let j=0;j<=N;j++){if(used[j]!=0){u[p[j]]+=delta;v[j]-=delta;}else minv[j]-=delta;}
      j0=j1;
    }while(p[j0]!=0);
    do{let j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0!=0);
  }
  for(let col=1;col<=N;col++){
    let row=p[col];
    if(row>=1&&row<=R&&col>=1&&col<=C){let c=associationCost(tracks[trackIdx[row-1]],dets[col-1],seq);if(c<=maxCost)result[row-1]=col-1;}
  }
  return result;
}

// =============================================================================
// SPARSE VISUAL FLOW ON WASM FRAMEBUFFER
// =============================================================================
function sourceToViewportX(x:f64):i32{
  let sw=statWidth>0.0?statWidth:320.0;
  return clamp32(VP_X+<i32>(x*<f64>VP_W/sw),VP_X,VP_X+VP_W-1);
}
function sourceToViewportY(y:f64):i32{
  let sh=statHeight>0.0?statHeight:240.0;
  return clamp32(VP_Y+<i32>(y*<f64>VP_H/sh),VP_Y,VP_Y+VP_H-1);
}
function lumaAtSource(x:f64,y:f64):f64{
  let sx=sourceToViewportX(x),sy=sourceToViewportY(y);
  let c=unchecked(pixels[sy*WIDTH+sx]);
  let r=<f64>(c&0xFF),g=<f64>((c>>8)&0xFF),b=<f64>((c>>16)&0xFF);
  return r*0.299+g*0.587+b*0.114;
}
function cornerScore(x:f64,y:f64):f64{
  // Shi-Tomasi minimum eigenvalue of a 3x3 gradient structure tensor.
  let gxx:f64=0.0,gxy:f64=0.0,gyy:f64=0.0;
  for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++){
    let sx=x+<f64>xx,sy=y+<f64>yy;
    let gx=(lumaAtSource(sx+1.0,sy)-lumaAtSource(sx-1.0,sy))*0.5;
    let gy=(lumaAtSource(sx,sy+1.0)-lumaAtSource(sx,sy-1.0))*0.5;
    gxx+=gx*gx;gxy+=gx*gy;gyy+=gy*gy;
  }
  let tr=gxx+gyy;
  let disc=safeSqrt((gxx-gyy)*(gxx-gyy)+4.0*gxy*gxy);
  return Math.max(0.0,(tr-disc)*0.5);
}
function patchOffset(point:i32,idx:i32):i32{return point*25+idx;}
function capturePatch(t:Track,point:i32,x:f64,y:f64):void{
  let k:i32=0;
  for(let yy=-PATCH_RADIUS;yy<=PATCH_RADIUS;yy++)for(let xx=-PATCH_RADIUS;xx<=PATCH_RADIUS;xx++){
    t.fpatch[patchOffset(point,k++)]=lumaAtSource(x+<f64>xx,y+<f64>yy);
  }
}
function patchSad(t:Track,point:i32,x:f64,y:f64):f64{
  // Zero-mean SAD improves robustness to exposure changes from webcam auto-exposure.
  let oldMean:f64=0.0,newMean:f64=0.0,k:i32=0;
  for(let yy=-PATCH_RADIUS;yy<=PATCH_RADIUS;yy++)for(let xx=-PATCH_RADIUS;xx<=PATCH_RADIUS;xx++){
    oldMean+=t.fpatch[patchOffset(point,k++)];newMean+=lumaAtSource(x+<f64>xx,y+<f64>yy);
  }
  oldMean/=25.0;newMean/=25.0;k=0;
  let sad:f64=0.0;
  for(let yy=-PATCH_RADIUS;yy<=PATCH_RADIUS;yy++)for(let xx=-PATCH_RADIUS;xx<=PATCH_RADIUS;xx++){
    let a=t.fpatch[patchOffset(point,k++)]-oldMean;
    let b=lumaAtSource(x+<f64>xx,y+<f64>yy)-newMean;
    sad+=abs64(a-b);
  }
  return sad/25.0;
}

function seedFlowFeatures(t:Track):void{
  let sw=statWidth>0.0?statWidth:320.0, sh=statHeight>0.0?statHeight:240.0;
  for(let i=0;i<FLOW_POINTS;i++){t.fvalid[i]=0;t.fx[i]=0.0;t.fy[i]=0.0;}
  t.flowPointCount=0;
  let x1=clamp64(t.hcx-t.hw*0.46,3.0,sw-4.0),x2=clamp64(t.hcx+t.hw*0.46,4.0,sw-3.0);
  let y1=clamp64(t.hcy-t.hh*0.44,3.0,sh-4.0),y2=clamp64(t.hcy+t.hh*0.44,4.0,sh-3.0);
  let candX=new Float64Array(36),candY=new Float64Array(36),candS=new Float64Array(36);let n:i32=0;
  for(let gy=0;gy<6;gy++)for(let gx=0;gx<6;gx++){
    let x=x1+(x2-x1)*(<f64>gx+0.5)/6.0;
    let y=y1+(y2-y1)*(<f64>gy+0.5)/6.0;
    candX[n]=x;candY[n]=y;candS[n]=cornerScore(x,y);n++;
  }
  // Selection-sort only top FLOW_POINTS candidates; tiny fixed array.
  for(let out=0;out<FLOW_POINTS;out++){
    let best=-1;let bestS:f64=-1.0;
    for(let i=0;i<n;i++)if(candS[i]>bestS){
      let tooClose=false;
      for(let j=0;j<out;j++)if(t.fvalid[j]!=0){let dx=candX[i]-t.fx[j],dy=candY[i]-t.fy[j];if(dx*dx+dy*dy<9.0){tooClose=true;break;}}
      if(!tooClose){best=i;bestS=candS[i];}
    }
    if(best<0||bestS<20.0)break;
    t.fx[out]=candX[best];t.fy[out]=candY[best];t.fvalid[out]=1;capturePatch(t,out,t.fx[out],t.fy[out]);t.flowPointCount++;
    candS[best]=-1.0;
  }
  t.flowQuality=t.flowPointCount>=FLOW_MIN_POINTS?0.72:0.25;
  t.flowFails=0;t.needsFeatureSeed=false;
}

function insertionSortSmall(a:Float64Array,n:i32):void{
  for(let i=1;i<n;i++){let v=a[i],j=i-1;while(j>=0&&a[j]>v){a[j+1]=a[j];j--;}a[j+1]=v;}
}
function medianSmall(a:Float64Array,n:i32):f64{
  if(n<=0)return 0.0;insertionSortSmall(a,n);return (n&1)==1?a[n>>1]:(a[(n>>1)-1]+a[n>>1])*0.5;
}

function trackVisualFrame(t:Track):void{
  if(!t.visible)return;
  if(t.needsFeatureSeed){seedFlowFeatures(t);return;}
  if(t.flowPointCount<FLOW_MIN_POINTS){t.flowFails++;t.flowQuality*=0.72;t.needsFeatureSeed=true;return;}

  let sw=statWidth>0.0?statWidth:320.0,sh=statHeight>0.0?statHeight:240.0;
  let dxs=t.flowDx,dys=t.flowDy;
  let oldXs=t.flowOldX,oldYs=t.flowOldY,newXs=t.flowNewX,newYs=t.flowNewY;
  let validN:i32=0;let qualitySum:f64=0.0;

  for(let i=0;i<FLOW_POINTS;i++)if(t.fvalid[i]!=0){
    let ox=t.fx[i],oy=t.fy[i];
    let predX=clamp64(ox+t.hvx,3.0,sw-4.0),predY=clamp64(oy+t.hvy,3.0,sh-4.0);
    let bestX=predX,bestY=predY,best=1.0e30,second=1.0e30;

    // Coarse translation search gives Lucas-Kanade a basin for large motion.
    for(let yy=-FLOW_COARSE_RADIUS;yy<=FLOW_COARSE_RADIUS;yy+=2)for(let xx=-FLOW_COARSE_RADIUS;xx<=FLOW_COARSE_RADIUS;xx+=2){
      let cx=clamp64(predX+<f64>xx,3.0,sw-4.0),cy=clamp64(predY+<f64>yy,3.0,sh-4.0);
      let ss=patchSad(t,i,cx,cy);if(ss<best){second=best;best=ss;bestX=cx;bestY=cy;}else if(ss<second)second=ss;
    }

    // Pyramidal/KLT-style iterative Lucas-Kanade refinement around the coarse match.
    let ux=bestX,uy=bestY,minEig:f64=0.0;
    for(let iter=0;iter<4;iter++){
      let gxx:f64=0.0,gxy:f64=0.0,gyy:f64=0.0,bx:f64=0.0,by:f64=0.0;
      let k:i32=0;
      for(let py=-PATCH_RADIUS;py<=PATCH_RADIUS;py++)for(let px=-PATCH_RADIUS;px<=PATCH_RADIUS;px++){
        let sx=ux+<f64>px,sy=uy+<f64>py;
        let cur=lumaAtSource(sx,sy),templ=t.fpatch[patchOffset(i,k++)];
        let gx=(lumaAtSource(sx+1.0,sy)-lumaAtSource(sx-1.0,sy))*0.5;
        let gy=(lumaAtSource(sx,sy+1.0)-lumaAtSource(sx,sy-1.0))*0.5;
        let err=templ-cur;
        gxx+=gx*gx;gxy+=gx*gy;gyy+=gy*gy;bx+=gx*err;by+=gy*err;
      }
      let det=gxx*gyy-gxy*gxy;
      let tr=gxx+gyy;let disc=safeSqrt((gxx-gyy)*(gxx-gyy)+4.0*gxy*gxy);minEig=(tr-disc)*0.5;
      if(det<1.0e-4||minEig<3.0)break;
      let du=(gyy*bx-gxy*by)/det,dv=(-gxy*bx+gxx*by)/det;
      du=clamp64(du,-2.0,2.0);dv=clamp64(dv,-2.0,2.0);
      ux=clamp64(ux+du,3.0,sw-4.0);uy=clamp64(uy+dv,3.0,sh-4.0);
      if(du*du+dv*dv<0.015)break;
    }

    let residual=patchSad(t,i,ux,uy);
    let ratio=second>0.0001?Math.min(1.0,residual/second):1.0;
    let textureQ=clamp64(minEig/180.0,0.0,1.0);
    let residualQ=clamp64(1.0-residual/42.0,0.0,1.0);
    let uniquenessQ=clamp64((0.98-ratio)/0.35,0.0,1.0);
    let q=residualQ*0.52+textureQ*0.30+uniquenessQ*0.18;
    if(q>=0.20&&residual<47.0&&minEig>=2.0){
      oldXs[validN]=ox;oldYs[validN]=oy;newXs[validN]=ux;newYs[validN]=uy;
      dxs[validN]=ux-ox;dys[validN]=uy-oy;
      t.fx[i]=ux;t.fy[i]=uy;capturePatch(t,i,ux,uy);qualitySum+=q;validN++;
    }else t.fvalid[i]=0;
  }

  let mdx=medianSmall(dxs,validN),mdy=medianSmall(dys,validN);
  // Robust outlier rejection around median flow.
  let rdx=t.flowRobustDx,rdy=t.flowRobustDy;let rn:i32=0;
  for(let i=0;i<validN;i++)if(abs64(dxs[i]-mdx)<=3.5&&abs64(dys[i]-mdy)<=3.5){rdx[rn]=dxs[i];rdy[rn]=dys[i];rn++;}
  if(rn>=FLOW_MIN_POINTS){mdx=medianSmall(rdx,rn);mdy=medianSmall(rdy,rn);}

  let oldCx=t.hcx,oldCy=t.hcy;
  t.hcx=clamp64(t.hcx+mdx,0.0,sw);
  t.hcy=clamp64(t.hcy+mdy,0.0,sh);
  t.hvx=t.hvx*0.58+(t.hcx-oldCx)*0.42;
  t.hvy=t.hvy*0.58+(t.hcy-oldCy)*0.42;
  t.lastFlowDx=mdx;t.lastFlowDy=mdy;

  // Weak scale estimate from feature spread around the robust translated center.
  let oldSpread:f64=0.0,newSpread:f64=0.0,scn:i32=0;
  let oldCenterX=oldCx,oldCenterY=oldCy,newCenterX=oldCx+mdx,newCenterY=oldCy+mdy;
  for(let i=0;i<validN;i++){
    let odx=oldXs[i]-oldCenterX,ody=oldYs[i]-oldCenterY;
    let ndx=newXs[i]-newCenterX,ndy=newYs[i]-newCenterY;
    let orad=safeSqrt(odx*odx+ody*ody),nrad=safeSqrt(ndx*ndx+ndy*ndy);
    if(orad>2.0&&nrad>1.0){oldSpread+=orad;newSpread+=nrad;scn++;}
  }
  if(scn>=FLOW_MIN_POINTS&&oldSpread>1.0){
    let scale=clamp64(newSpread/oldSpread,0.985,1.015);
    t.hw=clamp64(t.hw*scale,t.anchorHw*0.80,t.anchorHw*1.25);
    t.hh=clamp64(t.hh*scale,t.anchorHh*0.80,t.anchorHh*1.25);
  }

  t.flowQuality=clamp64((qualitySum/<f64>validN)*0.72+(<f64>validN/<f64>FLOW_POINTS)*0.28,0.0,1.0);
  t.flowFails=0;t.visible=true;

  // If head is clearly outside source frame, kill visibility immediately.
  if(t.hcx+t.hw*0.35<0.0||t.hcx-t.hw*0.35>sw||t.hcy+t.hh*0.35<0.0||t.hcy-t.hh*0.35>sh){
    t.visible=false;t.flowFails=MAX_VISUAL_FAILS_REMOVE;
  }
}

// =============================================================================
// TRACKER MANAGER
// =============================================================================
class WasmHybridTracker {
  tracks:Array<Track>=new Array<Track>();
  nextId:i32=1;
  detectorBatchSerial:i32=0;
  duplicateMerges:i32=0;
  staleRemoved:i32=0;
  highThreshold:f64=0.40;
  newTrackThreshold:f64=0.45;
  lowThreshold:f64=0.08;

  reset():void{
    for(let i=0;i<this.tracks.length;i++)if(this.tracks[i].bestToken>0)host_ai_discard_result(this.tracks[i].bestToken);
    this.tracks.length=0;this.nextId=1;this.detectorBatchSerial=0;this.duplicateMerges=0;this.staleRemoved=0;
  }

  removeTrackAt(i:i32):void{
    if(this.tracks[i].bestToken>0)host_ai_discard_result(this.tracks[i].bestToken);
    this.tracks.splice(i,1);this.staleRemoved++;
  }

  update(raw:Array<Detection>,seq:i32):void{
    this.detectorBatchSerial++;
    let all=suppressDuplicateDetections(raw);
    for(let i=0;i<this.tracks.length;i++)this.tracks[i].updatedThisBatch=false;
    let high=new Array<Detection>(),low=new Array<Detection>();
    for(let i=0;i<all.length;i++){if(all[i].score>=this.highThreshold)high.push(all[i]);else if(all[i].score>=this.lowThreshold)low.push(all[i]);}

    let active=new Array<i32>();
    for(let i=0;i<this.tracks.length;i++)if(this.tracks[i].detectorMisses<=MAX_DETECTOR_MISSES)active.push(i);
    let highUsed=new Uint8Array(high.length);
    let a1=associateHungarian(active,high,this.tracks,seq,0.92);
    let unmatched=new Array<i32>();
    for(let r=0;r<active.length;r++){
      let di=a1[r];
      if(di>=0){this.tracks[active[r]].updateFromDetection(high[di],seq,this.detectorBatchSerial);highUsed[di]=1;}
      else unmatched.push(active[r]);
    }
    // Byte-style second pass with lower-score detections but looser cost threshold.
    let lowUsed=new Uint8Array(low.length);
    let a2=associateHungarian(unmatched,low,this.tracks,seq,1.08);
    for(let r=0;r<unmatched.length;r++){
      let di=a2[r];
      if(di>=0){this.tracks[unmatched[r]].updateFromDetection(low[di],seq,this.detectorBatchSerial);lowUsed[di]=1;}
      else this.tracks[unmatched[r]].markDetectorMiss();
    }

    for(let i=0;i<high.length;i++)if(highUsed[i]==0&&high[i].score>=this.newTrackThreshold){
      this.tracks.push(new Track(this.nextId++,high[i],seq,this.detectorBatchSerial));
    }

    this.suppressDuplicateTracks(seq);

    let k:i32=0;
    while(k<this.tracks.length){
      let t=this.tracks[k];
      let remove=t.detectorMisses>MAX_DETECTOR_MISSES || t.flowFails>=MAX_VISUAL_FAILS_REMOVE;
      if(remove)this.removeTrackAt(k);else k++;
    }
  }

  suppressDuplicateTracks(seq:i32):void{
    let i:i32=0;
    while(i<this.tracks.length){
      let j=i+1;
      while(j<this.tracks.length){
        let a=this.tracks[i],b=this.tracks[j];
        let ax1=a.hcx-a.hw*0.5,ay1=a.hcy-a.hh*0.5,ax2=a.hcx+a.hw*0.5,ay2=a.hcy+a.hh*0.5;
        let bx1=b.hcx-b.hw*0.5,by1=b.hcy-b.hh*0.5,bx2=b.hcx+b.hw*0.5,by2=b.hcy+b.hh*0.5;
        let ov=boxIou(ax1,ay1,ax2,ay2,bx1,by1,bx2,by2);
        let norm=Math.max(8.0,(a.hw+a.hh+b.hw+b.hh)*0.25);
        let cd=safeSqrt((a.hcx-b.hcx)*(a.hcx-b.hcx)+(a.hcy-b.hcy)*(a.hcy-b.hcy))/norm;
        if(ov>=DUP_TRACK_IOU&&cd<=DUP_TRACK_CENTER){
          // Keep the stronger semantic identity / older track.
          let scoreA=(a.isLockedTarget?10000.0:0.0)+(a.identityState==4?2000.0:0.0)+a.identityConfidence*20.0+<f64>a.hits*5.0+a.score;
          let scoreB=(b.isLockedTarget?10000.0:0.0)+(b.identityState==4?2000.0:0.0)+b.identityConfidence*20.0+<f64>b.hits*5.0+b.score;
          let kill=scoreA>=scoreB?j:i;
          if(kill==i){this.removeTrackAt(i);this.duplicateMerges++;i--;break;}else{this.removeTrackAt(j);this.duplicateMerges++;continue;}
        }
        j++;
      }
      i++;
    }
  }

  processVisualFrame():void{
    if(videoFrameSeq==lastVisualFrameSeq)return;
    lastVisualFrameSeq=videoFrameSeq;
    for(let i=0;i<this.tracks.length;i++){
      trackVisualFrame(this.tracks[i]);
      this.tracks[i].updateDisplay();
    }
    let k:i32=0;
    while(k<this.tracks.length){
      if(this.tracks[k].flowFails>=MAX_VISUAL_FAILS_REMOVE)this.removeTrackAt(k);else k++;
    }
  }

  find(id:i32):Track|null{for(let i=0;i<this.tracks.length;i++)if(this.tracks[i].id==id)return this.tracks[i];return null;}
  liveCount(seq:i32):i32{let n=0;for(let i=0;i<this.tracks.length;i++)if(this.tracks[i].visible)n++;return n;}
  targetCount(seq:i32):i32{let n=0;for(let i=0;i<this.tracks.length;i++)if(this.tracks[i].visible&&this.tracks[i].isLockedTarget)n++;return n;}
  bestIdentityTrack():Track|null{
    let best:Track|null=null;let bs:f64=-1.0;
    for(let i=0;i<this.tracks.length;i++){let t=this.tracks[i];let s=t.isLockedTarget?1000.0+t.identityConfidence:t.identityConfidence;if(t.visible&&s>bs){best=t;bs=s;}}
    return best;
  }
}

let tracker=new WasmHybridTracker();
let incomingDetections=new Array<Detection>();
let incomingFrameSeq:i32=0;

// ---------- Match history ----------
class HitRecord{
  snapshotId:i32;trackId:i32;similarity:f64;confidence:f64;timestamp:f64;
  constructor(snapshotId:i32,trackId:i32,similarity:f64,confidence:f64,timestamp:f64){this.snapshotId=snapshotId;this.trackId=trackId;this.similarity=similarity;this.confidence=confidence;this.timestamp=timestamp;}
}
let hits=new Array<HitRecord>();
let hitScroll:i32=0;
let viewerSnapshotId:i32=-1;
const HITS_VISIBLE:i32=2;

function shiftedPersonBox(t:Track):Float64Array{
  // Shift latest detector PERSON crop by visual head displacement. This preserves
  // OSNet's person-level crop while making it fresher between detector anchors.
  let sw=statWidth>0.0?statWidth:320.0,sh=statHeight>0.0?statHeight:240.0;
  let dx=t.hcx-t.anchorHcx,dy=t.hcy-t.anchorHcy;
  let x1=clamp64(t.pcx-t.pw*0.5+dx,0.0,sw-4.0);
  let y1=clamp64(t.pcy-t.ph*0.5+dy,0.0,sh-6.0);
  let x2=clamp64(t.pcx+t.pw*0.5+dx,4.0,sw);
  let y2=clamp64(t.pcy+t.ph*0.5+dy,6.0,sh);
  // Small person-context padding improves ReID stability but remains within frame.
  let pw=x2-x1,ph=y2-y1;
  let px=pw*0.04,py=ph*0.03;
  x1=clamp64(x1-px,0.0,sw-4.0);x2=clamp64(x2+px,4.0,sw);
  y1=clamp64(y1-py,0.0,sh-6.0);y2=clamp64(y2+py,6.0,sh);
  let out=new Float64Array(4);out[0]=x1;out[1]=y1;out[2]=x2;out[3]=y2;return out;
}

function scheduleReidForTracks(seq:i32):void{
  if(!aiEnabled||detectorState!=2||reidState!=2||referenceState!=2)return;
  for(let i=0;i<tracker.tracks.length;i++){
    let t=tracker.tracks[i];
    if(!t.visible||t.identityState==1)continue;
    let interval=t.isLockedTarget?REID_LOCKED_REVERIFY_FRAMES:REID_RETRY_FRAMES;
    if(t.identityState==3&&t.reidAttempts>=REID_MAX_ATTEMPTS_BEFORE_COOLDOWN)interval=REID_REJECT_RETRY_FRAMES;
    if(seq-t.lastReidFrame<interval)continue;
    // For non-targets, schedule primarily after fresh detector updates; locked targets
    // may be periodically re-verified using visually shifted person crop.
    if(!t.isLockedTarget&&!t.updatedThisBatch)continue;
    let pb=shiftedPersonBox(t);
    let token=host_ai_reid_submit(t.id,seq,pb[0],pb[1],pb[2],pb[3]);
    if(token>0){t.identityState=1;t.lastReidFrame=seq;t.reidAttempts++;}
  }
}

function addHit(snapshotId:i32,trackId:i32,similarity:f64,confidence:f64):void{
  hits.push(new HitRecord(snapshotId,trackId,similarity,confidence,epoch_ms()));
  if(hits.length>80)hits.shift();hitScroll=0;
}

// =============================================================================
// HOST CALLBACKS
// =============================================================================
export function aiFrameTick(seq:i32):void{if(seq>0)liveFrameSeq=seq;}

export function aiDetectionBatchStart(frameSeq:i32,count:i32,inferMs:f64):void{
  incomingDetections.length=0;incomingFrameSeq=frameSeq;lastDetectorBatchMs=inferMs;detectorCount=count;
}
export function aiDetection(frameSeq:i32,x1:f64,y1:f64,x2:f64,y2:f64,score:f64):void{
  if(frameSeq!=incomingFrameSeq)return;
  let sw=statWidth>0.0?statWidth:320.0,sh=statHeight>0.0?statHeight:240.0;
  let px1=clamp64(x1,0.0,sw-4.0),py1=clamp64(y1,0.0,sh-6.0),px2=clamp64(x2,4.0,sw),py2=clamp64(y2,6.0,sh);
  if(px2-px1<4.0||py2-py1<8.0)return;
  let hb=headFromPerson(px1,py1,px2,py2,sw,sh);
  incomingDetections.push(new Detection(px1,py1,px2,py2,hb[0],hb[1],hb[2],hb[3],score));
}
export function aiDetectionBatchEnd(frameSeq:i32):void{
  if(frameSeq!=incomingFrameSeq)return;
  lastDetectorFrameSeq=frameSeq;
  tracker.update(incomingDetections,frameSeq);
  scheduleReidForTracks(frameSeq);
}

export function aiModelEvent(kind:i32,state:i32,sizeBytes:f64):void{
  if(kind==1)detectorState=state;else if(kind==2)reidState=state;
  if(state<0)statusMessage=kind==1?"DETECTOR MODEL ERROR":"OSNET MODEL ERROR";
  else if(state==2)statusMessage=kind==1?"YOLO DETECTOR READY":"OSNET REID POOL READY";
}
export function aiReferenceEvent(state:i32,w:i32,h:i32,detectorScore:f64):void{
  referenceState=state;
  if(state==2){aiEnabled=true;host_ai_set_enabled(1);statusMessage="REFERENCE READY // PERSON EMBEDDING // AI AUTO-ARMED";}
  else if(state<0)statusMessage="REFERENCE PREPARATION ERROR";
}

function updateIdentityEvidence(t:Track,similarity:f64):void{
  t.similarity=similarity;t.reidSamples++;
  if(t.similarityEma<0.0){t.similarityEma=similarity;t.similarityVar=0.0;}
  else{
    let prev=t.similarityEma;
    let alpha=t.reidSamples<=3?0.48:0.32;
    t.similarityEma=prev*(1.0-alpha)+similarity*alpha;
    let e=similarity-t.similarityEma;
    t.similarityVar=t.similarityVar*0.72+e*e*0.28;
  }
  if(similarity>t.bestSimilarity)t.bestSimilarity=similarity;

  let margin=0.12;
  let z=clamp64((similarity-reidThreshold)/margin,-2.6,2.6);
  let variancePenalty=clamp64(1.0-safeSqrt(t.similarityVar)/0.18,0.45,1.0);
  let weight=t.identityQualityWeight()*variancePenalty;
  // Retain history while allowing new evidence to dominate slowly.
  t.identityLogOdds=clamp64(t.identityLogOdds*0.94+z*weight*1.90,-6.0,6.0);
  t.identityConfidence=sigmoid(t.identityLogOdds)*100.0;

  if(similarity>=reidThreshold){t.positiveStreak++;t.negativeStreak=0;t.positiveCount++;}
  else if(similarity<=reidThreshold-0.05){t.negativeStreak++;t.positiveStreak=0;}
  else{t.positiveStreak=maxi(0,t.positiveStreak-1);t.negativeStreak=maxi(0,t.negativeStreak-1);}
}

export function aiReidResult(trackId:i32,frameSeq:i32,token:i32,similarity:f64,inferMs:f64):void{
  let t=tracker.find(trackId);
  if(t==null){host_ai_discard_result(token);return;}
  updateIdentityEvidence(t,similarity);

  let positive=similarity>=reidThreshold;
  if(positive&&similarity>=t.bestSimilarity-0.000001){
    if(t.bestToken>0&&t.bestToken!=token)host_ai_discard_result(t.bestToken);
    t.bestToken=token;
  }else host_ai_discard_result(token);

  // Strong lock requires repeated positive evidence + smoothed cosine + confidence.
  let canLock=t.reidSamples>=confirmationsRequired && t.positiveStreak>=confirmationsRequired &&
              t.similarityEma>=reidThreshold+0.04 && t.identityConfidence>=lockConfidencePct;

  if(canLock){
    let firstLock=!t.isLockedTarget;
    t.isLockedTarget=true;t.identityState=2;
    if(firstLock&&!t.hitSaved&&t.bestToken>0){
      let saved=host_ai_save_match(t.bestToken);t.bestToken=0;
      if(saved>0){addHit(saved,t.id,t.bestSimilarity,t.identityConfidence);t.hitSaved=true;}
    }else if(t.bestToken>0){host_ai_discard_result(t.bestToken);t.bestToken=0;}
    statusMessage="TARGET LOCKED // TEMPORAL ID CONFIDENCE "+fmtPct(t.identityConfidence);
    return;
  }

  // Safety: a locked identity is not immortal. Three strong negatives and confidence
  // collapse unlock it, preventing ID transfer if tracking jumps to another person.
  if(t.isLockedTarget&&t.negativeStreak>=3&&t.identityConfidence<55.0){
    t.isLockedTarget=false;t.identityState=3;t.positiveStreak=0;
    statusMessage="TARGET UNLOCKED // NEGATIVE REID EVIDENCE";
    return;
  }

  if(t.isLockedTarget){t.identityState=2;statusMessage="TARGET REVERIFY // ID "+fmtPct(t.identityConfidence);}
  else if(t.identityConfidence>=60.0||positive){t.identityState=4;statusMessage="REID VERIFY // ID "+fmtPct(t.identityConfidence)+" // EMA "+fmt2(t.similarityEma);}
  else{t.identityState=3;statusMessage="REID LOW EVIDENCE // RAW "+fmt2(similarity)+" // ID "+fmtPct(t.identityConfidence);}
}

// =============================================================================
// TELEMETRY
// =============================================================================
function pollStats(now:f64):void{
  if(activeWsId>=0&&now-lastStreamPoll>=220.0){
    host_stream_stats_poll(activeWsId);
    mediaBitrateBps=host_stream_stat(activeWsId,ST_MEDIA_BITRATE);packetLossPct=host_stream_stat(activeWsId,ST_LOSS_PCT);
    decodeFps=host_stream_stat(activeWsId,ST_DECODE_FPS);statWidth=host_stream_stat(activeWsId,ST_WIDTH);statHeight=host_stream_stat(activeWsId,ST_HEIGHT);
    jitterMs=host_stream_stat(activeWsId,ST_JITTER_MS);jitterBufferMs=host_stream_stat(activeWsId,ST_JBUF_MS);rttMs=host_stream_stat(activeWsId,ST_RTT_MS);
    fastPathMode=host_stream_stat(activeWsId,ST_FAST_PATH_MODE);trackFps=host_stream_stat(activeWsId,ST_TRACK_FPS);trackCanvasMs=host_stream_stat(activeWsId,ST_TRACK_CANVAS_MS);
    lastStreamPoll=now;
  }
  if(now-lastAiPoll>=220.0){
    detectorInferMs=host_ai_stat(5);detectorFps=host_ai_stat(6);detectorCount=<i32>host_ai_stat(7);
    reidAvgMs=host_ai_stat(8);reidQueue=<i32>host_ai_stat(9);reidBusy=<i32>host_ai_stat(10);reidWorkers=<i32>host_ai_stat(11);
    reidTotal=<i32>host_ai_stat(12);hostHits=<i32>host_ai_stat(13);detectorDropped=<i32>host_ai_stat(14);reidDropped=<i32>host_ai_stat(15);
    embeddingDim=<i32>host_ai_stat(18);lastSimilarity=host_ai_stat(24);detectorIntervalMs=host_ai_stat(26);lastAiPoll=now;
  }
}

// =============================================================================
// DRAWING
// =============================================================================
function trackColor(t:Track):u32{
  if(t.isLockedTarget)return rgba(0,255,157);
  if(t.identityState==4)return rgba(255,210,70);
  if(t.identityState==1)return rgba(255,150,50);
  if(t.identityState==3)return rgba(95,110,130);
  return rgba(0,210,255);
}

function drawTrackOverlays():void{
  let sw=statWidth>0.0?statWidth:320.0,sh=statHeight>0.0?statHeight:240.0;
  for(let i=0;i<tracker.tracks.length;i++){
    let t=tracker.tracks[i];if(!t.visible)continue;
    let hx1=t.dcx-t.dw*0.5,hy1=t.dcy-t.dh*0.5,hx2=t.dcx+t.dw*0.5,hy2=t.dcy+t.dh*0.5;
    let x1=<i32>(<f64>VP_X+clamp64(hx1,0.0,sw)*<f64>VP_W/sw);
    let y1=<i32>(<f64>VP_Y+clamp64(hy1,0.0,sh)*<f64>VP_H/sh);
    let x2=<i32>(<f64>VP_X+clamp64(hx2,0.0,sw)*<f64>VP_W/sw);
    let y2=<i32>(<f64>VP_Y+clamp64(hy2,0.0,sh)*<f64>VP_H/sh);
    x1=maxi(VP_X,mini(VP_X+VP_W-4,x1));y1=maxi(VP_Y,mini(VP_Y+VP_H-6,y1));x2=maxi(x1+4,mini(VP_X+VP_W,x2));y2=maxi(y1+6,mini(VP_Y+VP_H,y2));
    let col=trackColor(t);drawThickFrame(x1,y1,x2-x1,y2-y1,col,t.isLockedTarget?3:2);
    let label="HEAD T"+t.id.toString()+" VQ"+fmt2(t.flowQuality)+" ID"+fmtPct(t.identityConfidence);
    if(t.isLockedTarget)label+=" LOCK "+fmt2(t.similarityEma);
    else if(t.identityState==1)label+=" REID...";
    else if(t.identityState==4)label+=" VERIFY "+fmt2(t.similarityEma);
    let labelY=maxi(VP_Y+2,y1-14),labelX=mini(VP_X+VP_W-240,x1);
    drawRect(labelX,labelY,mini(240,label.length*8+8),14,rgba(0,0,0,210));drawText(label,labelX+4,labelY+3,col,1);
  }
}

function drawReferencePreview():void{
  let x=PANEL_X+14,y=PANEL_Y+295,w=68,h=94;drawRect(x,y,w,h,rgba(5,8,13));
  if(referenceState==2)host_ai_reference_draw(changetype<usize>(pixels.dataStart),WIDTH,HEIGHT,x,y,w,h);
  drawFrame(x,y,w,h,referenceState==2?rgba(0,255,157):rgba(55,70,95));drawText("REF",x+20,y+3,rgba(230,245,255),1);
}
function hitAtVisibleSlot(slot:i32):HitRecord|null{let idx=hits.length-1-(hitScroll+slot);return idx>=0&&idx<hits.length?hits[idx]:null;}
function drawHitList():void{
  let baseY=PANEL_Y+407;drawText("CONFIRMED HITS  "+hits.length.toString(),PANEL_X+14,baseY-16,rgba(225,238,250),1);
  for(let slot=0;slot<HITS_VISIBLE;slot++){
    let y=baseY+slot*62;drawRect(PANEL_X+12,y,PANEL_W-24,57,rgba(12,18,28));drawFrame(PANEL_X+12,y,PANEL_W-24,57,rgba(42,55,78));
    let h=hitAtVisibleSlot(slot);
    if(h!=null){host_ai_snapshot_draw(h.snapshotId,changetype<usize>(pixels.dataStart),WIDTH,HEIGHT,PANEL_X+16,y+4,66,49);drawFrame(PANEL_X+16,y+4,66,49,rgba(0,255,157));
      drawText("TARGET T"+h.trackId.toString(),PANEL_X+90,y+7,rgba(0,255,157),1);drawText("COS "+fmt2(h.similarity),PANEL_X+90,y+22,rgba(225,238,250),1);
      drawText("ID "+fmtPct(h.confidence),PANEL_X+90,y+37,rgba(255,220,80),1);drawText("VIEW",PANEL_X+190,y+37,rgba(0,210,255),1);
    }else drawText("--",PANEL_X+20,y+24,rgba(80,95,120),1);
  }
  if(hits.length>HITS_VISIBLE)drawText("MOUSE WHEEL TO SCROLL",PANEL_X+14,PANEL_Y+534,rgba(95,115,145),1);
}
function drawViewer():void{
  drawRect(0,0,WIDTH,HEIGHT,rgba(4,7,12));drawRect(28,24,744,632,rgba(10,15,24));drawFrame(28,24,744,632,rgba(0,243,255));
  drawText("WASM MATCH IMAGE VIEWER",48,42,rgba(220,245,255),2);
  let score=host_ai_snapshot_info(viewerSnapshotId,2),tid=<i32>host_ai_snapshot_info(viewerSnapshotId,1);
  let sw=host_ai_snapshot_info(viewerSnapshotId,5),sh=host_ai_snapshot_info(viewerSnapshotId,6);
  drawText("SNAPSHOT #"+viewerSnapshotId.toString()+" TRACK "+tid.toString()+" COS "+fmt2(score),48,66,rgba(0,255,157),1);
  let ix=78,iy=92,iw=644,ih=483;drawRect(ix,iy,iw,ih,rgba(0,0,0));host_ai_snapshot_draw(viewerSnapshotId,changetype<usize>(pixels.dataStart),WIDTH,HEIGHT,ix,iy,iw,ih);drawFrame(ix,iy,iw,ih,rgba(55,75,105));
  if(sw>0.0&&sh>0.0){let bx1=host_ai_snapshot_info(viewerSnapshotId,7),by1=host_ai_snapshot_info(viewerSnapshotId,8),bx2=host_ai_snapshot_info(viewerSnapshotId,9),by2=host_ai_snapshot_info(viewerSnapshotId,10);
    let x1=<i32>(<f64>ix+bx1*<f64>iw/sw),y1=<i32>(<f64>iy+by1*<f64>ih/sh),x2=<i32>(<f64>ix+bx2*<f64>iw/sw),y2=<i32>(<f64>iy+by2*<f64>ih/sh);drawThickFrame(x1,y1,maxi(4,x2-x1),maxi(6,y2-y1),rgba(0,255,157),3);}
  drawButton(620,604,102,32,"CLOSE VIEW",rgba(255,70,85));drawText("Stored locally in this WASM runtime session",78,610,rgba(110,135,165),1);
}

export function appInit(w:i32,h:i32,dpr:f64):void{
  VideoDecoderEngine.init("avc1.42E01E");host_ai_init();
  host_ai_set_config(1,100.0); // detector sampling request; host may be slower than this
  host_ai_set_config(2,2.0);host_ai_set_config(3,24.0);host_ai_set_config(4,0.25);host_ai_set_config(5,0.45);
}

export function renderFrame():i32{
  let now=now_ms();pollStats(now);pixels.fill(rgba(6,9,15));
  drawRect(20,12,760,44,rgba(15,23,36));drawFrame(20,12,760,44,rgba(45,60,86));drawRect(20,12,760,2,rgba(0,243,255));
  drawText("WHEP VISION SENTINEL V10 // DUAL BOX + FLOW + OSNET",35,20,rgba(220,245,255),2);drawText(statusMessage.slice(0,88),35,41,isStreaming?rgba(0,255,157):rgba(255,190,70),1);
  drawRect(20,64,760,32,isEditingUrl?rgba(12,21,34):rgba(13,18,28));drawFrame(20,64,760,32,isEditingUrl?rgba(0,243,255):rgba(40,52,74));
  drawText("SOURCE:",30,75,rgba(110,130,160),1);drawText(currentStreamUrl.slice(0,82),94,75,rgba(235,245,255),1);

  drawRect(VP_X,VP_Y,VP_W,VP_H,rgba(2,4,8));
  if(isStreaming){
    VideoDecoderEngine.drawFrame(pixels,WIDTH,HEIGHT,VP_X,VP_Y,VP_W,VP_H);
    // IMPORTANT: visual tracker samples raw video pixels BEFORE overlays are drawn.
    tracker.processVisualFrame();
    drawTrackOverlays();
    let live=(now-lastFrameTimestamp)<350.0;drawRect(VP_X+10,VP_Y+10,188,22,rgba(0,0,0,200));drawRect(VP_X+15,VP_Y+17,8,8,live?rgba(0,255,157):rgba(255,70,85));
    drawText(live?"WHEP LIVE + HYBRID FLOW":"WAITING FOR FRAME",VP_X+29,VP_Y+17,rgba(245,250,255),1);
    let best=tracker.bestIdentityTrack();let idTxt=best==null?"--":fmtPct(best.identityConfidence);
    drawRect(VP_X+10,VP_Y+VP_H-28,VP_W-20,20,rgba(0,0,0,210));
    drawText((aiEnabled?"AI ARMED":"AI OFF")+" | DET "+detectorCount.toString()+" | TRACK "+tracker.liveCount(liveFrameSeq).toString()+" | TARGET "+tracker.targetCount(liveFrameSeq).toString()+" | ID "+idTxt,VP_X+15,VP_Y+VP_H-22,aiEnabled?rgba(0,255,157):rgba(0,210,255),1);
  }else{drawText("LIVE STREAM STANDBY",VP_X+140,VP_Y+145,rgba(95,115,145),2);drawText("Load detector + OSNet + reference, then start WHEP",VP_X+70,VP_Y+176,rgba(80,100,130),1);}
  drawFrame(VP_X,VP_Y,VP_W,VP_H,rgba(45,58,82));

  drawRect(PANEL_X,PANEL_Y,PANEL_W,PANEL_H,rgba(13,19,30));drawFrame(PANEL_X,PANEL_Y,PANEL_W,PANEL_H,rgba(42,55,78));
  drawText("STREAM",PANEL_X+14,PANEL_Y+12,rgba(215,232,248),1);drawButton(PANEL_X+12,PANEL_Y+28,104,27,"LOCAL WHEP",rgba(0,200,150));drawButton(PANEL_X+124,PANEL_Y+28,104,27,isStreaming?"STOP":"START",isStreaming?rgba(255,70,85):rgba(0,255,157));
  drawText("VISION MODELS / LOCAL WASM",PANEL_X+14,PANEL_Y+69,rgba(215,232,248),1);
  drawButton(PANEL_X+12,PANEL_Y+84,216,25,"LOAD YOLO11 PERSON ONNX",rgba(0,190,230));drawText(stateWord(detectorState),PANEL_X+168,PANEL_Y+92,stateColor(detectorState),1);
  drawButton(PANEL_X+12,PANEL_Y+115,216,25,"LOAD OSNET-x0.25 ONNX",rgba(125,105,240));drawText(stateWord(reidState),PANEL_X+168,PANEL_Y+123,stateColor(reidState),1);
  drawButton(PANEL_X+12,PANEL_Y+146,216,25,"LOAD TARGET REFERENCE",rgba(245,160,55));drawText(stateWord(referenceState),PANEL_X+168,PANEL_Y+154,stateColor(referenceState),1);
  drawButton(PANEL_X+12,PANEL_Y+179,216,30,aiEnabled?"DISARM AI":"ARM AI",aiEnabled?rgba(255,70,85):rgba(0,255,157));
  drawText("COS DECISION",PANEL_X+14,PANEL_Y+220,rgba(120,145,175),1);drawButton(PANEL_X+126,PANEL_Y+214,24,22,"-",rgba(80,100,150));drawText(fmt2(reidThreshold),PANEL_X+158,PANEL_Y+220,rgba(255,220,85),1);drawButton(PANEL_X+202,PANEL_Y+214,24,22,"+",rgba(80,100,150));
  drawText("LOCK CONF x"+confirmationsRequired.toString(),PANEL_X+14,PANEL_Y+244,rgba(120,145,175),1);drawButton(PANEL_X+126,PANEL_Y+238,24,22,"-",rgba(80,100,150));drawText(fmtPct(lockConfidencePct),PANEL_X+154,PANEL_Y+244,rgba(255,220,85),1);drawButton(PANEL_X+202,PANEL_Y+238,24,22,"+",rgba(80,100,150));
  drawText("REID WORKERS",PANEL_X+14,PANEL_Y+272,rgba(120,145,175),1);drawButton(PANEL_X+126,PANEL_Y+264,24,22,"-",rgba(80,100,150));drawText(reidWorkers.toString(),PANEL_X+163,PANEL_Y+272,rgba(0,243,255),1);drawButton(PANEL_X+202,PANEL_Y+264,24,22,"+",rgba(80,100,150));
  drawReferencePreview();drawText("REF EMB "+embeddingDim.toString()+"D",PANEL_X+92,PANEL_Y+304,embeddingDim==512?rgba(0,255,157):rgba(255,190,70),1);
  drawText("DET "+fmt1(detectorInferMs)+"ms",PANEL_X+92,PANEL_Y+323,rgba(180,200,225),1);drawText("REID "+fmt1(reidAvgMs)+"ms",PANEL_X+92,PANEL_Y+342,rgba(180,200,225),1);
  drawText("Q "+reidQueue.toString()+" / BUSY "+reidBusy.toString(),PANEL_X+92,PANEL_Y+361,rgba(180,200,225),1);drawText("DROP D/R "+detectorDropped.toString()+"/"+reidDropped.toString(),PANEL_X+92,PANEL_Y+380,rgba(110,140,170),1);drawHitList();

  drawRect(20,445,510,200,rgba(10,14,22));drawFrame(20,445,510,200,rgba(42,55,78));drawText("REALTIME VISION PIPELINE TELEMETRY",32,453,rgba(220,235,250),1);
  drawText("VIDEO "+(<i32>statWidth).toString()+"x"+(<i32>statHeight).toString()+" DEC "+fmt1(decodeFps)+" FPS TRACK "+fmt1(trackFps)+" FPS TRACK->CANVAS "+fmt1(trackCanvasMs)+"ms",32,474,rgba(0,230,210),1);
  drawText("RTP "+fmtMbps(mediaBitrateBps)+" LOSS "+fmt2(packetLossPct)+"% JITTER "+fmt1(jitterMs)+"ms JBUF "+fmt1(jitterBufferMs)+"ms RTT "+fmt1(rttMs)+"ms",32,493,rgba(125,160,200),1);
  drawText("DETECTOR "+stateWord(detectorState)+" INFER "+fmt1(detectorInferMs)+"ms RATE "+fmt1(detectorFps)+"/s PEOPLE "+detectorCount.toString()+" SAMPLE "+fmt1(detectorIntervalMs)+"ms",32,518,stateColor(detectorState),1);
  let bt=tracker.bestIdentityTrack();let vq=bt==null?-1.0:bt.flowQuality;let pts=bt==null?0:bt.flowPointCount;
  drawText("HYBRID TRACK LIVE "+tracker.liveCount(liveFrameSeq).toString()+" PTS "+pts.toString()+" VQ "+fmt2(vq)+" MERGE "+tracker.duplicateMerges.toString()+" STALE "+tracker.staleRemoved.toString(),32,537,rgba(0,210,255),1);
  drawText("OSNET "+stateWord(reidState)+" AVG "+fmt1(reidAvgMs)+"ms WORKERS "+reidWorkers.toString()+" BUSY "+reidBusy.toString()+" Q "+reidQueue.toString()+" RUNS "+reidTotal.toString(),32,556,stateColor(reidState),1);
  if(bt!=null){
    drawText("IDENTITY RAW "+fmt2(bt.similarity)+" EMA "+fmt2(bt.similarityEma)+" VAR "+fmt2(bt.similarityVar)+" ID "+fmtPct(bt.identityConfidence)+" +"+bt.positiveStreak.toString()+"/-"+bt.negativeStreak.toString(),32,575,rgba(255,215,75),1);
    drawText("REID CROP PERSON | OVERLAY HEAD | LOCK >= "+fmtPct(lockConfidencePct)+" & EMA >= "+fmt2(reidThreshold+0.04),32,594,rgba(145,175,205),1);
  }else{
    drawText("IDENTITY RAW -- EMA -- ID -- | waiting for active track",32,575,rgba(255,215,75),1);
    drawText("REID CROP PERSON | OVERLAY HEAD | temporal evidence engine armed",32,594,rgba(145,175,205),1);
  }
  drawText("TRACK POLICY: sparse flow 30FPS + YOLO re-anchor + motion association + duplicate suppression",32,613,rgba(105,130,165),1);
  drawText("OSNet: PERSON crop 256x128 RGB/ImageNet | confidence is evidence, not cosmetic scaling",32,632,rgba(95,118,148),1);

  if(viewerSnapshotId>=0)drawViewer();
  return <i32>pixels.dataStart;
}

// =============================================================================
// INPUT
// =============================================================================
export function mouseDown(button:i32,x:i32,y:i32,mods:i32):void{
  mouseX=x;mouseY=y;
  if(viewerSnapshotId>=0){if(x>=620&&x<=722&&y>=604&&y<=636)viewerSnapshotId=-1;return;}
  isEditingUrl=(x>=20&&x<=780&&y>=64&&y<=96);
  if(x>=PANEL_X+12&&x<=PANEL_X+116&&y>=PANEL_Y+28&&y<=PANEL_Y+55){currentStreamUrl="http://127.0.0.1:8889/live/whep";statusMessage="SOURCE: LOCAL WHEP";}
  if(x>=PANEL_X+124&&x<=PANEL_X+228&&y>=PANEL_Y+28&&y<=PANEL_Y+55){
    if(!isStreaming){let b=String.UTF8.encode(currentStreamUrl);activeWsId=host_ws_connect(changetype<usize>(b),b.byteLength);if(activeWsId>=0){isStreaming=true;tracker.reset();statusMessage="CONNECTING WHEP...";}else statusMessage="WHEP CONNECTION FAILED";}
    else{if(activeWsId>=0)host_ws_close(activeWsId);activeWsId=-1;isStreaming=false;tracker.reset();statusMessage="STREAM STOPPED";}
  }
  if(x>=PANEL_X+12&&x<=PANEL_X+228&&y>=PANEL_Y+84&&y<=PANEL_Y+109)host_ai_pick_model(1);
  if(x>=PANEL_X+12&&x<=PANEL_X+228&&y>=PANEL_Y+115&&y<=PANEL_Y+140)host_ai_pick_model(2);
  if(x>=PANEL_X+12&&x<=PANEL_X+228&&y>=PANEL_Y+146&&y<=PANEL_Y+171)host_ai_pick_reference();
  if(x>=PANEL_X+12&&x<=PANEL_X+228&&y>=PANEL_Y+179&&y<=PANEL_Y+209){aiEnabled=!aiEnabled;host_ai_set_enabled(aiEnabled?1:0);statusMessage=aiEnabled?"AI ARMED // DETECT + FLOW + PERSON REID":"AI DISARMED // LIVE VIDEO ONLY";}
  if(y>=PANEL_Y+214&&y<=PANEL_Y+236){if(x>=PANEL_X+126&&x<=PANEL_X+150)reidThreshold=Math.max(0.35,reidThreshold-0.01);if(x>=PANEL_X+202&&x<=PANEL_X+226)reidThreshold=Math.min(0.95,reidThreshold+0.01);}
  if(y>=PANEL_Y+238&&y<=PANEL_Y+260){if(x>=PANEL_X+126&&x<=PANEL_X+150)lockConfidencePct=Math.max(80.0,lockConfidencePct-1.0);if(x>=PANEL_X+202&&x<=PANEL_X+226)lockConfidencePct=Math.min(99.0,lockConfidencePct+1.0);}
  if(y>=PANEL_Y+264&&y<=PANEL_Y+286){if(x>=PANEL_X+126&&x<=PANEL_X+150)reidWorkers=maxi(1,reidWorkers-1);if(x>=PANEL_X+202&&x<=PANEL_X+226)reidWorkers=mini(4,reidWorkers+1);host_ai_set_config(2,<f64>reidWorkers);}
  let baseY=PANEL_Y+407;for(let slot=0;slot<HITS_VISIBLE;slot++)if(x>=PANEL_X+12&&x<=PANEL_X+228&&y>=baseY+slot*62&&y<=baseY+slot*62+57){let h=hitAtVisibleSlot(slot);if(h!=null)viewerSnapshotId=h.snapshotId;}
}
export function mouseMove(x:i32,y:i32,buttons:i32,mods:i32):void{mouseX=x;mouseY=y;}
export function mouseWheel(deltaX:i32,deltaY:i32,mods:i32):void{
  if(viewerSnapshotId>=0)return;
  if(mouseX>=PANEL_X&&mouseX<=PANEL_X+PANEL_W&&mouseY>=PANEL_Y+390){if(deltaY>0)hitScroll=mini(maxi(0,hits.length-HITS_VISIBLE),hitScroll+1);else if(deltaY<0)hitScroll=maxi(0,hitScroll-1);}
}
export function textInput(codepoint:i32):void{if(!isEditingUrl)return;if(codepoint>=32&&codepoint<=126&&currentStreamUrl.length<150)currentStreamUrl+=String.fromCharCode(codepoint);}
export function keyDown(keyCode:i32,mods:i32,repeat:i32):void{if(viewerSnapshotId>=0&&keyCode==27){viewerSnapshotId=-1;return;}if(!isEditingUrl)return;if(keyCode==8&&currentStreamUrl.length>0)currentStreamUrl=currentStreamUrl.slice(0,currentStreamUrl.length-1);else if(keyCode==13)isEditingUrl=false;}

export function videoFrameDecoded(w:i32,h:i32):void{lastFrameTimestamp=now_ms();videoFrameSeq++;}
export function wsEvent(wsId:i32,eventType:i32,payloadLen:i32):void{if(wsId!=activeWsId&&activeWsId>=0)return;if(eventType==1)statusMessage="CONNECTED // LIVE + HYBRID TRACK + PERSON REID READY";else if(eventType==-1)statusMessage="STREAM ERROR // CHECK WHEP / MEDIAMTX";}
export function appStop():void{host_ai_set_enabled(0);if(activeWsId>=0){host_ws_close(activeWsId);activeWsId=-1;}isStreaming=false;tracker.reset();}
