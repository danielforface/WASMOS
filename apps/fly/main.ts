// ZVUV / FLY 3.0 EMBODIED AUTONOMY — single-file AssemblyScript application, WASMOS Host ABI 6.
// Strict closed loop: world -> sensors -> mapped connectome -> descending neural outputs -> VNC/body -> world.
// No wall, food, threat or scene rule is allowed to steer the body directly. The environment may only
// create physical forces/collisions and sensory transduction. Experimental model: not a validated animal.
// Build: asc app_FLY.ts -O3 --exportRuntime --runtime incremental -o fly.wasm
// מיפוי ישיר לפונקציות שה-Host של WASM OS V31 כבר מזריק ב-STDLIB:
@inline function pick_file(p: usize, n: i32): i32 { return host_resource_pick_file(p, n); }
@inline function resource_state(h: i32): i32 { return host_resource_state(h); }
@inline function size_lo(h: i32): u32 { return host_resource_size_lo(h); }
@inline function size_hi(h: i32): u32 { return host_resource_size_hi(h); }
@inline function read_range(h: i32, lo: u32, hi: u32, p: usize, n: i32): i32 { return host_resource_read_range(h, lo, hi, p, n); }
@inline function read_status(q: i32): i32 { return host_resource_request_status(q); }
@inline function read_bytes(q: i32): i32 { return host_resource_request_bytes(q); }
@inline function release_read(q: i32): i32 { return host_resource_request_release(q); }
@inline function close_resource(h: i32): i32 { return host_resource_close(h); }
@inline function audio_play(p: usize, n: i32, rate: i32): i32 { return host_audio_play_pcm(p, n, rate); }
@inline function text_draw(p: usize, w: i32, h: i32, t: usize, l: i32, x: i32, y: i32, m: i32, f: i32, c: u32, flags: i32): i32 {
  return host_unicode_text_draw(p, w, h, t, l, x, y, m, f, c, flags);
}
@inline function download(p: usize, n: i32, t: usize, l: i32): i32 { return download_bytes(p, n, t, l); }
@inline function manifest_set(p: usize, n: i32): i32 { return host_app_manifest_set(p, n); }
@inline function set_title(p: usize, n: i32): void { host_set_window_title(p, n); }

// The portable profile uses the authoritative in-module CPU/SIMD simulation.

// פונקציות תמונה (אינן חלק מ-ABI 4.2 המובנה, נשארות כ-externals במידה וההוסט מטפל בהן כ-stub)
@external("host", "image_decode") declare function image_decode(p: usize, n: i32, m: usize, l: i32): i32;
@external("host", "image_draw") declare function image_draw(h: i32, p: usize, w: i32, t: i32, x: i32, y: i32, dw: i32, dh: i32): i32;
@external("host", "image_release") declare function image_release(h: i32): i32;
const W:i32=1280,H:i32=800,AX:i32=20,AY:i32=134,AW:i32=930,AH:i32=586,BGW:i32=465,BGH:i32=293;
const CHANNELS:i32=69,RING:i32=16,MAX_BYTES:i32=440*1024*1024;
const BG:u32=0xff17120d,PANEL:u32=0xff241e16,TEXT:u32=0xffeadfd0,MUTED:u32=0xffaa9580,ACCENT:u32=0xffc7e887,AMBER:u32=0xff80b7f2,LINE:u32=0xff3a3025;
export const pixels=new Uint32Array(W*H);
const scene=new Uint32Array(BGW*BGH),sensors=new Float32Array(CHANNELS),previousVision=new Float32Array(48),visionAdapt=new Float32Array(48);
const motor=new Float32Array(7),history=new Float32Array(240),trailX=new Float32Array(1200),trailY=new Float32Array(1200),trailZ=new Float32Array(1200);
let brain:Brain|null=null,loader:Loader|null=null;const retired=new Array<Loader>();
let running:bool=true,started:bool=false,visible:bool=true,showTrail:bool=true,showVision:bool=false,neuronView:bool=false;
let neuronPage:i32=0,selectedNeuron:i32=0,historyAt:i32=0,trailAt:i32=0,trailCount:i32=0,scenePreset:i32=0;
let status:string="Embodied Autonomy 3.0: mapped neural outputs are the sole actuator source; collisions only create forces and sensation.",sceneName:string="Apartment / diffuse daylight";
let pendingImage:i32=-1,imageStarted:f64=0,previewUntil:f64=0;
let mouseX:f64=-1000,mouseY:f64=-1000,mouseActive:bool=false;
let timeScale:f64=1,synGain:f32=1,inputGain:f32=1,audioGain:f32=1,seed:u32=0x9e3779b9;

// =============================================================================
// STAGE 3: EMBODIED 3D BIOMECHANICS, VNC EXECUTION & APARTMENT PHYSICS
// =============================================================================
// World coordinates are render-friendly units. One world unit = 4 mm for force/velocity conversion.
const WORLD_M_PER_UNIT:f64 = 0.004;
const ROOM_Z:f64 = 650.0;            // ~2.6 m ceiling
const FLY_RADIUS:f64 = 0.40;         // collision radius ~1.6 mm at the chosen world scale
const FLY_BODY_LENGTH_M:f64 = 0.0026;
const GRAVITY_WORLD:f64 = 9.81 / WORLD_M_PER_UNIT;

class Leg3D {
  coxaAngle:f64 = 0.0;      // neural/CPG joint offset used by renderer
  femurAngle:f64 = 0.0;
  tibiaAngle:f64 = 0.0;
  phase:f64 = 0.0;
  isStance:bool = true;
  groundLoad:f64 = 0.0;
  footX:f64 = 0.0; footY:f64 = 0.0; footZ:f64 = 0.0;
}

class Surface3D {
  x1:f64; y1:f64; x2:f64; y2:f64; z:f64;
  constructor(x1:f64,y1:f64,x2:f64,y2:f64,z:f64){this.x1=x1;this.y1=y1;this.x2=x2;this.y2=y2;this.z=z;}
}

class Wall3D {
  x1:f64; y1:f64; x2:f64; y2:f64; z1:f64; z2:f64; thickness:f64;
  constructor(x1:f64,y1:f64,x2:f64,y2:f64,z1:f64,z2:f64,thickness:f64=7.0){
    this.x1=x1;this.y1=y1;this.x2=x2;this.y2=y2;this.z1=z1;this.z2=z2;this.thickness=thickness;
  }
}

class Box3D {
  x1:f64; y1:f64; z1:f64; x2:f64; y2:f64; z2:f64; kind:i32;
  constructor(x1:f64,y1:f64,z1:f64,x2:f64,y2:f64,z2:f64,kind:i32=0){
    this.x1=x1;this.y1=y1;this.z1=z1;this.x2=x2;this.y2=y2;this.z2=z2;this.kind=kind;
  }
}

// Apartment plan: outer shell + partitions with actual door gaps.
const apartmentWalls = new Array<Wall3D>();
apartmentWalls.push(new Wall3D(0,0,AW,0,0,ROOM_Z,9));
apartmentWalls.push(new Wall3D(AW,0,AW,AH,0,ROOM_Z,9));
apartmentWalls.push(new Wall3D(AW,AH,0,AH,0,ROOM_Z,9));
apartmentWalls.push(new Wall3D(0,AH,0,0,0,ROOM_Z,9));
// Bedroom / living partition, doorway y=220..330.
apartmentWalls.push(new Wall3D(640,0,640,220,0,ROOM_Z,7));
apartmentWalls.push(new Wall3D(640,330,640,AH,0,ROOM_Z,7));
// Hall partition, doorway x=255..380.
apartmentWalls.push(new Wall3D(0,330,255,330,0,ROOM_Z,7));
apartmentWalls.push(new Wall3D(380,330,640,330,0,ROOM_Z,7));

const furniture = new Array<Box3D>();
// Dining table: thin top plus four legs.
furniture.push(new Box3D(250,155,176,610,350,188,1));
furniture.push(new Box3D(266,171,0,284,189,176,1));
furniture.push(new Box3D(576,171,0,594,189,176,1));
furniture.push(new Box3D(266,316,0,284,334,176,1));
furniture.push(new Box3D(576,316,0,594,334,176,1));
// Sofa and kitchen counter make the space read as an apartment rather than an arena.
furniture.push(new Box3D(55,400,0,255,545,105,2));
furniture.push(new Box3D(700,45,0,900,145,225,3));

const roomSurfaces = [new Surface3D(0,0,<f64>AW,<f64>AH,0), new Surface3D(250,155,610,350,188)];

class Camera3D {
  yaw:f64 = -0.72;
  pitch:f64 = 0.48;
  dist:f64 = 1180.0;
  targetX:f64 = 465.0;
  targetY:f64 = 293.0;
  targetZ:f64 = 170.0;
  isDragging:bool = false;
  lastMouseX:i32 = 0; lastMouseY:i32 = 0;
  projectX:f64=0; projectY:f64=0; projectScale:f64=1.0;

  project(worldX:f64,worldY:f64,worldZ:f64):bool{
    let dx=worldX-this.targetX,dy=worldY-this.targetY,dz=worldZ-this.targetZ;
    let cosY=Math.cos(this.yaw),sinY=Math.sin(this.yaw);
    let x1=dx*cosY-dy*sinY;
    let y1=dx*sinY+dy*cosY;
    let cosP=Math.cos(this.pitch),sinP=Math.sin(this.pitch);
    let y2=y1*cosP-dz*sinP;
    let z2=y1*sinP+dz*cosP;
    let depth=this.dist+y2;
    if(depth<80.0)return false;
    let fov=720.0;
    this.projectScale=fov/depth;
    this.projectX=<f64>(AX+AW/2)+x1*this.projectScale;
    this.projectY=<f64>(AY+AH/2)-z2*this.projectScale;
    return true;
  }
}
const camera=new Camera3D();

class FlyBody3D {
  // Position/velocity in world units and world-units/s. Orientation in radians.
  x:f64=465.0; y:f64=293.0; z:f64=FLY_RADIUS;
  vx:f64=0.0; vy:f64=0.0; vz:f64=0.0;
  yaw:f64=0.3; pitch:f64=0.0; roll:f64=0.0;
  angVelYaw:f64=0.0; angVelPitch:f64=0.0; angVelRoll:f64=0.0;

  mass:f64=1.2e-6;                // kg, Drosophila-scale body mass
  inertiaYaw:f64=1.5e-12;
  inertiaPitch:f64=1.2e-12;
  inertiaRoll:f64=0.8e-12;

  legs:Array<Leg3D>=new Array<Leg3D>(6);
  cpgPhase:f64=0.0;

  wingFreq:f64=0.0;
  wingPhase:f64=0.0;
  wingPower:f64=0.0;
  wingAmpL:f64=0.0; wingAmpR:f64=0.0;
  wingAngleOfAttack:f64=0.78539816339; // ~45 degrees during force-producing stroke
  airDensity:f64=1.225;
  wingArea:f64=2.4e-6;             // m^2 per wing
  liftForce:f64=0.0;
  dragForce:f64=0.0;

  chordotonalStrainL:f32=0;
  chordotonalStrainR:f32=0;
  campaniformSensillaWing:f32=0;
  energy:f64=0.85;

  constructor(){for(let i=0;i<6;i++)this.legs[i]=new Leg3D();}
  reset():void{
    this.x=465;this.y=293;this.z=FLY_RADIUS;this.vx=0;this.vy=0;this.vz=0;
    this.yaw=0.3;this.pitch=0;this.roll=0;this.angVelYaw=0;this.angVelPitch=0;this.angVelRoll=0;
    this.wingFreq=0;this.wingPhase=0;this.wingPower=0;this.liftForce=0;this.dragForce=0;this.cpgPhase=0;this.energy=0.85;
    for(let i=0;i<6;i++){let l=this.legs[i];l.phase=(i==0||i==4||i==2)?0:Math.PI;l.isStance=true;l.groundLoad=0;l.coxaAngle=0;l.femurAngle=0;l.tibiaAngle=0;}
  }
}
const body=new FlyBody3D();
let posX:f64=465,posY:f64=293,heading:f64=0.3,speed:f64=0,altitude:f64=0,energy:f64=0.85,gait:f64=0,contactL:f32=0,contactR:f32=0;
let contactFront:f32=0,contactUp:f32=0,contactDown:f32=0;

// VNC execution state. Every value below is derived from mapped neural outputs or physical feedback.
const motorFast=new Float32Array(7),motorSlow=new Float32Array(7),motorPrev=new Float32Array(7);
const legPhase=new Float32Array(6),legLoad=new Float32Array(6);
let decoderTicks:i32=0,angularVel:f64=0,cpgPhase:f64=0;
let neuralForward:f32=0,neuralYaw:f32=0,neuralFlight:f32=0,neuralBurst:f32=0,bodyArousal:f32=0;
let bodyMode:i32=0; // 0 rest, 1 walk, 2 flight, 3 landing/contact
let directSensorActuation:bool=false;

// =============================================================================
// STAGE 4: VOLUMETRIC WORLD ENTITIES, ODOR FIELD & PHYSICAL STIMULI
// =============================================================================
class WorldEntity3D {
  x:f64;y:f64;z:f64;vx:f64;vy:f64;vz:f64;kind:i32;radius:f64;height:f64;intensity:f32;timer:f64=0;
  constructor(x:f64,y:f64,z:f64,kind:i32,radius:f64,height:f64,intensity:f32){this.x=x;this.y=y;this.z=z;this.vx=0;this.vy=0;this.vz=0;this.kind=kind;this.radius=radius;this.height=height;this.intensity=intensity;}
  update(dt:f64,flyX:f64,flyY:f64,flyZ:f64):void{
    this.timer+=dt;
    if(this.kind==2){
      // Predator is an independent world agent. It may move toward the fly, but never writes motor commands.
      let dx=flyX-this.x,dy=flyY-this.y,d=Math.sqrt(dx*dx+dy*dy);
      if(this.z>20.0){if(d>1){this.vx+=(dx/d)*50.0*dt;this.vy+=(dy/d)*50.0*dt;}this.vz=-155.0;}
      else this.vz=210.0;
      this.vx*=0.97;this.vy*=0.97;this.x=clamp(this.x+this.vx*dt,20,AW-20);this.y=clamp(this.y+this.vy*dt,20,AH-20);this.z=clamp(this.z+this.vz*dt,12,ROOM_Z-35);
    }else if(this.kind==1)this.intensity=cf(<f32>(0.72+0.28*Math.sin(this.timer*3.2)),0.1,1.0);
  }
}
const entities=new Array<WorldEntity3D>();
let smellL:f32=0,smellR:f32=0,smellMean:f32=0,smellDelta:f32=0,prevSmell:f32=0;
let loomingThreat:f32=0;
let simMs:f64=0,totalSpikes:f64=0,completedTicks:i32=0,debt:f64=0,lastWall:f64=0,windowSpikes:i32=0,rateHz:f64=0,wallRatio:f64=0,frameMs:f64=0,lastRateWall:f64=0,lastRateSim:f64=0;
let sound=new Float32Array(0),soundFeatures=new Float32Array(0),soundRate:i32=0,soundFrames:i32=0,soundClock:f64=0,soundReady:bool=false,soundEnabled:bool=false,soundLoop:bool=true,soundRms:f32=0,soundName:string="No WAV loaded";
let analysisSound=new Float32Array(0),analysisFeatures=new Float32Array(0),analysisRate:i32=0,analysisFrames:i32=0,analysisAt:i32=0,analysisActive:bool=false;
const crcTable=new Uint32Array(256);let labelCache=new Map<string,ArrayBuffer>();

// =============================================================================
// STAGE 2: EXPLICIT FLYBRAIN SENSORIMOTOR MAPPING (NO HASH-DERIVED ANATOMY)
// =============================================================================
// =============================================================================
// STAGE 5: SCIENTIFIC VALIDATION, E/I BALANCE & LOOMING BENCHMARK (5.1 - 5.3)
// =============================================================================
class NeuropilDiagnostics {
  // 5.1 Firing rates across anatomical functional regions
  rateOpticL: f32 = 0.0;
  rateOpticR: f32 = 0.0;
  rateCentral: f32 = 0.0;
  rateDN: f32 = 0.0;
  eiState: string = "BALANCED"; // BALANCED, QUENCHED (0Hz), HYPERACTIVE (Epileptiform)

  // 5.2 Looming Stimulus Benchmark State Machine
  benchmarkActive: bool = false;
  benchmarkStartTime: f64 = 0.0;
  benchmarkShadowRadius: f64 = 4.0;
  flightLatencyMs: f64 = -1.0;
  takeoffDetected: bool = false;
  benchmarkPassed: bool = false;
  benchmarkResult: string = "STANDBY (Click BENCH)";

  // 5.3 Visual Neuropil Activity Sparklines
  activityHalo: f32 = 0.0;
  spikeActivityRing: Float32Array = new Float32Array(64);
  ringHead: i32 = 0;

  updateRegionalRates(b: Brain, overlay: SemanticMappingEngine): void {
    if (!overlay.isMapped) return;

    // 1. Optic Lobes Left / Right
    let sumL: f32 = 0.0;
    for (let i = 0; i < overlay.retinaLeft.length; i++) sumL += b.rates[unchecked(overlay.retinaLeft[i])];
    this.rateOpticL = overlay.retinaLeft.length > 0 ? (sumL / <f32>overlay.retinaLeft.length) : 0.0;

    let sumR: f32 = 0.0;
    for (let i = 0; i < overlay.retinaRight.length; i++) sumR += b.rates[unchecked(overlay.retinaRight[i])];
    this.rateOpticR = overlay.retinaRight.length > 0 ? (sumR / <f32>overlay.retinaRight.length) : 0.0;

    // 2. Descending Motor Pathway
    let sumDN: f32 = 0.0;
    let dnTotal = overlay.motorForward.length + overlay.motorYawLeft.length + overlay.motorYawRight.length + overlay.motorFlight.length;
    for (let i = 0; i < overlay.motorForward.length; i++) sumDN += b.rates[unchecked(overlay.motorForward[i])];
    for (let i = 0; i < overlay.motorYawLeft.length; i++) sumDN += b.rates[unchecked(overlay.motorYawLeft[i])];
    for (let i = 0; i < overlay.motorYawRight.length; i++) sumDN += b.rates[unchecked(overlay.motorYawRight[i])];
    for (let i = 0; i < overlay.motorFlight.length; i++) sumDN += b.rates[unchecked(overlay.motorFlight[i])];
    this.rateDN = dnTotal > 0 ? (sumDN / <f32>dnTotal) : 0.0;

    // 3. Central Complex / Interneurons
    this.rateCentral = cf(<f32>(rateHz * 1.1) - (this.rateOpticL + this.rateOpticR) * 0.2, 0.0, 100.0);

    // Evaluate Biological E/I Balance
    if (rateHz < 0.2) this.eiState = "QUENCHED (0 Hz)";
    else if (rateHz > 45.0) this.eiState = "EPILEPTIC (Over-saturated)";
    else this.eiState = "HOMEOSTATIC (E/I Balanced)";

    // Buffer for Neuropil Halo Visualization
    this.activityHalo = cf((this.rateOpticL + this.rateOpticR + this.rateDN * 2.0) / 40.0, 0.0, 1.0);
    this.spikeActivityRing[this.ringHead] = <f32>b.spikeCount;
    this.ringHead = (this.ringHead + 1) & 63;
  }

  startLoomingBenchmark(currentMs: f64): void {
    this.benchmarkActive = true;
    this.benchmarkStartTime = currentMs;
    this.benchmarkShadowRadius = 4.0;
    this.flightLatencyMs = -1.0;
    this.takeoffDetected = false;
    this.benchmarkPassed = false;
    this.benchmarkResult = "TESTING: visual looming -> mapped flight output";
    notify("Initiated visual looming benchmark. No motor pathway is injected; mapped graph output must recruit flight.");
  }

  stepBenchmark(currentMs: f64, flightDrive: f32, bodyClearance: f64): void {
    if (!this.benchmarkActive) return;

    let elapsed = currentMs - this.benchmarkStartTime;
    // Shadow expands exponentially simulating incoming predator
    this.benchmarkShadowRadius = min(180.0, 4.0 * Math.exp(elapsed * 0.0035));

    // Register mapped flight-output recruitment (output code 4); no anatomical name is inferred.
    if (this.flightLatencyMs < 0.0 && flightDrive > 0.35) {
      this.flightLatencyMs = elapsed;
      notify("Mapped flight output recruited. Latency: " + fixed(this.flightLatencyMs, 1) + " ms");
    }

    // Register physical flight liftoff
    if (bodyClearance > 1.5) {
      this.takeoffDetected = true;
    }

    if (this.flightLatencyMs > 0.0 && this.takeoffDetected) {
      this.benchmarkPassed = true;
      this.benchmarkActive = false;
      this.benchmarkResult = "PASS: mapped flight latency " + fixed(this.flightLatencyMs, 1) + "ms -> takeoff";
      notify("Looming benchmark passed: visual stimulus recruited mapped flight output and physical takeoff.");
    } else if (elapsed > 1800.0) {
      this.benchmarkActive = false;
      this.benchmarkPassed = false;
      this.benchmarkResult = "FAIL: mapped flight output stayed below threshold for 1800ms";
      notify("Looming benchmark failed: visual stimulus did not recruit mapped flight output.");
    }
  }
}

const diagnostics = new NeuropilDiagnostics();

class SemanticMappingEngine {
  retinaLeft:Array<i32>=new Array<i32>();
  retinaRight:Array<i32>=new Array<i32>();
  jonAuditoryAirflow:Array<i32>=new Array<i32>();
  tactileProprio:Array<i32>=new Array<i32>();
  olfactoryLeft:Array<i32>=new Array<i32>();
  olfactoryRight:Array<i32>=new Array<i32>();
  motorForward:Array<i32>=new Array<i32>();
  motorYawLeft:Array<i32>=new Array<i32>();
  motorYawRight:Array<i32>=new Array<i32>();
  motorFlight:Array<i32>=new Array<i32>();
  motorBrake:Array<i32>=new Array<i32>();
  feeding:Array<i32>=new Array<i32>();
  isMapped:bool=false;
  hasOlfaction:bool=false;

  clear():void{
    this.retinaLeft.length=0;this.retinaRight.length=0;this.jonAuditoryAirflow.length=0;this.tactileProprio.length=0;
    this.olfactoryLeft.length=0;this.olfactoryRight.length=0;this.motorForward.length=0;this.motorYawLeft.length=0;this.motorYawRight.length=0;
    this.motorFlight.length=0;this.motorBrake.length=0;this.feeding.length=0;this.isMapped=false;this.hasOlfaction=false;
  }

  build(b:Brain):void{
    this.clear();
    // The packed FLYBRAIN mapping table is the authority. Root-id numerology is never used to invent anatomy.
    for(let j=0;j<b.m;j++){
      let p=b.blob.dataStart+b.maps+j*16;
      let neuron=<i32>load<u32>(p),ch=<i32>load<u16>(p+4),out=<i32>load<u8>(p+6);
      if(ch>=1&&ch<=24)this.retinaLeft.push(neuron);
      else if(ch>=25&&ch<=48)this.retinaRight.push(neuron);
      else if(ch>=49&&ch<=56)this.jonAuditoryAirflow.push(neuron);
      else if(ch>=57&&ch<=64)this.tactileProprio.push(neuron);
      else if(ch==65){this.olfactoryLeft.push(neuron);this.hasOlfaction=true;}
      else if(ch==66){this.olfactoryRight.push(neuron);this.hasOlfaction=true;}
      else if(ch>=67&&ch<=68)this.hasOlfaction=true;
      if(out==1)this.motorForward.push(neuron);
      else if(out==2)this.motorYawLeft.push(neuron);
      else if(out==3)this.motorYawRight.push(neuron);
      else if(out==4)this.motorFlight.push(neuron);
      else if(out==5)this.motorBrake.push(neuron);
      else if(out==6)this.feeding.push(neuron);
    }
    this.isMapped=b.m>0;
    notify("FLYBRAIN explicit map active: "+b.m.toString()+" entries; "+(this.hasOlfaction?"olfaction mapped":"odor field available on channels 65-68 but graph has no olfactory map"));
  }
}

const semanticOverlay = new SemanticMappingEngine();
@inline function clamp(v:f64,a:f64,b:f64):f64{return max(a,min(b,v));}
@inline function cf(v:f32,a:f32,b:f32):f32{return max(a,min(b,v));}
@inline function u32at(b:Uint8Array,p:i32):u32{return load<u32>(b.dataStart+p);}
@inline function f32at(b:Uint8Array,p:i32):f32{return load<f32>(b.dataStart+p);}
@inline function align4(n:i32):i32{return(n+3)&~3;}
function utf(s:string):ArrayBuffer{return String.UTF8.encode(s);}
function notify(s:string):void{status=s;let b=utf(s);log_utf8(changetype<usize>(b),b.byteLength);}
function fixed(v:f64,d:i32=2):string{let scale=d==0?1:d==1?10:100,n=<i64>Math.round(v*scale),a=(n/scale).toString();if(!d)return a;let b=(abs(n)%scale).toString();while(b.length<d)b="0"+b;return a+"."+b;}
@inline function random01():f32{seed^=seed<<13;seed^=seed>>17;seed^=seed<<5;return <f32>(seed>>8)/16777216.0;}
function crcInit():void{for(let i:u32=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=(c&1)?0xedb88320^(c>>1):c>>1;crcTable[i]=c;}}
function crcRange(b:Uint8Array,a:i32,z:i32,c:u32):u32{for(let j=a;j<z;j++)c=unchecked(crcTable[(c^b[j])&255])^(c>>8);return c;}

// LIF neuron and edge state is separate from immutable packed CSR topology.
// One tick is complete only when its whole neuron sweep and spike propagation finish.
class Brain{
 blob:Uint8Array;n:i32;e:i32;m:i32;ids:i32;rows:i32;targets:i32;weights:i32;delays:i32;maps:i32;flags:i32;
 tauM:f32;tauS:f32;threshold:f32;refract:i32;decayM:f32;decayS:f32;
 v:Float32Array=new Float32Array(0);current:Float32Array=new Float32Array(0);pending:Float32Array=new Float32Array(0);input:Float32Array=new Float32Array(0);rates:Float32Array=new Float32Array(0);counts:Float32Array=new Float32Array(7);
 refractory:Uint8Array=new Uint8Array(0);spikes:Int32Array=new Int32Array(0);
 stage:i32=0;cursor:i32=0;spikeCount:i32=0;propSpike:i32=0;propEdge:i32=-1;tick:i32=0;
 constructor(data:Uint8Array){this.blob=data;this.n=<i32>u32at(data,16);this.e=<i32>u32at(data,20);this.m=<i32>u32at(data,24);this.flags=<i32>u32at(data,28);
 this.ids=<i32>u32at(data,40);this.rows=<i32>u32at(data,44);this.targets=<i32>u32at(data,48);this.weights=<i32>u32at(data,52);this.delays=<i32>u32at(data,56);this.maps=<i32>u32at(data,60);
 this.tauM=f32at(data,64);this.tauS=f32at(data,68);this.threshold=f32at(data,72);this.refract=<i32>u32at(data,76);this.decayM=<f32>Math.exp(-1.0/this.tauM);this.decayS=<f32>Math.exp(-1.0/this.tauS);
 this.v=new Float32Array(this.n);this.current=new Float32Array(this.n);this.pending=new Float32Array(this.n*RING);this.input=new Float32Array(this.n);this.rates=new Float32Array(this.n);this.refractory=new Uint8Array(this.n);this.spikes=new Int32Array(this.n);
 synGain=f32at(data,92)==0?1:f32at(data,92);inputGain=f32at(data,96)==0?1:f32at(data,96);audioGain=f32at(data,100)==0?1:f32at(data,100);
 // Build explicit sensorimotor groups from the loaded FLYBRAIN mapping table.
 semanticOverlay.build(this);
 for(let j=0;j<this.m;j++){let o=load<u8>(data.dataStart+this.maps+j*16+6);if(o)this.counts[o]+=1;}
 }
 @inline row(i:i32):i32{return <i32>load<u32>(this.blob.dataStart+this.rows+i*4);}
 reset():void{this.v.fill(0);this.current.fill(0);this.pending.fill(0);this.input.fill(0);this.rates.fill(0);this.refractory.fill(0);this.stage=0;this.tick=0;this.spikeCount=0;}
 begin():void{
  this.input.fill(0);
  // STRICT sensory transduction: only explicit FLYBRAIN mapping entries may inject current.
  for(let j=0;j<this.m;j++){
    let p=this.blob.dataStart+this.maps+j*16,ch=<i32>load<u16>(p+4);
    if(ch>0&&ch<CHANNELS)this.input[<i32>load<u32>(p)]+=sensors[ch]*load<f32>(p+8)*inputGain;
  }
  this.spikeCount=0;this.cursor=0;this.stage=1;
 }
 work():bool{
 if(this.stage==1){let end=min(this.n,this.cursor+32768),base=(this.tick&15)*this.n;
 let vp=this.v.dataStart,ip=this.current.dataStart,pp=this.pending.dataStart+base*4,rp=this.refractory.dataStart,ratep=this.rates.dataStart,inp=this.input.dataStart,sp=this.spikes.dataStart;
 // Fixed LIF dynamics from the loaded FLYBRAIN header. Do not invent a global
 // monoamine scalar that changes every neuron's threshold or membrane constant.
 let dm=this.decayM,ds=this.decayS;
 let threshold=this.threshold;
 for(let j=this.cursor;j<end;j++){let o=<usize>j*4,syn=load<f32>(ip+o)*ds+load<f32>(pp+o);store<f32>(pp+o,0);store<f32>(ip+o,syn);store<f32>(ratep+o,load<f32>(ratep+o)*<f32>0.99004984);
 let rf=load<u8>(rp+j);if(rf){store<u8>(rp+j,rf-1);store<f32>(vp+o,0);continue;}
 let v=load<f32>(vp+o)*dm+(syn+load<f32>(inp+o))*(<f32>1-dm);
 if(v>=threshold){store<f32>(vp+o,0);store<u8>(rp+j,<u8>this.refract);store<i32>(sp+<usize>this.spikeCount*4,j);this.spikeCount++;store<f32>(ratep+o,load<f32>(ratep+o)+<f32>10);}else store<f32>(vp+o,max(<f32>-20*threshold,v));}
 this.cursor=end;if(end==this.n){this.stage=2;this.propSpike=0;this.propEdge=-1;}return false;}
 if(this.stage==2){let quota=160000;let effSynGain:f32=synGain;
 while(this.propSpike<this.spikeCount&&quota>0){let id=this.spikes[this.propSpike],end=this.row(id+1);if(this.propEdge<0)this.propEdge=this.row(id);let stop=min(end,this.propEdge+quota);quota-=stop-this.propEdge;
 for(let e=this.propEdge;e<stop;e++){let p=this.blob.dataStart,t=<i32>load<u32>(p+this.targets+e*4),d=<i32>load<u8>(p+this.delays+e),slot=((this.tick+d)&15)*this.n+t,address=this.pending.dataStart+<usize>slot*4;store<f32>(address,load<f32>(address)+load<f32>(p+this.weights+e*4)*effSynGain);}
 this.propEdge=stop;if(stop==end){this.propSpike++;this.propEdge=-1;}}
 if(this.propSpike==this.spikeCount){this.stage=0;this.tick++;return true;}}
 return false;}
 outputs():void{
  motor.fill(0);
  // STRICT motor decoding: only explicit output mappings in the loaded graph can actuate the VNC/body.
  for(let j=0;j<this.m;j++){
    let p=this.blob.dataStart+this.maps+j*16,o=<i32>load<u8>(p+6);
    if(o>0&&o<7)motor[o]+=this.rates[<i32>load<u32>(p)]*load<f32>(p+12);
  }
  for(let k=1;k<7;k++)motor[k]=cf(motor[k]/max(<f32>1,this.counts[k])/<f32>80,0,1);
 }
}
// 4096-node synthetic integration fixture, explicitly never labelled FlyWire.
function synthetic():Uint8Array{let n=4096,e=n*8,m=576,ids=128,rows=ids+n*8,t=rows+(n+1)*4,w=t+e*4,d=w+e*4,mp=align4(d+e),len=mp+m*16,b=new Uint8Array(len),p=b.dataStart;
 store<u64>(p,0x4e49415242594c46);store<u32>(p+8,1);store<u32>(p+12,0x01020304);store<u32>(p+16,n);store<u32>(p+20,e);store<u32>(p+24,m);store<u32>(p+32,len);store<u32>(p+40,ids);store<u32>(p+44,rows);store<u32>(p+48,t);store<u32>(p+52,w);store<u32>(p+56,d);store<u32>(p+60,mp);store<f32>(p+64,20);store<f32>(p+68,5);store<f32>(p+72,1);store<u32>(p+76,2);store<u32>(p+88,len);
 let saved=seed;seed=0x5a17;
 for(let i=0;i<n;i++){store<u64>(p+ids+i*8,<u64>i+1);store<u32>(p+rows+i*4,i*8);for(let k=0;k<8;k++){let edge=i*8+k,target=<i32>(random01()*<f32>n),weight:f32=0.12;
 if(i<512&&k<5){let ch=i/8+1,group=ch<=24?2:ch<=48?3:ch<=56?4:ch==59?6:1;target=1024+(group-1)*8+k%8;weight=2.8;}else if(i>=512&&i<1024)weight=-0.14;
 store<u32>(p+t+edge*4,target);store<f32>(p+w+edge*4,weight);store<u8>(p+d+edge,<u8>(1+k%3));}}
 store<u32>(p+rows+n*4,e);for(let j=0;j<m;j++){let q=p+mp+j*16;if(j<512){store<u32>(q,j);store<u16>(q+4,j/8+1);store<f32>(q+8,3.2);}else if(j<560){let k=j-512;store<u32>(q,1024+k);store<u8>(q+6,<u8>(k/8+1));store<f32>(q+12,1);}else{store<u32>(q,1024+(j-560)%8);store<u16>(q+4,64);store<f32>(q+8,0.82);}}
 seed=saved;store<u32>(p+36,crcRange(b,128,len,0xffffffff)^0xffffffff);return b;}
function imageMime(b:Uint8Array):string{if(b.length>=8&&u32at(b,0)==0x474e5089&&u32at(b,4)==0x0a1a0a0d)return "image/png";if(b.length>=3&&b[0]==255&&b[1]==216&&b[2]==255)return "image/jpeg";if(b.length>=12&&u32at(b,0)==0x46464952&&u32at(b,8)==0x50424557)return "image/webp";if(b.length>=2&&b[0]==66&&b[1]==77)return "image/bmp";return "";}
function estimatedBytes(extra:u64):u64{if(brain!=null)extra+=<u64>brain!.blob.length+<u64>brain!.n*104;for(let r=0;r<retired.length;r++)extra+=retired[r].data.length;return extra;}
// Transactional asynchronous loader. New data becomes active only after all checks pass.
class Loader{
 handle:i32;kind:i32;request:i32=-1;phase:i32=0;offset:i32=0;total:i32=0;want:i32=0;checked:i32=128;crc:u32=0xffffffff;scan:i32=0;lastId:u64=0;lastRow:u32=0;since:f64;
 data:Uint8Array=new Uint8Array(0);
 constructor(h:i32,k:i32){this.handle=h;this.kind=k;this.since=now_ms();}
 fail(s:string):void{this.phase=-1;notify(s);}
 close():void{
 // Host resource_cancel marks -2 before Blob.arrayBuffer settles. Keep live buffers
 // referenced instead of trusting cancellation as evidence that the write is finished.
 if(this.request>=0&&read_status(this.request)==0){this.phase=-2;retired.push(this);return;}
 if(this.request>=0){release_read(this.request);this.request=-1;}if(this.handle>=0)close_resource(this.handle);this.handle=-1;}
 header():bool{let b=this.data;if(b.length<128||load<u64>(b.dataStart)!=0x4e49415242594c46||u32at(b,8)!=1||u32at(b,12)!=0x01020304){this.fail("Expected FLYBRAIN/1. Use the supplied converter for raw FlyWire files.");return false;}
 let n=u32at(b,16),e=u32at(b,20),m=u32at(b,24);if(n<1||n>250000||e>32000000||m>1000000||u32at(b,28)>2){this.fail("Unsupported graph dimensions.");return false;}
 let ids:u64=128,rows=ids+n*8,t=rows+(n+1)*4,w=t+e*4,d=w+e*4,mp=(d+e+3)&~<u64>3,meta=mp+m*16;
 if(estimatedBytes(<u64>b.length+<u64>n*104)>720*1024*1024){this.fail("Working memory budget exceeded. Switch to SYNTHETIC before replacing this large graph.");return false;}
 if(u32at(b,32)!=u32(b.length)||u32at(b,40)!=ids||u32at(b,44)!=rows||u32at(b,48)!=t||u32at(b,52)!=w||u32at(b,56)!=d||u32at(b,60)!=mp||u32at(b,88)!=meta||meta+u32at(b,80)!=u64(b.length)){this.fail("Invalid offsets or truncated connectome.");return false;}
 let tm=f32at(b,64),ts=f32at(b,68),th=f32at(b,72),rf=u32at(b,76);if(!isFinite(tm)||!isFinite(ts)||!isFinite(th)||tm<2||tm>1000||ts<1||ts>1000||th<0.01||th>100||rf>50){this.fail("Invalid LIF parameters.");return false;}
 for(let o=92;o<=100;o+=4){let g=f32at(b,o);if(!isFinite(g)||g<0||g>(o==92?4:8)){this.fail("Invalid gain defaults.");return false;}}return true;}
 pump():void{
 if(now_ms()-this.since>120000){this.fail("File operation timed out; active graph retained.");return;}
 if(this.phase==0){let st=resource_state(this.handle);if(st==0)return;if(st!=1){this.fail("File selection cancelled or inaccessible.");return;}
 let size=size_lo(this.handle),limit=this.kind==1?MAX_BYTES:this.kind==2?32*1024*1024:64*1024*1024;
 if(size_hi(this.handle)!=0||size==0||size>u32(limit)||estimatedBytes(size)>720*1024*1024){this.fail("File exceeds the memory limit.");return;}
 this.total=<i32>size;this.data=new Uint8Array(this.total);this.phase=1;}
 if(this.phase==1){if(this.request>=0){let st=read_status(this.request);if(st==0)return;if(st<0||read_bytes(this.request)!=this.want){this.fail("Incomplete read; previous asset retained.");return;}release_read(this.request);this.request=-1;this.offset+=this.want;this.since=now_ms();}
 if(this.offset<this.total){this.want=min(1024*1024,this.total-this.offset);this.request=read_range(this.handle,<u32>this.offset,0,this.data.dataStart+this.offset,this.want);if(this.request<0)this.fail("Host refused file read.");return;}
 close_resource(this.handle);this.handle=-1;
 if(this.kind==1){if(!this.header())return;this.phase=2;}
 else if(this.kind==2){let mt=imageMime(this.data);if(mt.length==0){this.fail("Use PNG, JPEG, WebP or BMP.");return;}let mime=utf(mt),id=image_decode(this.data.dataStart,this.total,changetype<usize>(mime),mime.byteLength);if(id<0){this.fail("Image decode failed.");return;}if(pendingImage>=0)image_release(pendingImage);pendingImage=id;imageStarted=now_ms();this.phase=9;notify("Decoding image...");return;}
 else{if(!decodeWav(this.data)){this.fail("WAV rejected. Use PCM or float32, mono/stereo, 8–96 kHz, <=120 seconds.");return;}this.phase=9;return;}}
 if(this.phase==2){let end=min(this.total,this.checked+256*1024);this.crc=crcRange(this.data,this.checked,end,this.crc);this.checked=end;if(end==this.total){if((this.crc^0xffffffff)!=u32at(this.data,36)){this.fail("Checksum mismatch; active graph retained.");return;}this.phase=3;this.scan=0;}return;}
 if(this.phase==3){let n=<i32>u32at(this.data,16),ids=<i32>u32at(this.data,40),rows=<i32>u32at(this.data,44),e=u32at(this.data,20),end=min(n+1,this.scan+8192);
 for(let i=this.scan;i<end;i++){let r=u32at(this.data,rows+i*4);if(r<this.lastRow||r>e||(i==0&&r!=0)||(i==n&&r!=e)){this.fail("Invalid CSR pointers.");return;}this.lastRow=r;if(i<n){let id=load<u64>(this.data.dataStart+ids+i*8);if(id==0||(i>0&&id<=this.lastId)){this.fail("Neuron IDs must be positive, unique and sorted.");return;}this.lastId=id;}}
 this.scan=end;if(end==n+1){this.phase=4;this.scan=0;}return;}
 if(this.phase==4){let e=<i32>u32at(this.data,20),n=u32at(this.data,16),t=<i32>u32at(this.data,48),w=<i32>u32at(this.data,52),d=<i32>u32at(this.data,56),end=min(e,this.scan+32000);
 for(let i=this.scan;i<end;i++){let wt=f32at(this.data,w+i*4),delay=this.data[d+i];if(u32at(this.data,t+i*4)>=n||!isFinite(wt)||abs(wt)>100||delay<1||delay>15){this.fail("Invalid edge, weight or delay.");return;}}this.scan=end;if(end==e){this.phase=5;this.scan=0;}return;}
 if(this.phase==5){let m=<i32>u32at(this.data,24),n=u32at(this.data,16),mp=<i32>u32at(this.data,60),end=min(m,this.scan+8192);
 for(let j=this.scan;j<end;j++){let p=this.data.dataStart+mp+j*16,g=load<f32>(p+8),mg=load<f32>(p+12);if(load<u32>(p)>=n||<i32>load<u16>(p+4)>=CHANNELS||load<u8>(p+6)>6||!isFinite(g)||!isFinite(mg)||abs(g)>100||abs(mg)>100){this.fail("Invalid sensory/motor mapping.");return;}}
 this.scan=end;if(end==m){brain=new Brain(this.data);resetWorld();neuronPage=0;selectedNeuron=0;this.phase=9;notify(m==0?"Graph loaded without a sensorimotor profile: no body drive defined.":"Loaded "+n.toString()+" neurons. Sensorimotor coupling is an unvalidated model.");}return;}}
}
function choose(kind:i32):void{if(loader!=null||retired.length>=2){notify("A read is still active. Wait or press Esc to cancel the visible load.");return;}
 let a=utf(kind==1?".flybrain":kind==2?"image/png,image/jpeg,image/webp,image/bmp":".wav,audio/wav"),h=pick_file(changetype<usize>(a),a.byteLength);if(h<0){notify("Host could not open the picker.");return;}loader=new Loader(h,kind);notify("Select a local file...");}
function cancelLoad():void{if(loader!=null){loader!.close();loader=null;}if(pendingImage>=0){image_release(pendingImage);pendingImage=-1;}analysisActive=false;analysisSound=new Float32Array(0);analysisFeatures=new Float32Array(0);notify("Load cancelled; active graph and stimuli retained.");}
export function imageEvent(id:i32,state:i32,width:i32,height:i32):void{if(id!=pendingImage||state==0)return;if(state==1&&width>0&&height>0){let tmp=new Uint32Array(BGW*BGH);tmp.fill(0xffc5cbd0);if(image_draw(id,tmp.dataStart,BGW,BGH,0,0,BGW,BGH)>0){scene.set(tmp);sceneName="Imported image / visual stimulus";scenePreset=-1;notify("Image pixels now feed the visual channels.");}else notify("Could not draw decoded image; previous scene retained.");}else notify("Image decoder rejected file; previous scene retained.");image_release(id);pendingImage=-1;}

// Local RIFF/WAVE parsing. The host receives PCM only for optional speaker preview.
function decodeWav(b:Uint8Array):bool{
 if(b.length<44||u32at(b,0)!=0x46464952||u32at(b,8)!=0x45564157)return false;let declared=<u64>u32at(b,4)+8;if(declared>u64(b.length)||declared<12)return false;
 let p=12,fmt=0,ch=0,rate=0,bits=0,block=0,data=0,len=0;
 while(u64(p)+8<=declared){let id=u32at(b,p),sz=u32at(b,p+4);if(u64(p)+8+sz>declared)return false;
 if(id==0x20746d66){if(sz<16)return false;fmt=<i32>load<u16>(b.dataStart+p+8);ch=<i32>load<u16>(b.dataStart+p+10);rate=<i32>u32at(b,p+12);block=<i32>load<u16>(b.dataStart+p+20);bits=<i32>load<u16>(b.dataStart+p+22);
 if(fmt==65534){if(sz<40||load<u16>(b.dataStart+p+24)<22)return false;let sub=p+32;fmt=<i32>u32at(b,sub);if(u32at(b,sub+4)!=0x00100000||u32at(b,sub+8)!=0xaa000080||u32at(b,sub+12)!=0x719b3800)return false;}}
 else if(id==0x61746164&&data==0){data=p+8;len=<i32>sz;}p+=8+<i32>sz+(<i32>sz&1);}
 if(data==0||ch<1||ch>2||rate<8000||rate>96000||(fmt!=1&&fmt!=3)||(fmt==3&&bits!=32)||(bits!=8&&bits!=16&&bits!=24&&bits!=32)||block!=ch*(bits/8)||len%block!=0)return false;
 let count=len/block;if(count<32||count>rate*120)return false;let out=new Float32Array(count);
 for(let i=0;i<count;i++){let v:f32=0;for(let c=0;c<ch;c++){let q=b.dataStart+data+i*block+c*(bits/8),s:f32=0;
 if(fmt==3){s=load<f32>(q);if(!isFinite(s))return false;}else if(bits==8)s=(<f32>load<u8>(q)-128)/128;else if(bits==16)s=<f32>load<i16>(q)/32768;else if(bits==24){let z=<i32>load<u8>(q)|(<i32>load<u8>(q+1)<<8)|(<i32>load<u8>(q+2)<<16);s=<f32>((z<<8)>>8)/8388608;}else s=<f32>(<f64>load<i32>(q)/2147483648.0);v+=cf(s,-1,1)/<f32>ch;}out[i]=v;}
 analysisSound=out;analysisRate=rate;analysisFrames=<i32>Math.ceil(<f64>count*50/rate);analysisFeatures=new Float32Array(analysisFrames*9);analysisAt=0;analysisActive=true;notify("WAV decoded. Computing acoustic bands...");return true;}
function pumpAudio():void{if(!analysisActive)return;let end=min(analysisFrames,analysisAt+4);
 for(let f=analysisAt;f<end;f++){let start=f*analysisRate/50,stop=min(analysisSound.length,(f+1)*analysisRate/50),n=stop-start,sum:f64=0;for(let j=0;j<n;j++){let s=analysisSound[start+j];sum+=s*s;}analysisFeatures[f*9+8]=<f32>Math.sqrt(sum/max(1,n));
 for(let k=0;k<8;k++){let freq:f64=80*Math.pow(1.65,k),coeff=2*Math.cos(2*Math.PI*freq/analysisRate),s1:f64=0,s2:f64=0;
 for(let j=0;j<n;j++){let w=0.5-0.5*Math.cos(2*Math.PI*j/max(1,n-1)),v=analysisSound[start+j]*w+coeff*s1-s2;s2=s1;s1=v;}
 analysisFeatures[f*9+k]=<f32>clamp(4*Math.sqrt(max(0,s1*s1+s2*s2-coeff*s1*s2))/max(1,n),0,1);}}
 analysisAt=end;if(end==analysisFrames){sound=analysisSound;soundRate=analysisRate;soundFrames=analysisFrames;soundFeatures=analysisFeatures;soundClock=0;soundReady=true;soundEnabled=true;soundName="WAV / "+(<i32>(<f64>sound.length*1000/soundRate)).toString()+" ms";analysisActive=false;analysisSound=new Float32Array(0);analysisFeatures=new Float32Array(0);notify("Audio ready. Neural sound follows simulation time; LISTEN uses wall time.");}}
function makeScene(preset:i32):void{scenePreset=preset;sceneName=preset==0?"Apartment / diffuse daylight":preset==1?"Apartment / high contrast":preset==2?"Apartment / window gradient":"Apartment / dim target light";
 for(let y=0;y<BGH;y++)for(let x=0;x<BGW;x++){let r=0,g=0,b=0;
 if(preset==0){let vein=abs((x-232)*0.25+(y-146)),texture=<i32>(8*Math.sin(x*0.11+y*0.04)+4*Math.sin(y*0.3));r=78+texture;g=104+texture;b=63+texture;if(vein<2||(<i32>(y+x*0.35)%38)<2){r+=20;g+=23;b+=14;}}
 else if(preset==1){let a=((x/18)&1)?213:34;r=a;g=a;b=a;}else if(preset==2){let a=70+x*170/BGW;r=a;g=a;b=a-10;}else{let d=Math.sqrt((x-330)*(x-330)+(y-100)*(y-100)),a=<i32>(28+200*Math.exp(-d*d/2000));r=a;g=a;b=a;}
 scene[y*BGW+x]=0xff000000|(<u32>b<<16)|(<u32>g<<8)|<u32>r;}}
@inline function luminance(x:f64,y:f64):f32{let ix=<i32>clamp(x*BGW/AW,0,BGW-1),iy=<i32>clamp(y*BGH/AH,0,BGH-1),c=scene[iy*BGW+ix];return(<f32>(c&255)*0.2126+<f32>((c>>8)&255)*0.7152+<f32>((c>>16)&255)*0.0722)/255;}
@inline function pointInsideBox(x:f64,y:f64,z:f64,b:Box3D):bool{return x>=b.x1&&x<=b.x2&&y>=b.y1&&y<=b.y2&&z>=b.z1&&z<=b.z2;}
function pointNearWall(x:f64,y:f64,z:f64,w:Wall3D,margin:f64=0.0):bool{
 if(z<w.z1||z>w.z2)return false;
 let dx=w.x2-w.x1,dy=w.y2-w.y1,l2=dx*dx+dy*dy,t=l2>0?clamp(((x-w.x1)*dx+(y-w.y1)*dy)/l2,0,1):0;
 let cx=w.x1+t*dx,cy=w.y1+t*dy,rx=x-cx,ry=y-cy,r=w.thickness*0.5+margin;
 return rx*rx+ry*ry<=r*r;
}
function geometryOcclusion(x:f64,y:f64,z:f64):f32{
 if(x<0||x>AW||y<0||y>AH||z<0||z>ROOM_Z)return 1.0;
 for(let i=0;i<apartmentWalls.length;i++)if(pointNearWall(x,y,z,apartmentWalls[i],1.0))return 0.95;
 for(let i=0;i<furniture.length;i++)if(pointInsideBox(x,y,z,furniture[i]))return 0.80;
 return 0.0;
}
function odorAt(x:f64,y:f64,z:f64):f32{
 let total:f64=0.0;
 // A weak persistent kitchen/fruit odor creates a navigable gradient without commanding motion.
 let kdx=x-820.0,kdy=y-95.0,kdz=(z-238.0)*0.7;
 total+=0.24*Math.exp(-Math.sqrt(kdx*kdx+kdy*kdy+kdz*kdz)/150.0);
 for(let i=0;i<entities.length;i++){
  let e=entities[i];if(e.kind!=1)continue;
  let dx=x-e.x,dy=y-e.y,dz=(z-(e.z+e.height*0.5))*0.65,d=Math.sqrt(dx*dx+dy*dy+dz*dz);
  total+=<f64>e.intensity*Math.exp(-d/105.0);
 }
 return cf(<f32>total,0,1);
}
function supportHeightAt(x:f64,y:f64,z:f64):f64{
 let h=0.0;
 for(let i=0;i<furniture.length;i++){
  let b=furniture[i];
  if(x>=b.x1-FLY_RADIUS&&x<=b.x2+FLY_RADIUS&&y>=b.y1-FLY_RADIUS&&y<=b.y2+FLY_RADIUS&&z>=b.z2-FLY_RADIUS*3.0){
    if(b.z2>h)h=b.z2;
  }
 }
 return h;
}
function registerContact(nx:f64,ny:f64,nz:f64,amount:f32):void{
 let cy=Math.cos(body.yaw),sy=Math.sin(body.yaw);
 let side=(-sy)*nx+cy*ny,front=cy*nx+sy*ny;
 if(abs(nz)>0.55){if(nz>0)contactDown=max(contactDown,amount);else contactUp=max(contactUp,amount);return;}
 if(front< -0.35){contactFront=max(contactFront,amount);contactL=max(contactL,amount);contactR=max(contactR,amount);}
 else if(side>0)contactL=max(contactL,amount);else contactR=max(contactR,amount);
}
function resolveWallCollision(w:Wall3D):void{
 if(body.z+FLY_RADIUS<w.z1||body.z-FLY_RADIUS>w.z2)return;
 let dx=w.x2-w.x1,dy=w.y2-w.y1,l2=dx*dx+dy*dy,t=l2>0?clamp(((body.x-w.x1)*dx+(body.y-w.y1)*dy)/l2,0,1):0;
 let cx=w.x1+t*dx,cy=w.y1+t*dy,rx=body.x-cx,ry=body.y-cy,d=Math.sqrt(rx*rx+ry*ry),minD=FLY_RADIUS+w.thickness*0.5;
 if(d>=minD)return;
 let nx:f64,ny:f64;if(d>0.0001){nx=rx/d;ny=ry/d;}else{let inv=1.0/max(0.001,Math.sqrt(l2));nx=-dy*inv;ny=dx*inv;}
 let pen=minD-d;body.x+=nx*pen;body.y+=ny*pen;
 let vn=body.vx*nx+body.vy*ny;if(vn<0){body.vx-=vn*1.22*nx;body.vy-=vn*1.22*ny;}body.vx*=0.86;body.vy*=0.86;
 registerContact(nx,ny,0,cf(<f32>(0.35+pen*0.45),0,1));
}
function resolveBoxCollision(b:Box3D):void{
 let qx=clamp(body.x,b.x1,b.x2),qy=clamp(body.y,b.y1,b.y2),qz=clamp(body.z,b.z1,b.z2),dx=body.x-qx,dy=body.y-qy,dz=body.z-qz,d2=dx*dx+dy*dy+dz*dz;
 if(d2>=FLY_RADIUS*FLY_RADIUS)return;
 let d=Math.sqrt(d2),nx:f64=0,ny:f64=0,nz:f64=0;
 if(d>0.0001){nx=dx/d;ny=dy/d;nz=dz/d;}
 else{
  let px=min(body.x-b.x1,b.x2-body.x),py=min(body.y-b.y1,b.y2-body.y),pz=min(body.z-b.z1,b.z2-body.z);
  if(px<=py&&px<=pz)nx=(body.x-(b.x1+b.x2)*0.5)<0?-1:1;
  else if(py<=pz)ny=(body.y-(b.y1+b.y2)*0.5)<0?-1:1;
  else nz=(body.z-(b.z1+b.z2)*0.5)<0?-1:1;
 }
 let pen=FLY_RADIUS-(d>0.0001?d:0);body.x+=nx*pen;body.y+=ny*pen;body.z+=nz*pen;
 let vn=body.vx*nx+body.vy*ny+body.vz*nz;if(vn<0){body.vx-=vn*1.15*nx;body.vy-=vn*1.15*ny;body.vz-=vn*1.15*nz;}
 registerContact(nx,ny,nz,cf(<f32>(0.35+pen*0.5),0,1));
}
function updateSensors():void{sensors.fill(0);
 let cyaw=Math.cos(body.yaw),syaw=Math.sin(body.yaw),cpitch=Math.cos(body.pitch),spitch=Math.sin(body.pitch);
 // 48 compound-eye channels. Geometry is sampled volumetrically so all apartment walls/furniture are visible before impact.
 for(let eye=0;eye<2;eye++){
  let eyeSign:f64=eye==0?-1.0:1.0;
  let eyeX=body.x-syaw*eyeSign*0.22,eyeY=body.y+cyaw*eyeSign*0.22,eyeZ=body.z+0.08;
  for(let j=0;j<24;j++){
   let col=j%6,row=j/6,azimuth=eyeSign*(0.28+<f64>col*0.20),elevation=-0.38+<f64>row*0.24;
   let rayX=Math.cos(azimuth)*Math.cos(elevation)*cyaw-Math.sin(azimuth)*syaw;
   let rayY=Math.cos(azimuth)*Math.cos(elevation)*syaw+Math.sin(azimuth)*cyaw;
   let rayZ=Math.sin(elevation)*cpitch+Math.cos(elevation)*spitch;
   let lum:f32=0,nearest:f64=280.0;
   for(let step=1;step<=10;step++){
    let d=<f64>step*28.0,sx=eyeX+rayX*d,sy=eyeY+rayY*d,sz=eyeZ+rayZ*d,occ=geometryOcclusion(sx,sy,sz);
    let sl=luminance(sx,sy);
    if(occ>0.1){sl=cf(sl*(1.0-occ)+0.06*occ,0,1);nearest=min(nearest,d);}
    if(diagnostics.benchmarkActive){let bx=body.x+cyaw*85.0,by=body.y+syaw*85.0,bdx=sx-bx,bdy=sy-by;if(bdx*bdx+bdy*bdy<diagnostics.benchmarkShadowRadius*diagnostics.benchmarkShadowRadius)sl*=0.03;}
    for(let k=0;k<entities.length;k++){let e=entities[k],ex=sx-e.x,ey=sy-e.y,ez=sz-e.z;if(ex*ex+ey*ey<e.radius*e.radius&&ez>=0&&ez<=e.height){if(e.kind==1)sl=cf(sl+e.intensity*0.7,0,1);else sl*=0.08;nearest=min(nearest,d);}}
    lum+=sl;
   }
   let sampled=lum/10.0,idx=eye*24+j,delta=abs(sampled-previousVision[idx]);previousVision[idx]=sampled;
   let proximity=<f32>(1.0-clamp(nearest/280.0,0,1));
   sensors[idx+1]=cf(sampled*0.72+delta*2.9+proximity*0.34+0.06,0,1);
  }
 }
 // Auditory/airflow legacy channels 49..56 remain backward-compatible.
 soundRms=0;
 if(soundEnabled&&soundReady){let duration=<f64>sound.length*1000.0/soundRate;if(soundClock>=duration){if(soundLoop)soundClock%=duration;else soundEnabled=false;}if(soundEnabled){let frame=min(soundFrames-1,<i32>(soundClock/20.0));for(let k=0;k<8;k++)sensors[49+k]=cf(soundFeatures[frame*9+k]*audioGain*8.0,0,1);soundRms=soundFeatures[frame*9+8];}}
 else{let airMps=<f32>(Math.sqrt(body.vx*body.vx+body.vy*body.vy+body.vz*body.vz)*WORLD_M_PER_UNIT);for(let k=0;k<8;k++)sensors[49+k]=cf(airMps*(0.6+<f32>k*0.12)*audioGain,0,1);}

 // Bilateral olfaction is computed at the antennae, never converted directly into steering.
 let aheadX=cyaw*0.55,aheadY=syaw*0.55,leftX=-syaw*0.25,leftY=cyaw*0.25;
 smellL=odorAt(body.x+aheadX+leftX,body.y+aheadY+leftY,body.z+0.08);
 smellR=odorAt(body.x+aheadX-leftX,body.y+aheadY-leftY,body.z+0.08);
 smellMean=(smellL+smellR)*0.5;smellDelta=cf(smellMean-prevSmell,-1,1);prevSmell=smellMean;
 sensors[65]=smellL;sensors[66]=smellR;sensors[67]=cf(abs(smellL-smellR),0,1);sensors[68]=cf(smellMean+max(<f32>0,smellDelta)*0.7,0,1);

 sensors[57]=cf(contactL+body.chordotonalStrainL,0,1);sensors[58]=cf(contactR+body.chordotonalStrainR,0,1);
 sensors[59]=<f32>(1.0-body.energy);
 sensors[60]=cf(<f32>((abs(body.angVelYaw)+abs(body.angVelPitch)+abs(body.angVelRoll))*0.11),0,1);
 sensors[61]=cf(body.campaniformSensillaWing,0,1);sensors[62]=<f32>body.energy;sensors[63]=random01();sensors[64]=1.0;
}
function decodeNeuralMotor():void{
 decoderTicks++;
 for(let k=1;k<7;k++){
  motorFast[k]+=<f32>0.42*(motor[k]-motorFast[k]);
  motorSlow[k]+=<f32>0.075*(motor[k]-motorSlow[k]);
 }
 neuralForward=cf(motorSlow[1],0,1);
 neuralYaw=cf(motorSlow[3]-motorSlow[2],-1,1);
 neuralFlight=cf(motorSlow[4],0,1);
 neuralBurst=cf(max(<f32>0,motorFast[4]-motorSlow[4])*2.6,0,1);
 bodyArousal=max(neuralForward,max(neuralFlight,abs(neuralYaw)));
 for(let k=1;k<7;k++)motorPrev[k]=motor[k];
}
function worldStep():void{
 brain!.outputs();decodeNeuralMotor();
 let dt:f64=0.01;
 contactL*=0.30;contactR*=0.30;contactFront*=0.25;contactUp*=0.25;contactDown*=0.25;
 let support=supportHeightAt(body.x,body.y,body.z),supportCenter=support+FLY_RADIUS;
 let grounded=body.z<=supportCenter+0.20&&body.vz<=8.0;
 let brake=<f64>motorSlow[5],forward=<f64>neuralForward,yawCmd=<f64>neuralYaw;

 // VNC tripod CPG: neural forward drive changes cadence; there is no autonomous cadence at zero drive.
 let stepFreq=grounded&&forward>0.012?(1.2+12.5*Math.sqrt(forward))*(1.0-0.80*brake):0.0;
 if(stepFreq>0)body.cpgPhase+=stepFreq*dt*2.0*Math.PI;
 let loadL:f64=0,loadR:f64=0,stanceCount:f64=0;
 for(let i=0;i<6;i++){
  let leg=body.legs[i],tripod=(i==0||i==4||i==2)?0:1;
  leg.phase=body.cpgPhase+(tripod==0?0.0:Math.PI);legPhase[i]=<f32>leg.phase;
  let s=Math.sin(leg.phase),c=Math.cos(leg.phase),swing=max(0.0,s),stance=max(0.0,-s);
  leg.isStance=grounded&&stepFreq>0&&s<=0.10;
  // Joint trajectories are deliberately bounded to fly-like ranges; renderer uses these directly.
  leg.coxaAngle=c*0.34*forward;
  leg.femurAngle=(0.20+0.42*swing)*forward;
  leg.tibiaAngle=(0.18+0.38*stance)*forward;
  leg.groundLoad=leg.isStance?stance*forward*(0.7+0.3*c*c):0.0;legLoad[i]=<f32>leg.groundLoad;
  if(leg.isStance)stanceCount+=1.0;if(i<3)loadL+=leg.groundLoad;else loadR+=leg.groundLoad;
 }
 body.chordotonalStrainL=cf(<f32>(loadL/3.0),0,1);body.chordotonalStrainR=cf(<f32>(loadR/3.0),0,1);

 // Ground mechanics: neural drive sets muscle target; traction and friction move the body.
 let cy=Math.cos(body.yaw),sy=Math.sin(body.yaw),fwdV=body.vx*cy+body.vy*sy,latV=body.vx*(-sy)+body.vy*cy;
 if(grounded){
  let targetV=forward*14.0*(1.0-brake*0.9),traction=(targetV-fwdV)*(7.0+stanceCount*0.8);
  body.vx+=(traction*cy+(-latV*12.0)*(-sy))*dt;body.vy+=(traction*sy+(-latV*12.0)*cy)*dt;
  body.angVelYaw+=(yawCmd*17.0-body.angVelYaw*7.5)*dt;
  body.pitch+=(0.0-body.pitch)*dt*8.0;body.roll+=(0.0-body.roll)*dt*8.0;
  // A rapid neural flight recruitment burst can unload the feet; this is neural temporal dynamics, not a world trigger.
  if(neuralBurst>0.18)body.vz+=<f64>neuralBurst*95.0;
 }

 // Asynchronous flight muscles: neural flight recruitment controls power; wing oscillator generates the high-frequency stroke.
 let targetPower=clamp(<f64>neuralFlight*(1.0-brake*0.75),0,1);
 body.wingPower+=(targetPower-body.wingPower)*(1.0-Math.exp(-dt*18.0));
 if(body.wingPower>0.015){
  body.wingFreq=110.0+120.0*Math.sqrt(body.wingPower);
  body.wingPhase+=body.wingFreq*dt*2.0*Math.PI;
  let turn=yawCmd;
  body.wingAmpL=clamp(1.85-turn*0.28,1.15,2.15);body.wingAmpR=clamp(1.85+turn*0.28,1.15,2.15);
  let R=2.5e-3,uL=2.0*body.wingAmpL*body.wingFreq*R,uR=2.0*body.wingAmpR*body.wingFreq*R;
  let u2=0.5*(uL*uL+uR*uR),cl=0.25+1.8*Math.sin(2.0*body.wingAngleOfAttack),cd=1.50-1.0*Math.cos(2.0*body.wingAngleOfAttack);
  body.liftForce=0.5*body.airDensity*(body.wingArea*2.0)*u2*cl;
  body.dragForce=0.5*body.airDensity*(body.wingArea*2.0)*u2*cd;
  body.campaniformSensillaWing=cf(<f32>(body.liftForce/(body.mass*9.81*1.8)),0,1);
  // Steering muscles alter bilateral wing work. Aerodynamic torque is bounded only for numerical stability.
  let yawTorque=0.5*body.airDensity*body.wingArea*(uR*uR-uL*uL)*cl*1.4e-3;
  let yawAcc=clamp(yawTorque/body.inertiaYaw,-420.0,420.0);
  body.angVelYaw+=(yawAcc-body.angVelYaw*18.0)*dt;
  let targetPitch=-0.34*forward,targetRoll=0.42*yawCmd;
  body.angVelPitch+=(targetPitch-body.pitch)*42.0*dt-body.angVelPitch*9.0*dt;
  body.angVelRoll+=(targetRoll-body.roll)*55.0*dt-body.angVelRoll*11.0*dt;
  body.pitch=clamp(body.pitch+body.angVelPitch*dt,-0.62,0.50);body.roll=clamp(body.roll+body.angVelRoll*dt,-0.75,0.75);
  // Force vector: pitch converts some wing force to forward acceleration; roll produces lateral acceleration.
  let aLift=body.liftForce/body.mass/WORLD_M_PER_UNIT;
  let vertical=aLift*Math.cos(body.pitch)*Math.cos(body.roll)-GRAVITY_WORLD;
  let forwardA=-aLift*Math.sin(body.pitch),lateralA=aLift*Math.sin(body.roll)*0.65;
  body.vx+=(forwardA*cy+lateralA*(-sy))*dt;body.vy+=(forwardA*sy+lateralA*cy)*dt;body.vz+=vertical*dt;
 }else{
  body.wingFreq=0;body.liftForce=0;body.dragForce=0;body.campaniformSensillaWing=0;
  if(!grounded)body.vz-=GRAVITY_WORLD*dt;
 }

 body.yaw+=body.angVelYaw*dt;body.yaw=Math.atan2(Math.sin(body.yaw),Math.cos(body.yaw));
 // Aerodynamic/viscous damping. It dissipates motion but never chooses a direction.
 let airDamp=body.z>supportCenter+0.2?Math.exp(-dt*1.7):Math.exp(-dt*4.0);body.vx*=airDamp;body.vy*=airDamp;body.vz*=Math.exp(-dt*0.45);
 body.x+=body.vx*dt;body.y+=body.vy*dt;body.z+=body.vz*dt;

 // Passive contact resolution only. No collision path modifies yaw toward a target or generates voluntary translation.
 for(let i=0;i<apartmentWalls.length;i++)resolveWallCollision(apartmentWalls[i]);
 for(let i=0;i<furniture.length;i++)resolveBoxCollision(furniture[i]);
 // Floor / supporting surface.
 support=supportHeightAt(body.x,body.y,body.z);supportCenter=support+FLY_RADIUS;
 if(body.z<supportCenter){let impact=abs(body.vz);body.z=supportCenter;if(body.vz<0)body.vz=-body.vz*0.08;registerContact(0,0,1,cf(<f32>(0.25+impact*0.015),0,1));}
 // Ceiling is a real sixth boundary.
 if(body.z>ROOM_Z-FLY_RADIUS){let pen=body.z-(ROOM_Z-FLY_RADIUS);body.z=ROOM_Z-FLY_RADIUS;if(body.vz>0)body.vz=-body.vz*0.18;registerContact(0,0,-1,cf(<f32>(0.35+pen*0.2),0,1));}

 // Independent entities update and collide physically. Food changes energy only after contact; it never pulls the body.
 for(let eIdx=entities.length-1;eIdx>=0;eIdx--){let e=entities[eIdx];e.update(dt,body.x,body.y,body.z);let dx=body.x-e.x,dy=body.y-e.y,dz=body.z-(e.z+min(e.height,body.z-e.z)),h2=dx*dx+dy*dy,rr=e.radius+FLY_RADIUS;
  if(h2<rr*rr&&body.z>=e.z-FLY_RADIUS&&body.z<=e.z+e.height+FLY_RADIUS){let d=Math.sqrt(max(0.0001,h2)),nx=dx/d,ny=dy/d,pen=rr-d;body.x+=nx*pen;body.y+=ny*pen;let vn=body.vx*nx+body.vy*ny;if(vn<0){body.vx-=vn*1.18*nx;body.vy-=vn*1.18*ny;}registerContact(nx,ny,0,0.8);if(e.kind==1&&body.energy<0.995){body.energy=min(1.0,body.energy+0.25);entities.splice(eIdx,1);notify("Nutrient source contacted and ingested; approach was produced by the neural loop.");}}
 }

 posX=body.x;posY=body.y;heading=body.yaw;speed=Math.sqrt(body.vx*body.vx+body.vy*body.vy)*WORLD_M_PER_UNIT*1000.0;altitude=clamp(body.z/ROOM_Z,0,1);
 bodyMode=body.z>supportHeightAt(body.x,body.y,body.z)+FLY_RADIUS+1.0?2:(forward>0.02?1:(brake>0.2?3:0));
 body.energy=clamp(body.energy+<f64>motorSlow[6]*dt*0.012-dt*(0.0005+forward*0.002+body.wingPower*0.010),0,1);energy=body.energy;gait=body.cpgPhase;
 trailX[trailAt]=<f32>body.x;trailY[trailAt]=<f32>body.y;trailZ[trailAt]=<f32>body.z;trailAt=(trailAt+1)%1200;trailCount=min(1200,trailCount+1);
}
function resetWorld():void{
 if(brain!=null)brain!.reset();body.reset();seed=0x9e3779b9;
 posX=body.x;posY=body.y;heading=body.yaw;speed=0;altitude=body.z/ROOM_Z;energy=body.energy;gait=0;
 contactL=0;contactR=0;contactFront=0;contactUp=0;contactDown=0;smellL=0;smellR=0;smellMean=0;smellDelta=0;prevSmell=0;
 motorFast.fill(0);motorSlow.fill(0);motorPrev.fill(0);legPhase.fill(0);legLoad.fill(0);neuralForward=0;neuralYaw=0;neuralFlight=0;neuralBurst=0;bodyArousal=0;bodyMode=0;
 simMs=0;completedTicks=0;totalSpikes=0;windowSpikes=0;rateHz=0;debt=0;lastRateSim=0;lastRateWall=now_ms();trailAt=0;trailCount=0;soundClock=0;
 previousVision.fill(0);history.fill(0);historyAt=0;motor.fill(0);
}
function tickDone():void{
 simMs++;
 completedTicks++;
 totalSpikes += brain!.spikeCount;
 windowSpikes += brain!.spikeCount;
 if(soundEnabled) soundClock++;

 if(completedTicks % 10 == 0) {
   worldStep();
   // 5.1 & 5.2 Step Regional Diagnostics & Looming Benchmark
   diagnostics.updateRegionalRates(brain!, semanticOverlay);
   diagnostics.stepBenchmark(now_ms(), motor[4], body.z-supportHeightAt(body.x,body.y,body.z));
 }

 if(completedTicks % 20 == 0){
   history[historyAt] = <f32>brain!.spikeCount;
   historyAt = (historyAt + 1) % 240;
 }
}
function simulate(deadline:f64):void{
 if(!running||!visible) return;
 let b = brain!;

 // Continuous SNN Execution Loop
 while(now_ms() < deadline){
   if(b.stage == 0){
     if(debt < 1.0) return;
     updateSensors();
     b.begin();
   }
   if(b.work()){
     tickDone();
     debt = max(0.0, debt - 1.0);
   }
 }
}

// Framebuffer primitives. No host rendering engine and no remote visual assets.
@inline function px(x:i32,y:i32,c:u32):void{if(u32(x)<u32(W)&&u32(y)<u32(H))unchecked(pixels[y*W+x]=c);}
function rect(x:i32,y:i32,w:i32,h:i32,c:u32):void{let x0=max(0,x),x1=min(W,x+w),y0=max(0,y),y1=min(H,y+h);for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++)unchecked(pixels[yy*W+xx]=c);}
function line(x0:f64,y0:f64,x1:f64,y1:f64,c:u32,width:i32=1):void{let steps=min(3000,<i32>max(abs(x1-x0),abs(y1-y0)));if(!steps){rect(<i32>x0,<i32>y0,width,width,c);return;}for(let i=0;i<=steps;i++){let t=<f64>i/steps;rect(<i32>(x0+(x1-x0)*t),<i32>(y0+(y1-y0)*t),width,width,c);}}
function fillQuad2D(x0:f64,y0:f64,x1:f64,y1:f64,x2:f64,y2:f64,x3:f64,y3:f64,c:u32):void{
 let steps=min(220,<i32>max(max(abs(x3-x0),abs(y3-y0)),max(abs(x2-x1),abs(y2-y1)))+1);
 for(let i=0;i<=steps;i++){let t=<f64>i/max(1,steps),ax=x0+(x3-x0)*t,ay=y0+(y3-y0)*t,bx=x1+(x2-x1)*t,by=y1+(y2-y1)*t;line(ax,ay,bx,by,c,2);}
}
function quad3D(x0:f64,y0:f64,z0:f64,x1:f64,y1:f64,z1:f64,x2:f64,y2:f64,z2:f64,x3:f64,y3:f64,z3:f64,c:u32):void{
 if(!camera.project(x0,y0,z0))return;let aX=camera.projectX,aY=camera.projectY;if(!camera.project(x1,y1,z1))return;let bX=camera.projectX,bY=camera.projectY;if(!camera.project(x2,y2,z2))return;let cX=camera.projectX,cY=camera.projectY;if(!camera.project(x3,y3,z3))return;let dX=camera.projectX,dY=camera.projectY;fillQuad2D(aX,aY,bX,bY,cX,cY,dX,dY,c);
 line(aX,aY,bX,bY,0xff5a4b39,1);line(bX,bY,cX,cY,0xff5a4b39,1);line(cX,cY,dX,dY,0xff5a4b39,1);line(dX,dY,aX,aY,0xff5a4b39,1);
}
function box3DDraw(b:Box3D,top:u32,side:u32):void{
 quad3D(b.x1,b.y1,b.z1,b.x2,b.y1,b.z1,b.x2,b.y1,b.z2,b.x1,b.y1,b.z2,side);
 quad3D(b.x2,b.y1,b.z1,b.x2,b.y2,b.z1,b.x2,b.y2,b.z2,b.x2,b.y1,b.z2,side);
 quad3D(b.x1,b.y2,b.z1,b.x1,b.y1,b.z1,b.x1,b.y1,b.z2,b.x1,b.y2,b.z2,side);
 quad3D(b.x2,b.y2,b.z1,b.x1,b.y2,b.z1,b.x1,b.y2,b.z2,b.x2,b.y2,b.z2,side);
 quad3D(b.x1,b.y1,b.z2,b.x2,b.y1,b.z2,b.x2,b.y2,b.z2,b.x1,b.y2,b.z2,top);
}
function wall3DDraw(w:Wall3D,c:u32):void{quad3D(w.x1,w.y1,w.z1,w.x2,w.y2,w.z1,w.x2,w.y2,w.z2,w.x1,w.y1,w.z2,c);}
function ellipse(x:f64,y:f64,rx:f64,ry:f64,a:f64,c:u32):void{let r=<i32>(max(rx,ry)+2),ca=Math.cos(a),sa=Math.sin(a);for(let yy=-r;yy<=r;yy++)for(let xx=-r;xx<=r;xx++){let u=(xx*ca+yy*sa)/rx,v=(-xx*sa+yy*ca)/ry;if(u*u+v*v<=1)px(<i32>x+xx,<i32>y+yy,c);}}
function label(s:string,x:i32,y:i32,size:i32=14,c:u32=TEXT,maxWidth:i32=900):void{let b:ArrayBuffer;if(labelCache.has(s))b=labelCache.get(s);else{b=utf(s);if(labelCache.size>180)labelCache.clear();labelCache.set(s,b);}text_draw(pixels.dataStart,W,H,changetype<usize>(b),b.byteLength,x,y,maxWidth,size,c,0);}
function button(x:i32,y:i32,w:i32,s:string,active:bool=false):void{rect(x,y,w,34,active?0xff416044:LINE);label(s,x+10,y+7,14,active?ACCENT:TEXT,w-16);}
function flyDraw(x:f64,y:f64,s:f64,a:f64):void{
 let ca=Math.cos(a),sa=Math.sin(a),isFlying=body.wingFreq>25.0||body.z>supportHeightAt(body.x,body.y,body.z)+FLY_RADIUS+0.5;
 let wingStroke=isFlying?Math.sin(body.wingPhase):0.0;
 // Six proportional articulated legs. Total leg length is now ~14 body-render units, not ~39.
 for(let i=0;i<6;i++){
  let leg=body.legs[i],side:f64=i<3?-1.0:1.0,idx=i%3;
  let attachX=idx==0?3.6:(idx==1?0.0:-4.0),attachY=side*3.3;
  let j1X=x+(attachX*ca-attachY*sa)*s,j1Y=y+(attachX*sa+attachY*ca)*s;
  let spread=idx==0?0.66:(idx==1?1.20:1.78),coxa:f64,femur:f64,tibia:f64;
  if(isFlying){coxa=a+side*(1.55+idx*0.16);femur=coxa+side*0.34;tibia=femur-side*0.48;}
  else{coxa=a+side*spread+leg.coxaAngle;femur=coxa+side*(0.46+leg.femurAngle);tibia=femur-side*(0.62+leg.tibiaAngle);}
  let j2X=j1X+Math.cos(coxa)*3.0*s,j2Y=j1Y+Math.sin(coxa)*3.0*s;
  let j3X=j2X+Math.cos(femur)*5.0*s,j3Y=j2Y+Math.sin(femur)*5.0*s;
  let j4X=j3X+Math.cos(tibia)*6.2*s,j4Y=j3Y+Math.sin(tibia)*6.2*s;
  let lc=leg.isStance&&!isFlying?0xff18120e:0xff2b251d;
  line(j1X,j1Y,j2X,j2Y,lc,max(1,<i32>(s*1.25)));line(j2X,j2Y,j3X,j3Y,lc,max(1,<i32>s));line(j3X,j3Y,j4X,j4Y,lc,1);
  ellipse(j4X,j4Y,0.8*s,0.65*s,0,leg.isStance&&!isFlying?0xff53694d:0xff3c3327);
 }
 let abdoX=x-7.6*ca*s,abdoY=y-7.6*sa*s;ellipse(abdoX,abdoY,10.5*s,5.3*s,a,0xff2a261f);
 for(let st=-2;st<=2;st++){let off=<f64>st*2.2*s,sx=abdoX+off*ca,sy=abdoY+off*sa;line(sx-3.7*sa*s,sy+3.7*ca*s,sx+3.7*sa*s,sy-3.7*ca*s,0xff15120f,max(1,<i32>(s*0.7)));}
 ellipse(x,y,6.8*s,5.4*s,a,0xff484236);ellipse(x-3.0*ca*s,y-3.0*sa*s,2.7*s,2.5*s,a,0xff5e5746);
 for(let side=-1;side<=1;side+=2){let sf=<f64>side,wa=a+sf*(isFlying?(0.78+wingStroke*0.72):0.24),wx=x-1.7*ca*s-sf*2.2*sa*s,wy=y-1.7*sa*s+sf*2.2*ca*s;
  let len=15.0*s;ellipse(wx-Math.cos(wa)*7.4*s,wy-Math.sin(wa)*7.4*s,8.4*s,3.35*s,wa,isFlying?0xbbe7f0df:0x88cad8ca);line(wx,wy,wx-Math.cos(wa)*len,wy-Math.sin(wa)*len,0xff708878,1);}
 let headX=x+6.4*ca*s,headY=y+6.4*sa*s;ellipse(headX,headY,4.1*s,4.0*s,a,0xff3b352b);
 for(let side=-1;side<=1;side+=2){let sf=<f64>side,eyeX=headX+(1.0*ca-sf*2.8*sa)*s,eyeY=headY+(1.0*sa+sf*2.8*ca)*s;ellipse(eyeX,eyeY,3.1*s,2.45*s,a+sf*0.2,0xff1717a5);
  let bx=headX+(3.0*ca-sf*1.15*sa)*s,by=headY+(3.0*sa+sf*1.15*ca)*s,tx=bx+(4.7*ca-sf*2.5*sa)*s,ty=by+(4.7*sa+sf*2.5*ca)*s;line(bx,by,tx,ty,(side<0?smellL:smellR)>0.08?0xff64d888:0xff181310,1);}
}
function drawNeurons():void{let b=brain!,start=neuronPage*4608;rect(AX,AY,AW,AH,PANEL);label("NEURAL ACTIVITY / index order, not anatomical position",AX+18,AY+14,17,TEXT,AW-40);label("N closes / Left-Right changes page / Click a cell to inspect",AX+18,AY+44,12,MUTED,AW-40);
 for(let k=0;k<4608&&start+k<b.n;k++){let i=start+k,v=cf(b.rates[i]/100,0,1),c=0xff000000|(<u32>(<f32>42+<f32>130*v)<<16)|(<u32>(<f32>44+<f32>193*v)<<8)|<u32>(<f32>24+<f32>160*v);rect(AX+24+k%96*9,AY+80+k/96*9,7,7,c);if(i==selectedNeuron){rect(AX+23+k%96*9,AY+79+k/96*9,9,1,AMBER);rect(AX+23+k%96*9,AY+79+k/96*9,1,9,AMBER);}}
 let id=max(0,min(b.n-1,selectedNeuron)),rid=load<u64>(b.blob.dataStart+b.ids+id*8);label("Page "+(neuronPage+1).toString()+" / "+((b.n+4607)/4608).toString()+"   Neuron ID: "+rid.toString(),AX+18,AY+522,15,ACCENT,AW-40);label("V="+fixed(b.v[id])+"  rate="+fixed(b.rates[id],1)+" Hz  outgoing="+(b.row(id+1)-b.row(id)).toString()+"  /  Ctrl+E exports activity",AX+18,AY+551,12,MUTED,AW-40);}
function drawArena():void{
 rect(AX,AY,AW,AH,0xff151914);
 // Projected trajectory is genuinely 3D now.
 if(showTrail&&trailCount>1){let start=(trailAt-trailCount+1200)%1200;for(let i=2;i<trailCount;i+=4){let p=(start+i-1)%1200,q=(start+i)%1200;if(camera.project(trailX[p],trailY[p],trailZ[p])){let x0=camera.projectX,y0=camera.projectY;if(camera.project(trailX[q],trailY[q],trailZ[q]))line(x0,y0,camera.projectX,camera.projectY,0xff779767,1);}}}
 // Floor plane and perspective parquet/grid.
 quad3D(0,0,0,AW,0,0,AW,AH,0,0,AH,0,0xff201a14);
 for(let gx=0;gx<=AW;gx+=70){if(camera.project(gx,0,0)){let x0=camera.projectX,y0=camera.projectY;if(camera.project(gx,AH,0))line(x0,y0,camera.projectX,camera.projectY,0xff34291f,1);}}
 for(let gy=0;gy<=AH;gy+=55){if(camera.project(0,gy,0)){let x0=camera.projectX,y0=camera.projectY;if(camera.project(AW,gy,0))line(x0,y0,camera.projectX,camera.projectY,0xff30261d,1);}}
 // Walls/partitions. Door gaps are physical and visible.
 for(let i=0;i<apartmentWalls.length;i++){let w=apartmentWalls[i],outer=i<4;wall3DDraw(w,outer?0xff273027:0xff30362d);}
 // Ceiling outline.
 if(camera.project(0,0,ROOM_Z)){let aX=camera.projectX,aY=camera.projectY;if(camera.project(AW,0,ROOM_Z)){let bX=camera.projectX,bY=camera.projectY;line(aX,aY,bX,bY,0xff596052,2);}}
 // Furniture solids.
 for(let i=0;i<furniture.length;i++){let f=furniture[i];if(f.kind==1)box3DDraw(f,0xff6d5337,0xff3f3020);else if(f.kind==2)box3DDraw(f,0xff37464b,0xff273238);else box3DDraw(f,0xff6b6857,0xff444237);}
 // Pendant lamp for room-scale depth cue.
 if(camera.project(470,285,ROOM_Z)){let tx=camera.projectX,ty=camera.projectY;if(camera.project(470,285,ROOM_Z-115)){line(tx,ty,camera.projectX,camera.projectY,0xff8b8a78,1);ellipse(camera.projectX,camera.projectY,10*camera.projectScale,6*camera.projectScale,0,0xffb9d9ef);}}
 // Entities in the same camera projection as the room.
 for(let i=0;i<entities.length;i++){let e=entities[i];if(camera.project(e.x,e.y,0)){let sx=camera.projectX,sy=camera.projectY,ss=camera.projectScale;if(e.kind==2)ellipse(sx,sy,e.radius*ss*(1.0+e.z/ROOM_Z),e.radius*0.55*ss,0,0x55202028);}
  if(camera.project(e.x,e.y,e.z+e.height*0.5)){let ex=camera.projectX,ey=camera.projectY,sc=camera.projectScale;if(e.kind==1){ellipse(ex,ey,max(2,e.radius*sc),max(2,e.radius*0.75*sc),0,0xff4fca7e);line(ex,ey,ex,ey-e.height*sc,0xff559f6f,2);}else if(e.kind==2){ellipse(ex,ey,max(3,e.radius*sc),max(2,e.radius*0.55*sc),0,0xff2a1f35);}else{ellipse(ex,ey,max(3,e.radius*sc),max(2,e.radius*0.7*sc),0,0xff555555);}}
 }
 // Vision rays use body/world geometry, not screen-space shortcuts.
 if(showVision&&camera.project(body.x,body.y,body.z)){let ox=camera.projectX,oy=camera.projectY;for(let eye=0;eye<2;eye++)for(let j=0;j<8;j++){let aa=body.yaw+(eye==0?-0.7:0.7)+(j-3.5)*0.13,tx=body.x+Math.cos(aa)*130,ty=body.y+Math.sin(aa)*130,tz=body.z+Math.sin((j-3.5)*0.08)*35;if(camera.project(tx,ty,tz))line(ox,oy,camera.projectX,camera.projectY,0xff66745f,1);}}
 // Shadow on current support plane and fly magnified only for observation (physics radius remains real-scale).
 let support=supportHeightAt(body.x,body.y,body.z);if(camera.project(body.x,body.y,support)){let sx=camera.projectX,sy=camera.projectY,sc=camera.projectScale*(1.0-clamp((body.z-support)/250.0,0,0.75));ellipse(sx,sy,9*sc,4.8*sc,body.yaw-camera.yaw,0x66111511);}
 if(camera.project(body.x,body.y,body.z)){let fx=camera.projectX,fy=camera.projectY,fs=max(0.60,camera.projectScale*1.65);flyDraw(fx,fy,fs,body.yaw-camera.yaw);}
 // Benchmark shadow exists only as a visual stimulus.
 if(diagnostics.benchmarkActive){let bx=body.x+Math.cos(body.yaw)*85,by=body.y+Math.sin(body.yaw)*85;if(camera.project(bx,by,support)){ellipse(camera.projectX,camera.projectY,diagnostics.benchmarkShadowRadius*camera.projectScale,diagnostics.benchmarkShadowRadius*camera.projectScale,0,0x99111122);}}
 rect(AX+12,AY+12,420,28,0xff30372a);label(sceneName+" | 3-room apartment",AX+22,AY+17,13,TEXT,400);
 // Observation inset is deliberately magnified; it does not alter body physics.
 rect(AX+AW-152,AY+AH-136,140,124,0xffc5ccbb);flyDraw(AX+AW-84,AY+AH-69,2.05,heading);label("BODY DETAIL x~3",AX+AW-143,AY+AH-32,10,0xff454c3a,135);
}
function bar(y:i32,s:string,v:f64,c:u32=ACCENT):void{label(s,982,y,12,MUTED,260);rect(982,y+20,260,5,LINE);rect(982,y+20,<i32>(260*clamp(v,0,1)),5,c);}
function drawUI():void{pixels.fill(BG);label("זבוב",20,15,32,ACCENT,120);label("FLY / EMBODIED AUTONOMY 3.0",132,22,20,TEXT,560);label("world -> sensors -> mapped connectome -> VNC -> biomechanics",133,49,12,MUTED,650);
 button(20,86,110,"LOAD BRAIN");button(135,86,105,"BACKGROUND");button(245,86,100,"+ OBJECT");button(350,86,105,"BENCH LOOM");button(460,86,75,running?"PAUSE":"RUN",running);button(540,86,65,"RESET");button(610,86,65,"SCENE");button(680,86,65,"TRAIL",showTrail);button(750,86,65,"VISION",showVision);button(820,86,75,"EXPORT");button(900,86,95,"SYNTHETIC");button(1000,86,90,"CLEAR OBJ");button(1095,86,165,"CANCEL LOAD");drawArena();rect(970,134,290,586,PANEL);
 let b=brain!;label(b.flags==0?"SYNTHETIC CIRCUIT":"EXTERNAL CONNECTOME",982,149,14,b.flags==0?AMBER:ACCENT,268);label(b.n.toString()+" neurons",982,181,25,TEXT,266);label(b.e.toString()+" weighted edges",982,216,13,MUTED,266);label("Mappings: "+b.m.toString()+" / LIF / 1 ms",982,238,12,MUTED,266);label("STRICT MAP-ONLY ACTUATION / no world steering",982,259,11,ACCENT,266);
bar(284,"OPTIC LOBES L/R (Hz)", (diagnostics.rateOpticL + diagnostics.rateOpticR) / 50.0, 0xff55aaff);
 bar(314,"MAPPED MOTOR OUTPUT (Hz)", diagnostics.rateDN / 30.0, diagnostics.rateDN > 12.0 ? 0xffff4444 : ACCENT);
 bar(344,"E/I BALANCE: " + diagnostics.eiState, cf(diagnostics.rateCentral / 40.0, 0.0, 1.0), diagnostics.eiState.startsWith("HOMEO") ? 0xff44ff88 : 0xffffaa00);
 bar(374,"AERO LIFT FORCE (m*g)", cf(<f32>(body.liftForce / (body.mass * 9.81)), 0.0, 2.0) * 0.5, body.liftForce > (body.mass * 9.81) ? 0xff44ff88 : AMBER);
 bar(404,"WING CAMPANIFORM LOAD", body.campaniformSensillaWing, body.campaniformSensillaWing > 0.5 ? 0xffff4444 : ACCENT);

 // 5.2 Benchmark Diagnostic readout
 rect(982, 434, 260, 48, 0xff181410);
 rect(982, 434, 260, 1, LINE);
 label("LOOMING BENCHMARK:", 988, 438, 10, MUTED, 240);
 label(diagnostics.benchmarkResult, 988, 452, 11, diagnostics.benchmarkPassed ? 0xff44ff88 : (diagnostics.benchmarkActive ? 0xffffcc00 : TEXT), 250);
 label("Apartment: Z=" + fixed(body.z*WORLD_M_PER_UNIT, 2) + "m | V=" + fixed(speed, 1) + "mm/s | odor="+fixed(smellMean,2), 982, 488, 11, ACCENT, 264);
 button(982,510,120,soundEnabled?"SOUND ON":"SOUND OFF",soundEnabled);button(1110,510,132,"LISTEN WAV");
 button(982,550,80,"0.25x",timeScale==0.25);button(1070,550,78,"1x",timeScale==1);button(1156,550,86,"4x",timeScale==4);
 label("Simulated: "+fixed(simMs/1000)+" s",982,594,15,TEXT,260);label("Real-time factor: "+fixed(wallRatio)+"x",982,618,13,MUTED,260);label("Mean rate: "+fixed(rateHz)+" Hz/neuron",982,641,13,MUTED,266);label("WASM frame: "+fixed(frameMs,1)+" ms",982,664,12,MUTED,260);label("Memory: "+fixed(<f64>memory.size()/16,1)+" MiB",982,685,12,MUTED,260);
 rect(20,733,930,40,PANEL);for(let i=0;i<239;i++){let a=history[(historyAt+i)%240],h=<i32>min(32.0,Math.log(1+a)*5);rect(24+i*3,767-h,2,h,ACCENT);}label("N: NEURONS / SPIKES",753,744,11,MUTED,192);label(status,20,777,11,AMBER,1240);
 if(loader!=null){let l=loader!,pr=l.phase<=1?<f64>l.offset/max(1,l.total):l.phase==2?<f64>l.checked/max(1,l.total):1;rect(250,350,480,94,PANEL);label("LOADING / VALIDATING phase "+l.phase.toString(),271,365,15,TEXT,440);rect(272,402,430,7,LINE);rect(272,402,<i32>(430*pr),7,ACCENT);}else if(analysisActive){rect(250,350,480,80,PANEL);label("ANALYZING WAV "+fixed(100.0*analysisAt/max(1,analysisFrames),0)+"%",270,376,17,TEXT,440);}}
function exportTelemetry():void{
 let b=brain!,j="{\"app\":\"wasmos.fly\",\"version\":\"3.0.0\",\"scientific_status\":\"experimental_embodied_model\",\"control_mode\":\"strict_map_only_connectome_to_vnc\",\"direct_sensor_actuation\":false,\"hash_anatomy\":false,\"sensor_contract\":\"FLYBRAIN/1+ odor65-68\",\"graph_kind\":\""+(b.flags==0?"synthetic":"external_user_supplied")+"\",\"neurons\":"+b.n.toString()+",\"edges\":"+b.e.toString()+",\"sim_ms\":"+simMs.toString()+",\"mean_hz\":"+rateHz.toString()+",\"x\":"+body.x.toString()+",\"y\":"+body.y.toString()+",\"z\":"+body.z.toString()+",\"yaw\":"+body.yaw.toString()+",\"pitch\":"+body.pitch.toString()+",\"roll\":"+body.roll.toString()+",\"speed_mm_s\":"+speed.toString()+",\"energy\":"+energy.toString()+",\"odor_left\":"+smellL.toString()+",\"odor_right\":"+smellR.toString()+",\"olfaction_mapped\":"+(semanticOverlay.hasOlfaction?"true":"false")+",\"neural_forward\":"+neuralForward.toString()+",\"neural_yaw\":"+neuralYaw.toString()+",\"neural_flight\":"+neuralFlight.toString()+",\"neural_burst\":"+neuralBurst.toString()+",\"motor\":[";
 for(let k=1;k<7;k++){if(k>1)j+=",";j+=motor[k].toString();}j+="],\"trajectory\":[";let start=(trailAt-trailCount+1200)%1200;for(let k=0;k<trailCount;k++){if(k)j+=",";let t=(start+k)%1200;j+="["+trailX[t].toString()+","+trailY[t].toString()+","+trailZ[t].toString()+"]";}j+="]}";
 let bytes=utf(j),name=utf("fly_telemetry_v3.json");notify(download(changetype<usize>(bytes),bytes.byteLength,changetype<usize>(name),name.byteLength)>0?"Telemetry exported.":"Host refused download.");
}
function exportNeurons():void{let b=brain!,rows=new Array<string>();rows.push("root_id,voltage,rate_hz,outgoing_edges");for(let i=0;i<b.n;i++){let id=load<u64>(b.blob.dataStart+b.ids+i*8);rows.push(id.toString()+","+b.v[i].toString()+","+b.rates[i].toString()+","+(b.row(i+1)-b.row(i)).toString());}let bytes=utf(rows.join("\n")),name=utf("fly_neuron_activity.csv");notify(download(changetype<usize>(bytes),bytes.byteLength,changetype<usize>(name),name.byteLength)>0?"Neuron activity exported.":"Host refused download.");}
export function appInit(w:i32,h:i32,dpr:f64):void{}
export function appStart():void{
 if(started)return;started=true;crcInit();brain=new Brain(synthetic());makeScene(0);resetWorld();lastWall=now_ms();
 let t=utf("זבוב — Embodied Autonomy 3.0");set_title(changetype<usize>(t),t.byteLength);
 let m=utf('{"schema":"wasmos.app/1","id":"wasmos.fly","name":"זבוב","version":"3.0.0","kind":"application","role":"Strict connectome-driven embodied fly in a volumetric apartment","summary":"Mapped FLYBRAIN sensory current -> whole-brain LIF -> mapped descending output -> VNC CPG/flight biomechanics; world interactions are sensory or passive physics only","provides":{"atoms":["simulation.connectome.lif","simulation.fly.closed_loop","simulation.fly.vnc_cpg","simulation.fly.aerodynamics","simulation.fly.olfaction","simulation.apartment.3d","stimulus.image","stimulus.wav"],"services":[]},"requires":{"services":[]},"ui":{"headless":false,"settings":true},"limitations":["Experimental embodied model, not biological validation","Exact olfactory influence requires the FLYBRAIN file to map channels 65-68 to annotated olfactory neurons","The renderer magnifies the fly for observation while collision/force parameters remain Drosophila-scale"]}');
 manifest_set(changetype<usize>(m),m.byteLength);
 notify("Embodied Autonomy 3.0 ready. Load the 139k FLYBRAIN graph; only explicit graph mappings can actuate the body. Odor uses channels 65-68 when mapped.");
}
export function renderFrame():i32{if(!started)appStart();for(let r=retired.length-1;r>=0;r--){let old=retired[r];if(read_status(old.request)!=0){old.close();retired.splice(r,1);}}
 let begin=now_ms(),elapsed=clamp(begin-lastWall,0,250);lastWall=begin;if(loader!=null){loader!.pump();if(loader!.phase==9||loader!.phase<0){loader!.close();loader=null;}}if(pendingImage>=0&&begin-imageStarted>30000){image_release(pendingImage);pendingImage=-1;notify("Image decode timed out.");}
 pumpAudio();if(running&&visible)debt=min(250.0,debt+elapsed*timeScale);simulate(now_ms()+13);let span=begin-lastRateWall;if(span>=500){let ds=simMs-lastRateSim;rateHz=ds>0?<f64>windowSpikes*1000/(brain!.n*ds):0;wallRatio=ds/span;windowSpikes=0;lastRateSim=simMs;lastRateWall=begin;}drawUI();frameMs=now_ms()-begin;return <i32>pixels.dataStart;}
export function getWidth():i32{return W;}
export function getHeight():i32{return H;}
let dragStartX: i32 = 0;
let dragStartY: i32 = 0;
let totalDragDist: f64 = 0.0;

export function mouseMove(x:i32, y:i32, buttons:i32, mods:i32):void{
 mouseX = x - AX;
 mouseY = y - AY;
 mouseActive = mouseX >= 0 && mouseX < AW && mouseY >= 0 && mouseY < AH;

 // Rotate 3D Orbit Camera when mouse is dragged in arena
 if (camera.isDragging) {
   let dx = x - camera.lastMouseX;
   let dy = y - camera.lastMouseY;
   totalDragDist += Math.sqrt(<f64>(dx * dx + dy * dy));

   camera.yaw += <f64>dx * 0.008;
   camera.pitch = clamp(camera.pitch + <f64>dy * 0.008, 0.1, 1.45);
   camera.lastMouseX = x;
   camera.lastMouseY = y;
 }
}

export function mouseDown(buttonId:i32, x:i32, y:i32, mods:i32):void{
 // Right-click (2) or Left-click (0) inside arena initiates camera tracking
 if (x >= AX && x < AX + AW && y >= AY && y < AY + AH) {
   camera.isDragging = true;
   camera.lastMouseX = x;
   camera.lastMouseY = y;
   dragStartX = x;
   dragStartY = y;
   totalDragDist = 0.0;
   if (buttonId != 0) return;
 }

 if (buttonId != 0) return;

 if(neuronView && x >= AX + 24 && x < AX + 888 && y >= AY + 80 && y < AY + 512){
   selectedNeuron = min(brain!.n - 1, neuronPage * 4608 + (y - AY - 80) / 9 * 96 + (x - AX - 24) / 9);
   return;
 }
 if(y >= 733 && y < 773 && x >= 753 && x < 950){
   neuronView = !neuronView;
   return;
 }

 if(y >= 86 && y < 120){
   if(x >= 20 && x < 135) choose(1);
   else if(x >= 135 && x < 245) choose(2);
   else if(x >= 245 && x < 350) {
     // 4.3: Spawn 3D Volumetric Entities (Light Beacon, Diving Predator, Pillar)
     let k = (entities.length % 3) + 1;
     let ox = 150.0 + random01() * <f64>(AW - 300);
     let oy = 100.0 + random01() * <f64>(AH - 200);
     if (k == 1) {
       entities.push(new WorldEntity3D(ox, oy, supportHeightAt(ox,oy,ROOM_Z), 1, 10.0, 22.0, 1.0));
       notify("Spawned odor/light nutrient source; it affects sensors only.");
     } else if (k == 2) {
       entities.push(new WorldEntity3D(ox, oy, ROOM_Z-80.0, 2, 18.0, 16.0, 1.0));
       notify("Spawned independent aerial predator; no direct escape motor path exists.");
     } else {
       entities.push(new WorldEntity3D(ox, oy, 0.0, 3, 14.0, 120.0, 1.0));
       notify("Spawned 3D Vertical Obstacle Pillar.");
     }
   }
   else if(x >= 350 && x < 455) {
     diagnostics.startLoomingBenchmark(now_ms());
   }
   else if(x >= 460 && x < 535) { running = !running; debt = 0; }
   else if(x >= 540 && x < 605) { resetWorld(); notify("Reset with fixed seed; graph and scene preserved."); }
   else if(x >= 610 && x < 675) makeScene((scenePreset + 1) % 4);
   else if(x >= 680 && x < 745) showTrail = !showTrail;
   else if(x >= 750 && x < 815) showVision = !showVision;
   else if(x >= 820 && x < 895) exportTelemetry();
   else if(x >= 900 && x < 995) { brain = new Brain(synthetic()); resetWorld(); neuronPage = 0; selectedNeuron = 0; notify("Synthetic 4096-neuron circuit."); }
   else if(x >= 1000 && x < 1090) { entities.length = 0; notify("Cleared all spatial entities."); }
   else if(x >= 1095) cancelLoad();
   return;
 }

 if(y >= 510 && y < 544){
   if(x >= 982 && x < 1102){
     if(soundReady) soundEnabled = !soundEnabled;
     else notify("Load a WAV first.");
   } else if(x >= 1110 && x < 1242){
     if(!soundReady){ notify("Load a WAV first."); return; }
     if(now_ms() < previewUntil){ notify("A speaker preview is already playing."); return; }
     let ok = audio_play(sound.dataStart, sound.byteLength, soundRate);
     if(ok > 0) previewUntil = now_ms() + <f64>sound.length * 1000 / soundRate;
     notify(ok > 0 ? "Speaker preview uses wall time; neural sound uses simulation time." : "Speaker playback failed; neural sound is still available.");
   }
   return;
 }

 if(y >= 550 && y < 584){
   if(x >= 982 && x < 1062) timeScale = 0.25;
   else if(x >= 1070 && x < 1148) timeScale = 1;
   else if(x >= 1156 && x < 1242) timeScale = 4;
   return;
 }
}

export function mouseUp(buttonId:i32, x:i32, y:i32, mods:i32):void{
 if (camera.isDragging) {
   camera.isDragging = false;
   // Stationary click without significant drag spawns 3D food beacon
   if (buttonId == 0 && totalDragDist < 6.0 && x >= AX && x < AX + AW && y >= AY && y < AY + AH) {
     let wx=clamp(<f64>(x-AX),20,AW-20),wy=clamp(<f64>(y-AY),20,AH-20);entities.push(new WorldEntity3D(wx,wy,supportHeightAt(wx,wy,ROOM_Z),1,10.0,22.0,1.0));
     notify("Placed nutrient odor/light source (screen-to-floor approximate placement).");
   }
 }
}
export function mouseWheel(deltaX:i32,deltaY:i32,mods:i32):void{camera.dist=clamp(camera.dist+<f64>deltaY*0.75,620.0,2100.0);}
export function keyDown(key:i32,mods:i32,repeat:i32):void{if(repeat)return;if((mods&2)!=0&&key==69){exportNeurons();return;}if(key==78){neuronView=!neuronView;return;}if(neuronView&&(key==37||key==39)){neuronPage=max(0,min((brain!.n-1)/4608,neuronPage+(key==39?1:-1)));selectedNeuron=neuronPage*4608;return;}
 if(key==32){running=!running;debt=0;}else if(key==82)resetWorld();else if(key==66)choose(1);else if(key==73)choose(2);else if(key==65)choose(3);else if(key==86)showVision=!showVision;else if(key==84)showTrail=!showTrail;else if(key==27)cancelLoad();else if(key==76){soundLoop=!soundLoop;notify(soundLoop?"Sound loops in simulation time.":"Sound plays once.");}else if(key==187||key==107){synGain=min(<f32>4,synGain*<f32>1.1);notify("Synapse gain: "+synGain.toString());}else if(key==189||key==109){synGain=max(<f32>0.01,synGain/<f32>1.1);notify("Synapse gain: "+synGain.toString());}}
export function keyUp(key:i32,mods:i32):void{}
export function focusChanged(f:i32):void{if(!f)mouseActive=false;}
export function visibilityChanged(v:i32):void{visible=v!=0;lastWall=now_ms();debt=0;}
export function appStop():void{cancelLoad();running=false;}
// Numeric inspection / deterministic verification ABI; no OS-specific app registration.
export function flySetGains(s:f32,i:f32,a:f32):i32{if(!isFinite(s)||!isFinite(i)||!isFinite(a))return 0;synGain=cf(s,0,4);inputGain=cf(i,0,8);audioGain=cf(a,0,8);return 1;}
export function flySetSeed(s:u32):void{seed=s==0?1:s;}
export function flyStep(ticks:i32):i32{if(!started)appStart();ticks=max(0,min(10000,ticks));for(let i=0;i<ticks;i++){let b=brain!;if(b.stage==0){updateSensors();b.begin();}while(!b.work()){}tickDone();}return ticks;}
export function flyMetric(k:i32):f64{if(brain==null)return 0;if(k==0)return brain!.n;if(k==1)return brain!.e;if(k==2)return simMs;if(k==3)return totalSpikes;if(k==4)return posX;if(k==5)return posY;if(k==6)return heading;if(k==7)return brain!.flags;if(k==8)return loader==null?-1:loader!.phase;if(k==9)return soundReady?1:0;if(k==10)return soundRms;if(k>=20&&k<27)return motor[k-20];if(k==30)return energy;if(k==31)return neuralForward;if(k==32)return neuralYaw;if(k==33)return neuralFlight;if(k==34)return neuralBurst;if(k==35)return speed;if(k==36)return altitude;if(k==37)return bodyMode;if(k==38)return directSensorActuation?1:0;if(k==39)return smellL;if(k==40)return smellR;if(k==41)return semanticOverlay.hasOlfaction?1:0;if(k==42)return body.z;if(k==43)return body.pitch;if(k==44)return body.roll;if(k==45)return body.wingFreq;return 0;}
export function flySensor(k:i32):f32{return k>=0&&k<CHANNELS?sensors[k]:0;}
export function flyReset():void{resetWorld();}
export function flySetScene(k:i32):void{makeScene(max(0,min(3,k)));}
let ingress=new Uint8Array(0);
export function flyIngress(n:i32):usize{if(n<0||n>MAX_BYTES||estimatedBytes(n)>720*1024*1024)return 0;ingress=new Uint8Array(n);return ingress.dataStart;}
export function flyLoadIngress():i32{if(loader!=null)return 0;let l=new Loader(-1,1);l.data=ingress;l.total=ingress.length;if(!l.header())return 0;l.phase=2;loader=l;return 1;}
export function flyValidatePump():i32{if(loader==null)return -1;loader!.pump();let p=loader!.phase;if(p<0||p==9){loader!.close();loader=null;ingress=new Uint8Array(0);}return p;}
export function flyWavIngress():i32{return decodeWav(ingress)?1:0;}
export function flyAudioPump():i32{pumpAudio();return analysisActive?0:1;}
export function flyPotential(i:i32):f32{return brain!=null&&i>=0&&i<brain!.n?brain!.v[i]:0;}
export function flySpikeRate(i:i32):f32{return brain!=null&&i>=0&&i<brain!.n?brain!.rates[i]:0;}
