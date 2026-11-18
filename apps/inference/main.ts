// @wasm-feature simd
// @wasm-opt speed
// Requires WASM SIMD128; V30.5 host auto-enables --enable simd.
// =============================================================================
// INFERENCE V2.5 // EXTREME SERVICE ENGINE + ADAPTIVE PREFILL + FUSED GREEDY HEAD
// WASM Architect Studio ABI 3.5
//
// Design goals:
// - GGUF metadata/tensor validation before READY state.
// - Correct token-driven autoregressive generation (never position-as-token).
// - Real per-layer RMSNorm weights, Q/K/V/O + FFN graph, GQA KV cache.
// - Dynamic activation/logit/KV buffers sized from loaded model metadata.
// - Q4_0/Q4_1/Q5_0/Q5_1/Q8_0/Q4_K/Q5_K/Q6_K/F16/F32/BF16 execution.
// - Llama Standard RoPE (adjacent-pair) + GGUF rope_freqs.weight factors.
// - Q4_K/Q6_K x Q8_K activation quantization with integer SIMD dot kernels.
// - Byte-level BPE (GPT2/Qwen2/Llama3 family) + SentencePiece unigram path.
// - Host Resource API range loader (no full duplicate JS HTTP buffer).
// - Full session log exported through host-managed chunked download stream.
// - Service Fabric 3.5 provider: JSON/NDJSON, priority queues, manifests, load routing.
// - Layer-synchronous fused-row micro-batched prefill (up to 4 tokens) + exact prefix KV/logit reuse.
// - Expanded GGUF quant compatibility: Q2_K/Q3_K/Q8_K scalar-safe fallback plus existing types.
//
// Supported architecture contract in this version: llama, qwen2, mistral.
// Unsupported architecture/rope mode/tensor type => hard compatibility error,
// never silent zero weights or fabricated output.
// =============================================================================

const WIDTH: i32 = 800;
const HEIGHT: i32 = 600;
export const pixels = new Uint32Array(WIDTH * HEIGHT);
export function getWidth(): i32 { return WIDTH; }
export function getHeight(): i32 { return HEIGHT; }

// -----------------------------------------------------------------------------
// UI palette
// -----------------------------------------------------------------------------
const C_BG: u32      = rgba(7, 9, 14);
const C_PANEL: u32   = rgba(14, 19, 29);
const C_PANEL2: u32  = rgba(18, 25, 38);
const C_BORDER: u32  = rgba(38, 50, 72);
const C_CYAN: u32    = rgba(0, 238, 255);
const C_GREEN: u32   = rgba(0, 255, 157);
const C_AMBER: u32   = rgba(255, 188, 32);
const C_ROSE: u32    = rgba(255, 76, 96);
const C_WHITE: u32   = rgba(235, 245, 255);
const C_MUTED: u32   = rgba(125, 143, 170);
const C_BLUE: u32    = rgba(100, 145, 255);

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------
@inline function minI(a:i32,b:i32):i32 { return a < b ? a : b; }
@inline function maxI(a:i32,b:i32):i32 { return a > b ? a : b; }
@inline function clampI(v:i32,lo:i32,hi:i32):i32 { return v < lo ? lo : (v > hi ? hi : v); }
@inline function clampF(v:f32,lo:f32,hi:f32):f32 { return v < lo ? lo : (v > hi ? hi : v); }
@inline function absF(v:f32):f32 { return v < 0.0 ? -v : v; }

function formatF(v:f64, chars:i32=7): string {
  let s=v.toString();
  return s.length > chars ? s.substr(0,chars) : s;
}
function formatBytes(n:f64): string {
  if (n >= 1073741824.0) return formatF(n/1073741824.0,6)+" GiB";
  if (n >= 1048576.0) return formatF(n/1048576.0,6)+" MiB";
  if (n >= 1024.0) return formatF(n/1024.0,6)+" KiB";
  return (<i64>n).toString()+" B";
}
function utf8String(ptr:usize, len:i32): string {
  if (len <= 0) return "";
  let b=new ArrayBuffer(len);
  memory.copy(changetype<usize>(b),ptr,<usize>len);
  return String.UTF8.decode(b);
}
function codePointString(cp:i32): string {
  if (cp <= 0xFFFF) return String.fromCharCode(cp);
  let x=cp-0x10000;
  return String.fromCharCode(0xD800+(x>>10))+String.fromCharCode(0xDC00+(x&0x3FF));
}
function hasNonAscii(text:string):bool { for(let i:i32=0;i<text.length;i++)if(text.charCodeAt(i)>126)return true; return false; }
function drawUnicode(text:string,x:i32,y:i32,maxW:i32,fontPx:i32,color:u32,flags:i32=18):i32 {
  if(text.length==0)return 0;let b=String.UTF8.encode(text);
  return host_unicode_text_draw(pixels.dataStart,WIDTH,HEIGHT,changetype<usize>(b),b.byteLength,x,y,maxW,fontPx,color,flags);
}

// =============================================================================
// FULL SESSION LOGGER - no fixed 256 KiB truncation
// =============================================================================
const logLines: string[] = new Array<string>(0);
let logByteEstimate:i64=0;
let logViewStart:i32=0;
let verboseTokenLog:bool=false;

function logSerial(msg:string):void {
  let stamp=formatF(now_ms()/1000.0,10);
  let line="["+stamp+"s] "+msg+"\n";
  logLines.push(line);
  let lb=String.UTF8.encode(line); logByteEstimate += <i64>lb.byteLength;
  let b=String.UTF8.encode(msg);
  log_utf8(changetype<usize>(b),b.byteLength);
}

export function exportLogFile():void {
  logSerial("Full log export requested; snapshot entries="+logLines.length.toString()+" bytes~"+logByteEstimate.toString());
  let n=String.UTF8.encode("inference_v2_session.log");
  let m=String.UTF8.encode("text/plain;charset=utf-8");
  let id=host_download_begin(changetype<usize>(n),n.byteLength,changetype<usize>(m),m.byteLength);
  if(id<0){ logSerial("ERROR: host download_begin rejected log export."); return; }
  for(let i:i32=0;i<logLines.length;i++){
    let b=String.UTF8.encode(unchecked(logLines[i]));
    let wrote=host_download_write(id,changetype<usize>(b),b.byteLength);
    if(wrote!=b.byteLength){ logSerial("ERROR: short host log write at line "+i.toString()); host_download_abort(id); return; }
  }
  host_download_end(id);
  logSerial("Full log export submitted to host stream id="+id.toString()+" bytes~"+logByteEstimate.toString());
}
export function downloadEvent(id:i32,state:i32,lo:i32,hi:i32):void {
  logSerial("Host download event id="+id.toString()+" state="+state.toString()+" bytesLo="+(<u32>lo).toString()+" bytesHi="+(<u32>hi).toString());
}

// =============================================================================
// GGUF / GGML FORMAT
// =============================================================================
const GGUF_MAGIC:u32=0x46554747;
const GGUF_TYPE_UINT8:i32=0;
const GGUF_TYPE_INT8:i32=1;
const GGUF_TYPE_UINT16:i32=2;
const GGUF_TYPE_INT16:i32=3;
const GGUF_TYPE_UINT32:i32=4;
const GGUF_TYPE_INT32:i32=5;
const GGUF_TYPE_FLOAT32:i32=6;
const GGUF_TYPE_BOOL:i32=7;
const GGUF_TYPE_STRING:i32=8;
const GGUF_TYPE_ARRAY:i32=9;
const GGUF_TYPE_UINT64:i32=10;
const GGUF_TYPE_INT64:i32=11;
const GGUF_TYPE_FLOAT64:i32=12;

// Current ggml_type numeric ABI. Do not confuse with GGML ftype values.
const GGML_F32:i32=0;
const GGML_F16:i32=1;
const GGML_Q4_0:i32=2;
const GGML_Q4_1:i32=3;
const GGML_Q5_0:i32=6;
const GGML_Q5_1:i32=7;
const GGML_Q8_0:i32=8;
const GGML_Q8_1:i32=9;
const GGML_Q2_K:i32=10;
const GGML_Q3_K:i32=11;
const GGML_Q4_K:i32=12;
const GGML_Q5_K:i32=13;
const GGML_Q6_K:i32=14;
const GGML_Q8_K:i32=15;
const GGML_BF16:i32=30;

function typeName(t:i32):string {
  if(t==GGML_F32)return"F32"; if(t==GGML_F16)return"F16"; if(t==GGML_BF16)return"BF16";
  if(t==GGML_Q4_0)return"Q4_0"; if(t==GGML_Q4_1)return"Q4_1"; if(t==GGML_Q5_0)return"Q5_0";
  if(t==GGML_Q5_1)return"Q5_1"; if(t==GGML_Q8_0)return"Q8_0"; if(t==GGML_Q2_K)return"Q2_K"; if(t==GGML_Q3_K)return"Q3_K";
  if(t==GGML_Q4_K)return"Q4_K"; if(t==GGML_Q5_K)return"Q5_K"; if(t==GGML_Q6_K)return"Q6_K"; if(t==GGML_Q8_K)return"Q8_K"; return"TYPE_"+t.toString();
}
function typeSupported(t:i32):bool {
  return t==GGML_F32||t==GGML_F16||t==GGML_BF16||t==GGML_Q4_0||t==GGML_Q4_1||t==GGML_Q5_0||t==GGML_Q5_1||t==GGML_Q8_0||t==GGML_Q2_K||t==GGML_Q3_K||t==GGML_Q4_K||t==GGML_Q5_K||t==GGML_Q6_K||t==GGML_Q8_K;
}
function tensorBytesForElements(t:i32,n:i64):i64 {
  if(n<0)return-1;
  if(t==GGML_F32)return n*4;
  if(t==GGML_F16||t==GGML_BF16)return n*2;
  if(t==GGML_Q4_0){if(n%32!=0)return-1;return(n/32)*18;}
  if(t==GGML_Q4_1){if(n%32!=0)return-1;return(n/32)*20;}
  if(t==GGML_Q5_0){if(n%32!=0)return-1;return(n/32)*22;}
  if(t==GGML_Q5_1){if(n%32!=0)return-1;return(n/32)*24;}
  if(t==GGML_Q8_0){if(n%32!=0)return-1;return(n/32)*34;}
  if(t==GGML_Q2_K){if(n%256!=0)return-1;return(n/256)*84;}
  if(t==GGML_Q3_K){if(n%256!=0)return-1;return(n/256)*110;}
  if(t==GGML_Q4_K){if(n%256!=0)return-1;return(n/256)*144;}
  if(t==GGML_Q5_K){if(n%256!=0)return-1;return(n/256)*176;}
  if(t==GGML_Q6_K){if(n%256!=0)return-1;return(n/256)*210;}
  if(t==GGML_Q8_K){if(n%256!=0)return-1;return(n/256)*292;}
  return -1;
}

class BinaryReader {
  base:usize=0;
  cursor:usize=0;
  end:usize=0;
  ok:bool=true;
  init(ptr:usize,len:usize):void { this.base=ptr;this.cursor=ptr;this.end=ptr+len;this.ok=true; }
  get offset():usize{return this.cursor-this.base;}
  need(n:usize):bool { if(!this.ok||this.cursor+n>this.end){this.ok=false;return false;}return true; }
  skip(n:usize):void { if(this.need(n))this.cursor+=n; }
  readU8():u8 { if(!this.need(1))return 0;let v=load<u8>(this.cursor);this.cursor++;return v; }
  readU16():u16 { if(!this.need(2))return 0;let v=load<u16>(this.cursor);this.cursor+=2;return v; }
  readU32():u32 { if(!this.need(4))return 0;let v=load<u32>(this.cursor);this.cursor+=4;return v; }
  readI32():i32 { if(!this.need(4))return 0;let v=load<i32>(this.cursor);this.cursor+=4;return v; }
  readU64():u64 { if(!this.need(8))return 0;let v=load<u64>(this.cursor);this.cursor+=8;return v; }
  readF32():f32 { if(!this.need(4))return 0;let v=load<f32>(this.cursor);this.cursor+=4;return v; }
  readF64():f64 { if(!this.need(8))return 0;let v=load<f64>(this.cursor);this.cursor+=8;return v; }
  readString():string {
    let n64=this.readU64(); if(!this.ok)return"";
    if(n64><u64>16777216){this.ok=false;return"";}
    let n=<usize>n64; if(!this.need(n))return"";
    if(n==0)return"";
    let b=new ArrayBuffer(<i32>n);memory.copy(changetype<usize>(b),this.cursor,n);this.cursor+=n;
    return String.UTF8.decode(b);
  }
}
const reader=new BinaryReader();

class TensorDesc {
  name:string="";
  nDims:i32=0;
  ne0:i64=1;ne1:i64=1;ne2:i64=1;ne3:i64=1;
  type:i32=0;
  offset:u64=0;
  ptr:usize=0;
  bytes:i64=0;
  elements():i64{return this.ne0*this.ne1*this.ne2*this.ne3;}
}

class ModelConfig {
  architecture:string="unknown";
  modelName:string="";
  tokenizerModel:string="unknown";
  tokenizerPre:string="";
  chatTemplate:string="";
  dim:i32=0;
  hiddenDim:i32=0;
  nLayers:i32=0;
  nHeads:i32=0;
  nKvHeads:i32=0;
  headDim:i32=0;
  vocabSize:i32=0;
  modelContext:i32=0;
  activeContext:i32=2048;
  slidingWindow:i32=0;
  normEps:f32=0.00001;
  ropeTheta:f32=10000.0;
  ropeScalingType:string="none";
  ropeScalingFactor:f32=1.0;
  alignment:i32=32;
  bos:i32=1;
  eos:i32=2;
  unk:i32=0;
  pad:i32=-1;
  addBos:bool=false;
  addEos:bool=false;
  reset():void {
    this.architecture="unknown";this.modelName="";this.tokenizerModel="unknown";this.tokenizerPre="";this.chatTemplate="";
    this.dim=0;this.hiddenDim=0;this.nLayers=0;this.nHeads=0;this.nKvHeads=0;this.headDim=0;this.vocabSize=0;this.modelContext=0;
    this.activeContext=2048;this.slidingWindow=0;this.normEps=0.00001;this.ropeTheta=10000.0;this.ropeScalingType="none";this.ropeScalingFactor=1.0;
    this.alignment=32;this.bos=1;this.eos=2;this.unk=0;this.pad=-1;this.addBos=false;this.addEos=false;
  }
}
const cfg=new ModelConfig();
const tensors:TensorDesc[]=new Array<TensorDesc>(0);
const tensorMap=new Map<string,TensorDesc>();
const vocabTokens:string[]=new Array<string>(0);
let vocabScores:Float32Array=new Float32Array(0);
let vocabTypes:Int32Array=new Int32Array(0);
const bpeMerges:string[]=new Array<string>(0);

class GGUFModel {
  version:u32=0;tensorCount:u64=0;kvCount:u64=0;dataOffset:usize=0;loaded:bool=false;validationError:string="";unsupportedTypes:i32=0;
  reset():void {this.version=0;this.tensorCount=0;this.kvCount=0;this.dataOffset=0;this.loaded=false;this.validationError="";this.unsupportedTypes=0;tensors.length=0;tensorMap.clear();vocabTokens.length=0;bpeMerges.length=0;vocabScores=new Float32Array(0);vocabTypes=new Int32Array(0);cfg.reset();}

  parse(ptr:usize,len:usize):bool {
    this.reset(); if(len<24){this.validationError="GGUF too small";return false;}
    reader.init(ptr,len);
    if(reader.readU32()!=GGUF_MAGIC){this.validationError="GGUF magic mismatch";return false;}
    this.version=reader.readU32(); this.tensorCount=reader.readU64(); this.kvCount=reader.readU64();
    if(this.version<2||this.version>3){this.validationError="Unsupported GGUF version "+this.version.toString();return false;}
    if(this.tensorCount==0||this.tensorCount><u64>100000){this.validationError="Invalid tensor count";return false;}
    if(this.kvCount><u64>1000000){this.validationError="Invalid metadata count";return false;}
    logSerial("GGUF header v"+this.version.toString()+" kv="+this.kvCount.toString()+" tensors="+this.tensorCount.toString());
    for(let i:u64=0;i<this.kvCount;i++){
      let key=reader.readString();let typ=reader.readI32();if(!reader.ok){this.validationError="Metadata truncation at KV "+i.toString();return false;}
      this.consumeMeta(key,typ);
      if(!reader.ok){this.validationError="Invalid metadata value for "+key;return false;}
    }
    let count=<i32>this.tensorCount;
    for(let i:i32=0;i<count;i++){
      let t=new TensorDesc();t.name=reader.readString();t.nDims=reader.readI32();
      if(t.nDims<1||t.nDims>4){this.validationError="Invalid tensor dimensions for "+t.name;return false;}
      if(t.nDims>=1)t.ne0=<i64>reader.readU64();if(t.nDims>=2)t.ne1=<i64>reader.readU64();if(t.nDims>=3)t.ne2=<i64>reader.readU64();if(t.nDims>=4)t.ne3=<i64>reader.readU64();
      t.type=reader.readI32();t.offset=reader.readU64();if(!reader.ok){this.validationError="Tensor table truncated";return false;}
      t.bytes=tensorBytesForElements(t.type,t.elements());if(t.bytes<0){this.unsupportedTypes++;}
      tensors.push(t);tensorMap.set(t.name,t);
    }
    let off=reader.offset;let align=<usize>maxI(1,cfg.alignment);let rem=off%align;this.dataOffset=rem==0?off:off+(align-rem);
    if(this.dataOffset>=len){this.validationError="GGUF data section outside file";return false;}
    for(let i:i32=0;i<tensors.length;i++){
      let t=unchecked(tensors[i]);t.ptr=ptr+this.dataOffset+<usize>t.offset;
      if(t.bytes><i64>0){let end=<u64>this.dataOffset+t.offset+<u64>t.bytes;if(end><u64>len){this.validationError="Tensor outside file: "+t.name;return false;}}
    }
    cfg.vocabSize=vocabTokens.length;
    if(cfg.nHeads>0&&cfg.dim>0)cfg.headDim=cfg.dim/cfg.nHeads;
    if(!this.validateConfig())return false;
    if(!compileGraph())return false;
    this.loaded=true;
    logSerial("GGUF validated: arch="+cfg.architecture+" name="+cfg.modelName+" dim="+cfg.dim.toString()+" layers="+cfg.nLayers.toString()+" heads="+cfg.nHeads.toString()+" kvHeads="+cfg.nKvHeads.toString()+" vocab="+cfg.vocabSize.toString());
    return true;
  }

  consumeMeta(key:string,typ:i32):void {
    if(typ==GGUF_TYPE_STRING){let s=reader.readString();
      if(key=="general.architecture")cfg.architecture=s;
      else if(key=="general.name")cfg.modelName=s;
      else if(key=="tokenizer.ggml.model")cfg.tokenizerModel=s;
      else if(key=="tokenizer.ggml.pre")cfg.tokenizerPre=s;
      else if(key=="tokenizer.chat_template")cfg.chatTemplate=s;
      else if(key.endsWith(".rope.scaling.type"))cfg.ropeScalingType=s;
      return;
    }
    if(typ==GGUF_TYPE_UINT32||typ==GGUF_TYPE_INT32){let v=reader.readI32();
      if(key=="general.alignment")cfg.alignment=v;
      else if(key.endsWith(".context_length"))cfg.modelContext=v;
      else if(key.endsWith(".embedding_length"))cfg.dim=v;
      else if(key.endsWith(".feed_forward_length"))cfg.hiddenDim=v;
      else if(key.endsWith(".block_count"))cfg.nLayers=v;
      else if(key.endsWith(".attention.head_count"))cfg.nHeads=v;
      else if(key.endsWith(".attention.head_count_kv"))cfg.nKvHeads=v;
      else if(key.endsWith(".attention.sliding_window"))cfg.slidingWindow=v;
      else if(key=="tokenizer.ggml.bos_token_id")cfg.bos=v;
      else if(key=="tokenizer.ggml.eos_token_id")cfg.eos=v;
      else if(key=="tokenizer.ggml.unknown_token_id")cfg.unk=v;
      else if(key=="tokenizer.ggml.padding_token_id")cfg.pad=v;
      return;
    }
    if(typ==GGUF_TYPE_FLOAT32){let v=reader.readF32();
      if(key.endsWith(".attention.layer_norm_rms_epsilon"))cfg.normEps=v;
      else if(key.endsWith(".rope.freq_base"))cfg.ropeTheta=v;
      else if(key.endsWith(".rope.scaling.factor"))cfg.ropeScalingFactor=v;
      return;
    }
    if(typ==GGUF_TYPE_BOOL||typ==GGUF_TYPE_UINT8||typ==GGUF_TYPE_INT8){let v=reader.readU8();
      if(key=="tokenizer.ggml.add_bos_token")cfg.addBos=v!=0;
      else if(key=="tokenizer.ggml.add_eos_token")cfg.addEos=v!=0;
      return;
    }
    if(typ==GGUF_TYPE_UINT16||typ==GGUF_TYPE_INT16){reader.readU16();return;}
    if(typ==GGUF_TYPE_UINT64||typ==GGUF_TYPE_INT64){reader.readU64();return;}
    if(typ==GGUF_TYPE_FLOAT64){reader.readF64();return;}
    if(typ==GGUF_TYPE_ARRAY){this.consumeArray(key);return;}
    reader.ok=false;
  }

  consumeArray(key:string):void {
    let itemType=reader.readI32();let n64=reader.readU64();if(n64><u64>10000000){reader.ok=false;return;}let n=<i32>n64;
    if(itemType==GGUF_TYPE_STRING){
      let isTok=key=="tokenizer.ggml.tokens";let isMerge=key=="tokenizer.ggml.merges";
      if(isTok)vocabTokens.length=0;if(isMerge)bpeMerges.length=0;
      for(let i:i32=0;i<n;i++){let x=reader.readString();if(isTok)vocabTokens.push(x);else if(isMerge)bpeMerges.push(x);}
      return;
    }
    if(itemType==GGUF_TYPE_FLOAT32){
      if(key=="tokenizer.ggml.scores"){vocabScores=new Float32Array(n);for(let i:i32=0;i<n;i++)unchecked(vocabScores[i]=reader.readF32());}
      else reader.skip(<usize>n*4);return;
    }
    if(itemType==GGUF_TYPE_INT32||itemType==GGUF_TYPE_UINT32){
      if(key=="tokenizer.ggml.token_type"){vocabTypes=new Int32Array(n);for(let i:i32=0;i<n;i++)unchecked(vocabTypes[i]=reader.readI32());}
      else reader.skip(<usize>n*4);return;
    }
    let size:i32=1;if(itemType==GGUF_TYPE_UINT16||itemType==GGUF_TYPE_INT16)size=2;else if(itemType==GGUF_TYPE_UINT64||itemType==GGUF_TYPE_INT64||itemType==GGUF_TYPE_FLOAT64)size=8;
    reader.skip(<usize>n*<usize>size);
  }

  validateConfig():bool {
    if(cfg.architecture!="llama"&&cfg.architecture!="qwen2"&&cfg.architecture!="mistral"){
      this.validationError="Architecture not implemented safely: "+cfg.architecture;return false;
    }
    if(cfg.dim<=0||cfg.hiddenDim<=0||cfg.nLayers<=0||cfg.nHeads<=0||cfg.nKvHeads<=0||cfg.headDim<=0||cfg.dim%cfg.nHeads!=0){this.validationError="Invalid transformer dimensions";return false;}
    if(cfg.nHeads%cfg.nKvHeads!=0){this.validationError="GQA ratio is not integral";return false;}
    if(cfg.vocabSize<=0){this.validationError="Tokenizer vocabulary missing";return false;}
    if(cfg.modelContext<=0)cfg.modelContext=2048;
    if(cfg.ropeScalingType!="none"&&cfg.ropeScalingType!=""&&cfg.ropeScalingType!="linear"){
      this.validationError="RoPE scaling mode not implemented safely: "+cfg.ropeScalingType;return false;
    }
    cfg.activeContext=minI(cfg.modelContext,2048);
    if(cfg.activeContext<128)cfg.activeContext=cfg.modelContext;
    if(this.unsupportedTypes>0){
      for(let i:i32=0;i<tensors.length;i++){let t=unchecked(tensors[i]);if(!typeSupported(t.type)){this.validationError="Unsupported quant tensor "+t.name+" type="+typeName(t.type);return false;}}
    }
    return true;
  }
}
const model=new GGUFModel();

// =============================================================================
// MODEL RESOURCE LOADER // ABI 3.0 Large Resource I/O
// =============================================================================
const LOAD_IDLE:i32=0, LOAD_OPENING:i32=1, LOAD_READING:i32=2, LOAD_PARSING:i32=3, LOAD_READY:i32=4, LOAD_ERROR:i32=-1;
let loadState:i32=LOAD_IDLE;
let modelResource:i32=-1;
let modelResourceSize:i32=0;
let modelLoadedBytes:i32=0;
let modelReadRequest:i32=-1;
let modelBytes:Uint8Array=new Uint8Array(0);
let loadMessage:string="NO MODEL";
const MODEL_CHUNK:i32=8*1024*1024;
const DEFAULT_QWEN_URL:string="https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_0.gguf";

function beginPickModel():void {
  if(loadState==LOAD_READING||loadState==LOAD_PARSING)return;
  let a=String.UTF8.encode(".gguf,application/octet-stream");
  modelResource=host_resource_pick_file(changetype<usize>(a),a.byteLength);
  loadState=LOAD_OPENING;loadMessage="WAITING FOR GGUF FILE PICKER";logSerial("Resource picker opened handle="+modelResource.toString());
}
function beginUrlModel(url:string):void {
  if(loadState==LOAD_READING||loadState==LOAD_PARSING)return;
  let b=String.UTF8.encode(url);modelResource=host_resource_open_url(changetype<usize>(b),b.byteLength);loadState=LOAD_OPENING;loadMessage="OPENING URL RESOURCE";logSerial("Opening model URL resource handle="+modelResource.toString()+" url="+url);
}

export function resourceOpened(handle:i32,state:i32,sizeLo:i32,sizeHi:i32):void {
  if(handle!=modelResource)return;
  if(state!=1){loadState=LOAD_ERROR;loadMessage="RESOURCE OPEN FAILED";logSerial("ERROR: model resource open state="+state.toString());return;}
  let hi=<u32>sizeHi,lo=<u32>sizeLo;
  if(hi!=<u32>0||lo><u32>0x7FFFFFFF){loadState=LOAD_ERROR;loadMessage="MODEL >2GiB NOT SUPPORTED BY WASM32 CONTIGUOUS MODE";logSerial("ERROR: resource exceeds contiguous wasm32 model limit hi="+hi.toString()+" lo="+lo.toString());return;}
  modelResourceSize=<i32>lo;
  if(modelResourceSize<24){loadState=LOAD_ERROR;loadMessage="RESOURCE SIZE INVALID";return;}
  logSerial("Model resource ready size="+formatBytes(<f64>modelResourceSize)+". Allocating WASM model storage...");
  modelBytes=new Uint8Array(modelResourceSize);modelLoadedBytes=0;loadState=LOAD_READING;requestNextModelChunk();
}
function requestNextModelChunk():void {
  if(loadState!=LOAD_READING)return;
  if(modelLoadedBytes>=modelResourceSize){finishModelLoad();return;}
  let n=minI(MODEL_CHUNK,modelResourceSize-modelLoadedBytes);
  let ptr=modelBytes.dataStart+<usize>modelLoadedBytes;
  modelReadRequest=host_resource_read_range(modelResource,<u32>modelLoadedBytes,0,ptr,n);
  if(modelReadRequest<0){loadState=LOAD_ERROR;loadMessage="RESOURCE READ REQUEST FAILED";logSerial("ERROR: resource_read_range rejected at offset="+modelLoadedBytes.toString());}
}
export function resourceReadDone(requestId:i32,handle:i32,bytes:i32,status:i32):void {
  if(handle!=modelResource||requestId!=modelReadRequest)return;
  host_resource_request_release(requestId);
  if(status!=1||bytes<=0){loadState=LOAD_ERROR;loadMessage="RESOURCE READ FAILED";logSerial("ERROR: model read id="+requestId.toString()+" status="+status.toString()+" bytes="+bytes.toString());return;}
  modelLoadedBytes+=bytes;
  if((modelLoadedBytes%(64*1024*1024))<MODEL_CHUNK||modelLoadedBytes>=modelResourceSize)logSerial("Model load progress "+formatF(100.0*<f64>modelLoadedBytes/<f64>modelResourceSize,5)+"% ("+formatBytes(<f64>modelLoadedBytes)+")");
  requestNextModelChunk();
}
function logMathProfile():void {
  let q4:i32=0,q6:i32=0,q5:i32=0,other:i32=0;
  for(let i:i32=0;i<tensors.length;i++){let ty=unchecked(tensors[i]).type;if(ty==GGML_Q4_K)q4++;else if(ty==GGML_Q6_K)q6++;else if(ty==GGML_Q5_K)q5++;else other++;}
  let lm=lmHead!=null?typeName(changetype<TensorDesc>(lmHead).type):"NONE";
  let gateTy=layers.length>0&&unchecked(layers[0]).gate!=null?typeName(changetype<TensorDesc>(unchecked(layers[0]).gate).type):"NONE";
  let upTy=layers.length>0&&unchecked(layers[0]).up!=null?typeName(changetype<TensorDesc>(unchecked(layers[0]).up).type):"NONE";
  let downTy=layers.length>0&&unchecked(layers[0]).down!=null?typeName(changetype<TensorDesc>(unchecked(layers[0]).down).type):"NONE";
  logSerial("MATH PROFILE lmhead="+lm+" ffn(gate/up/down)="+gateTy+"/"+upTy+"/"+downTy+" tensors Q4_K="+q4.toString()+" Q5_K="+q5.toString()+" Q6_K="+q6.toString()+" other="+other.toString());
}

function finishModelLoad():void {
  loadState=LOAD_PARSING;loadMessage="PARSING + VALIDATING GGUF";logSerial("All model bytes resident in WASM. Parsing GGUF without JS duplicate buffer.");
  let ok=model.parse(modelBytes.dataStart,<usize>modelBytes.length);
  if(!ok){loadState=LOAD_ERROR;loadMessage="GGUF REJECTED: "+model.validationError;logSerial("MODEL REJECTED: "+model.validationError);return;}
  if(!buildTokenizer()){loadState=LOAD_ERROR;loadMessage="TOKENIZER BUILD FAILED";return;}
  if(!allocateRuntime()){loadState=LOAD_ERROR;loadMessage="RUNTIME ALLOCATION FAILED";return;}
  logMathProfile();
  if(!selfTestSimdQ4K()){loadState=LOAD_ERROR;loadMessage="SIMD KERNEL SELFTEST FAILED";model.validationError="SIMD Q4_K kernel mismatch";return;}
  if(!selfTestQ8KIntegerTurbo()){loadState=LOAD_ERROR;loadMessage="Q8_K INTEGER TURBO SELFTEST FAILED";model.validationError="Q4_K/Q6_K x Q8_K mismatch";return;}
  if(!selfTestFusedBatchKernels()){loadState=LOAD_ERROR;loadMessage="FUSED PREFILL KERNEL SELFTEST FAILED";model.validationError="Fused multi-lane prefill kernel mismatch";return;}
  if(!selfTestExpandedQuantCompatibility()){loadState=LOAD_ERROR;loadMessage="EXPANDED QUANT SELFTEST FAILED";model.validationError="Q2_K/Q3_K compatibility kernel mismatch";return;}
  loadState=LOAD_READY;engineState=ENGINE_READY;loadMessage="MODEL READY / ROPE+QUANT MATH VALIDATED";
  logSerial("MODEL READY. Runtime context="+cfg.activeContext.toString()+" KV="+formatBytes(<f64>(kvK.byteLength+kvV.byteLength))+" logits="+cfg.vocabSize.toString());
  emitRuntimeState("model.ready");
}

// =============================================================================
// TOKENIZER // BYTE BPE + SENTENCEPIECE UNIGRAM
// =============================================================================
const tokenToId=new Map<string,i32>();
const mergeRank=new Map<string,i32>();
const specialTokens:string[]=new Array<string>(0);
const specialIds:i32[]=new Array<i32>(0);
let maxPieceChars:i32=1;
let tokenizerIsBpe:bool=false;
let byteToUnicode:Int32Array=new Int32Array(256);
let unicodeToByte:Int16Array=new Int16Array(512);
let utf8Pending:Uint8Array=new Uint8Array(8);
let utf8PendingCount:i32=0;

function buildByteMaps():void {
  unicodeToByte.fill(-1);
  let used=new Uint8Array(256);
  for(let b:i32=33;b<=126;b++){unchecked(byteToUnicode[b]=b);unchecked(used[b]=1);}
  for(let b:i32=161;b<=172;b++){unchecked(byteToUnicode[b]=b);unchecked(used[b]=1);}
  for(let b:i32=174;b<=255;b++){unchecked(byteToUnicode[b]=b);unchecked(used[b]=1);}
  let n:i32=0;
  for(let b:i32=0;b<256;b++)if(unchecked(used[b])==0){unchecked(byteToUnicode[b]=256+n);n++;}
  for(let b:i32=0;b<256;b++){let cp=unchecked(byteToUnicode[b]);if(cp<unicodeToByte.length)unchecked(unicodeToByte[cp]=<i16>b);}
}
function buildTokenizer():bool {
  tokenToId.clear();mergeRank.clear();specialTokens.length=0;specialIds.length=0;maxPieceChars=1;buildByteMaps();
  if(vocabTokens.length==0){logSerial("ERROR: tokenizer.ggml.tokens missing");return false;}
  for(let i:i32=0;i<vocabTokens.length;i++){
    let t=unchecked(vocabTokens[i]);tokenToId.set(t,i);if(t.length>maxPieceChars&&t.length<256)maxPieceChars=t.length;
    let typ=i<vocabTypes.length?unchecked(vocabTypes[i]):0;
    if(typ==3||typ==4||typ==5||(t.startsWith("<|")&&t.endsWith("|>"))||t=="<s>"||t=="</s>"){specialTokens.push(t);specialIds.push(i);}
  }
  for(let i:i32=0;i<bpeMerges.length;i++){
    let m=unchecked(bpeMerges[i]);let p=m.indexOf(" ");if(p>0)mergeRank.set(m.substr(0,p)+"\u0001"+m.substr(p+1),i);
  }
  tokenizerIsBpe=cfg.tokenizerModel=="gpt2"||bpeMerges.length>0||cfg.tokenizerPre.indexOf("qwen")>=0||cfg.tokenizerPre.indexOf("llama")>=0;
  logSerial("Tokenizer built model="+cfg.tokenizerModel+" pre="+cfg.tokenizerPre+" mode="+(tokenizerIsBpe?"BYTE-BPE":"SPM-UNIGRAM")+" vocab="+vocabTokens.length.toString()+" merges="+bpeMerges.length.toString()+" specials="+specialTokens.length.toString());
  return true;
}

function specialAt(text:string,pos:i32):i32 {
  let best:i32=-1,bestLen:i32=0;
  for(let i:i32=0;i<specialTokens.length;i++){let s=unchecked(specialTokens[i]);if(s.length<=bestLen||pos+s.length>text.length)continue;if(text.substr(pos,s.length)==s){best=i;bestLen=s.length;}}
  return best;
}
function classifyChar(c:i32):i32 {
  if(c==32||c==9||c==10||c==13)return 0;
  if(c>=48&&c<=57)return 2;
  // AssemblyScript has no Unicode-property regex; all non-ASCII non-space code units
  // are treated as letters here. UTF-8 byte BPE still preserves exact text bytes.
  if((c>=65&&c<=90)||(c>=97&&c<=122)||c>=128)return 1;
  return 3;
}
function isNewlineCode(c:i32):bool{return c==10||c==13;}
function isContractionAt(text:string,pos:i32):i32 {
  if(pos>=text.length||text.charCodeAt(pos)!=39)return 0;
  let tail=text.substr(pos);let low=tail.toLowerCase();
  if(low.startsWith("'re")||low.startsWith("'ve")||low.startsWith("'ll"))return 3;
  if(low.startsWith("'s")||low.startsWith("'t")||low.startsWith("'m")||low.startsWith("'d"))return 2;
  return 0;
}
function bpeEncodePiece(piece:string,out:i32[]):void {
  let ab=String.UTF8.encode(piece);let n=ab.byteLength;let symbols:string[]=new Array<string>(0);
  for(let i:i32=0;i<n;i++){let bv=<i32>load<u8>(changetype<usize>(ab)+<usize>i);symbols.push(String.fromCharCode(unchecked(byteToUnicode[bv])));}
  // Correct GPT-2/tiktoken BPE semantics: on each pass merge ALL non-overlapping
  // occurrences of the globally best-ranked adjacent pair. Merging only one
  // occurrence can change subsequent pair ranks and produces a different token stream.
  while(symbols.length>1){
    let bestRank:i32=0x7fffffff;let bestKey:string="";
    for(let i:i32=0;i<symbols.length-1;i++){
      let key=unchecked(symbols[i])+"\u0001"+unchecked(symbols[i+1]);
      if(mergeRank.has(key)){let r=mergeRank.get(key);if(r<bestRank){bestRank=r;bestKey=key;}}
    }
    if(bestKey.length==0)break;
    let next:string[]=new Array<string>(0);let i:i32=0;
    while(i<symbols.length){
      if(i+1<symbols.length){
        let key=unchecked(symbols[i])+"\u0001"+unchecked(symbols[i+1]);
        if(key==bestKey){next.push(unchecked(symbols[i])+unchecked(symbols[i+1]));i+=2;continue;}
      }
      next.push(unchecked(symbols[i]));i++;
    }
    symbols=next;
  }
  for(let i:i32=0;i<symbols.length;i++){
    let sym=unchecked(symbols[i]);if(tokenToId.has(sym))out.push(tokenToId.get(sym));else{
      // Byte fallback should normally be present; never invent modulo token ids.
      for(let j:i32=0;j<sym.length;j++){let one=sym.substr(j,1);if(tokenToId.has(one))out.push(tokenToId.get(one));else out.push(cfg.unk);}
    }
  }
}
// Pretokenization closely mirrors llama.cpp's QWEN2 / LLAMA3 / GPT2 families.
// Qwen2 uses one digit per piece; Llama3 uses 1..3 digits; GPT2 allows digit runs.
function tokenizeBpeNormal(text:string,out:i32[]):void {
  let i:i32=0;let pre=cfg.tokenizerPre.toLowerCase();let qwen=pre.indexOf("qwen")>=0||cfg.architecture=="qwen2";let llama3=pre.indexOf("llama")>=0&&tokenToId.has("<|start_header_id|>");
  while(i<text.length){
    let contr=isContractionAt(text,i);if(contr>0){bpeEncodePiece(text.substr(i,contr),out);i+=contr;continue;}
    let c=text.charCodeAt(i),cat=classifyChar(c);
    // Newlines are kept as their own whitespace runs to match model regexes.
    if(isNewlineCode(c)){let st=i;i++;while(i<text.length&&isNewlineCode(text.charCodeAt(i)))i++;bpeEncodePiece(text.substr(st,i-st),out);continue;}
    if(cat==2){let st=i;if(qwen){i++;}else if(llama3){let take:i32=0;while(i<text.length&&classifyChar(text.charCodeAt(i))==2&&take<3){i++;take++;}}else{while(i<text.length&&classifyChar(text.charCodeAt(i))==2)i++;}bpeEncodePiece(text.substr(st,i-st),out);continue;}
    if(cat==1){let st=i;
      // Qwen2/Llama3 allow one non-newline punctuation/space prefix before a letter run.
      if(i>0&&text.charCodeAt(i-1)==32){/* leading space already handled by whitespace branch */}
      i++;while(i<text.length&&classifyChar(text.charCodeAt(i))==1&&!isNewlineCode(text.charCodeAt(i)))i++;bpeEncodePiece(text.substr(st,i-st),out);continue;
    }
    if(cat==3){let st=i;if(c==32&&i+1<text.length&&classifyChar(text.charCodeAt(i+1))==3)i++;i++;while(i<text.length&&classifyChar(text.charCodeAt(i))==3&&!isNewlineCode(text.charCodeAt(i)))i++;while(i<text.length&&isNewlineCode(text.charCodeAt(i)))i++;bpeEncodePiece(text.substr(st,i-st),out);continue;}
    // Whitespace: preserve exactly. A single leading ASCII space is attached to the next
    // letter/number/punctuation piece when that family regex allows it.
    let st=i;while(i<text.length&&classifyChar(text.charCodeAt(i))==0&&!isNewlineCode(text.charCodeAt(i)))i++;
    if(i-st==1&&text.charCodeAt(st)==32&&i<text.length&&!isNewlineCode(text.charCodeAt(i))){let nx=classifyChar(text.charCodeAt(i));if(nx==1||nx==3||(nx==2&&!qwen)){let j=i;if(nx==2){if(llama3){let take:i32=0;while(j<text.length&&classifyChar(text.charCodeAt(j))==2&&take<3){j++;take++;}}else while(j<text.length&&classifyChar(text.charCodeAt(j))==2)j++;}else{j++;while(j<text.length&&classifyChar(text.charCodeAt(j))==nx&&!isNewlineCode(text.charCodeAt(j)))j++;}bpeEncodePiece(text.substr(st,j-st),out);i=j;continue;}}
    bpeEncodePiece(text.substr(st,i-st),out);
  }
}
function replaceSpacesWithMarker(text:string):string {
  let out="▁";for(let i:i32=0;i<text.length;i++){let c=text.charCodeAt(i);out+=c==32?"▁":String.fromCharCode(c);}return out;
}
function tokenizeSpmNormal(text:string,out:i32[]):void {
  let s=replaceSpacesWithMarker(text);let n=s.length;let dp=new Float64Array(n+1);let prev=new Int32Array(n+1);let bestId=new Int32Array(n+1);
  for(let i:i32=0;i<=n;i++){unchecked(dp[i]=-1.0e300);unchecked(prev[i]=-1);unchecked(bestId[i]=-1);}unchecked(dp[0]=0.0);
  for(let i:i32=0;i<n;i++){
    if(unchecked(dp[i])<-1.0e200)continue;let limit=minI(maxPieceChars,n-i);
    for(let l:i32=1;l<=limit;l++){let sub=s.substr(i,l);if(!tokenToId.has(sub))continue;let id=tokenToId.get(sub);let sc=id<vocabScores.length?<f64>unchecked(vocabScores[id]):0.0;let val=unchecked(dp[i])+sc;if(val>unchecked(dp[i+l])){unchecked(dp[i+l]=val);unchecked(prev[i+l]=i);unchecked(bestId[i+l]=id);}}
    if(unchecked(prev[i+1])<0){let one=s.substr(i,1);let id=tokenToId.has(one)?tokenToId.get(one):cfg.unk;let val=unchecked(dp[i])-20.0;if(val>unchecked(dp[i+1])){unchecked(dp[i+1]=val);unchecked(prev[i+1]=i);unchecked(bestId[i+1]=id);}}
  }
  let rev:i32[]=new Array<i32>(0);let p=n;while(p>0){let id=unchecked(bestId[p]);if(id<0){id=cfg.unk;p--;}else p=unchecked(prev[p]);rev.push(id);}
  for(let i:i32=rev.length-1;i>=0;i--)out.push(unchecked(rev[i]));
}
function tokenize(text:string,addBos:bool=false):i32[] {
  let out:i32[]=new Array<i32>(0);if(addBos&&cfg.bos>=0)out.push(cfg.bos);
  let pos:i32=0,normalStart:i32=0;
  while(pos<text.length){let si=specialAt(text,pos);if(si>=0){if(pos>normalStart){let seg=text.substr(normalStart,pos-normalStart);if(tokenizerIsBpe)tokenizeBpeNormal(seg,out);else tokenizeSpmNormal(seg,out);}out.push(unchecked(specialIds[si]));let sl=unchecked(specialTokens[si]).length;pos+=sl;normalStart=pos;}else pos++;}
  if(normalStart<text.length){let seg=text.substr(normalStart);if(tokenizerIsBpe)tokenizeBpeNormal(seg,out);else tokenizeSpmNormal(seg,out);}
  return out;
}

function appendUtf8Byte(byte:i32):string {
  if(utf8PendingCount>=utf8Pending.length)utf8PendingCount=0;
  unchecked(utf8Pending[utf8PendingCount++]=<u8>byte);
  let out="";let p:i32=0;
  while(p<utf8PendingCount){
    let b0=<i32>unchecked(utf8Pending[p]);let need:i32=1,cp:i32=0;
    if(b0<0x80){cp=b0;need=1;}
    else if((b0&0xE0)==0xC0){cp=b0&0x1F;need=2;}
    else if((b0&0xF0)==0xE0){cp=b0&0x0F;need=3;}
    else if((b0&0xF8)==0xF0){cp=b0&0x07;need=4;}
    else{p++;continue;}
    if(p+need>utf8PendingCount)break;
    let valid=true;for(let j:i32=1;j<need;j++){let bx=<i32>unchecked(utf8Pending[p+j]);if((bx&0xC0)!=0x80){valid=false;break;}cp=(cp<<6)|(bx&0x3F);}
    if(!valid){p++;continue;}out+=codePointString(cp);p+=need;
  }
  if(p>0){let remain=utf8PendingCount-p;for(let i:i32=0;i<remain;i++)unchecked(utf8Pending[i]=unchecked(utf8Pending[p+i]));utf8PendingCount=remain;}
  return out;
}
function decodeToken(id:i32):string {
  if(id<0||id>=vocabTokens.length)return"";let raw=unchecked(vocabTokens[id]);
  if(raw.startsWith("<|")&&raw.endsWith("|>"))return"";
  if(!tokenizerIsBpe){let out="";for(let i:i32=0;i<raw.length;i++){if(raw.charCodeAt(i)==0x2581)out+=" ";else out+=raw.substr(i,1);}return out;}
  let out="";
  for(let i:i32=0;i<raw.length;i++){let cp=raw.charCodeAt(i);if(cp<unicodeToByte.length&&unchecked(unicodeToByte[cp])>=0)out+=appendUtf8Byte(<i32>unchecked(unicodeToByte[cp]));else out+=raw.substr(i,1);}
  return out;
}

// =============================================================================
// NUMERIC KERNELS
// =============================================================================
@inline function fp16ToF32(h:u16):f32 {
  let s:u32=(<u32>(h&0x8000))<<16;let e:i32=<i32>((h>>10)&0x1F);let m:u32=<u32>(h&0x03FF);
  if(e==0){if(m==0)return f32.reinterpret_i32(<i32>s);while((m&0x0400)==0){m<<=1;e--;}e++;m&=~0x0400;}
  else if(e==31)return f32.reinterpret_i32(<i32>(s|0x7F800000|(m<<13)));
  e=e+112;m<<=13;return f32.reinterpret_i32(<i32>(s|(<u32>e<<23)|m));
}
@inline function bf16ToF32(h:u16):f32 { return f32.reinterpret_i32(<i32>(<u32>h<<16)); }
@inline function getScaleK4(scales:usize,j:i32):i32 { if(j<4)return <i32>(load<u8>(scales+<usize>j)&63);return (<i32>(load<u8>(scales+<usize>(j+4))&0x0F))|((<i32>(load<u8>(scales+<usize>(j-4))>>6))<<4); }
@inline function getMinK4(scales:usize,j:i32):i32 { if(j<4)return <i32>(load<u8>(scales+<usize>(j+4))&63);return (<i32>(load<u8>(scales+<usize>(j+4))>>4))|((<i32>(load<u8>(scales+<usize>j)>>6))<<4); }

// SIMD128 acceleration. These helpers operate directly on the Float32Array backing
// memory and avoid temporary arrays/heap allocations in the hot GEMV path.
@inline function hsumF32x4(v:v128):f32 {
  return v128.extract_lane<f32>(v,0)+v128.extract_lane<f32>(v,1)+v128.extract_lane<f32>(v,2)+v128.extract_lane<f32>(v,3);
}
@inline function loadX4(x:Float32Array,index:i32):v128 {
  return v128.load(changetype<usize>(x.dataStart)+<usize>(index*4));
}
@inline function u8x16LowToF32_0(v:v128):v128 { let w=v128.extend_low<u8>(v); return v128.convert<u32>(v128.extend_low<u16>(w)); }
@inline function u8x16LowToF32_1(v:v128):v128 { let w=v128.extend_low<u8>(v); return v128.convert<u32>(v128.extend_high<u16>(w)); }
@inline function u8x16LowToF32_2(v:v128):v128 { let w=v128.extend_high<u8>(v); return v128.convert<u32>(v128.extend_low<u16>(w)); }
@inline function u8x16LowToF32_3(v:v128):v128 { let w=v128.extend_high<u8>(v); return v128.convert<u32>(v128.extend_high<u16>(w)); }

// Accumulates 16 unsigned u8 lanes against 16 f32 activations into four-lane
// partials. q must already contain the desired 0..15 nibble values.
@inline function dotU8x16F32(q:v128,x:Float32Array,base:i32):f32 {
  let a0=v128.mul<f32>(u8x16LowToF32_0(q),loadX4(x,base));
  let a1=v128.mul<f32>(u8x16LowToF32_1(q),loadX4(x,base+4));
  let a2=v128.mul<f32>(u8x16LowToF32_2(q),loadX4(x,base+8));
  let a3=v128.mul<f32>(u8x16LowToF32_3(q),loadX4(x,base+12));
  return hsumF32x4(v128.add<f32>(v128.add<f32>(a0,a1),v128.add<f32>(a2,a3)));
}
@inline function sumX16(x:Float32Array,base:i32):f32 {
  let v=v128.add<f32>(v128.add<f32>(loadX4(x,base),loadX4(x,base+4)),v128.add<f32>(loadX4(x,base+8),loadX4(x,base+12)));
  return hsumF32x4(v);
}

// -----------------------------------------------------------------------------
// Q8_K ACTIVATION QUANTIZATION + INTEGER SIMD DOT
// Mirrors ggml's quantized-activation execution strategy: quantize one activation
// vector once, then reuse it for every row of the Q4_K/Q6_K matrix.
// -----------------------------------------------------------------------------
@inline function hsumI32x4(v:v128):i32 { return v128.extract_lane<i32>(v,0)+v128.extract_lane<i32>(v,1)+v128.extract_lane<i32>(v,2)+v128.extract_lane<i32>(v,3); }
@inline function dotU8I8x16V(q4:v128,q8:v128):v128 {
  return v128.add<i32>(v128.dot<i16>(v128.extend_low<u8>(q4),v128.extend_low<i8>(q8)),v128.dot<i16>(v128.extend_high<u8>(q4),v128.extend_high<i8>(q8)));
}
@inline function dotI8I8x16V(a:v128,b:v128):v128 {
  return v128.add<i32>(v128.dot<i16>(v128.extend_low<i8>(a),v128.extend_low<i8>(b)),v128.dot<i16>(v128.extend_high<i8>(a),v128.extend_high<i8>(b)));
}
@inline function dotU8I8x16(q4:v128,q8:v128):i32 { return hsumI32x4(dotU8I8x16V(q4,q8)); }
@inline function dotI8I8x16(a:v128,b:v128):i32 { return hsumI32x4(dotI8I8x16V(a,b)); }
function quantizeActivationQ8K(xv:Float32Array,n:i32):bool {
  if(n<=0||n%256!=0||q8KQs.length<n)return false;
  let blocks=n/256;
  for(let b:i32=0;b<blocks;b++){
    let base=b*256,minv:f32=unchecked(xv[base]),maxv:f32=minv;
    for(let j:i32=1;j<256;j++){let z=unchecked(xv[base+j]);if(z<minv)minv=z;if(z>maxv)maxv=z;}
    // ggml Q8_K chooses the signed extremum with the largest absolute magnitude.
    let amax:f32=(-minv>maxv)?minv:maxv;
    if(amax==0.0){unchecked(q8KD[b]=0.0);for(let j:i32=0;j<256;j++)unchecked(q8KQs[base+j]=0);for(let k:i32=0;k<16;k++)unchecked(q8KBSums[b*16+k]=0);continue;}
    let iscale:f32=-127.0/amax,d:f32=1.0/iscale;unchecked(q8KD[b]=d);
    for(let c:i32=0;c<16;c++){
      let sum:i32=0,cb=base+c*16;
      for(let j:i32=0;j<16;j++){
        // nearest integer; exact .5 ties are vanishingly rare for activations.
        let fv=<f64>(unchecked(xv[cb+j])*iscale),qi=<i32>Math.round(fv);if(qi>127)qi=127;else if(qi<-127)qi=-127;
        unchecked(q8KQs[cb+j]=<i8>qi);sum+=qi;
      }
      unchecked(q8KBSums[b*16+c]=<i16>sum);
    }
  }
  return true;
}
@inline function dotQ4KQ8(ptr:usize,n:i32):f32 {
  let sum:f32=0.0,blocks=n/256,mask=v128.splat<u8>(15),q8BasePtr=changetype<usize>(q8KQs.dataStart);
  for(let b:i32=0;b<blocks;b++){
    let d4=fp16ToF32(load<u16>(ptr)),dm4=fp16ToF32(load<u16>(ptr+2)),scales=ptr+4,qs=ptr+16,d8=unchecked(q8KD[b]),qb=b*256,sb=b*16,is:i32=0;
    for(let g:i32=0;g<4;g++){
      let qp=qs+<usize>(g*32),qv0=v128.load(qp),qv1=v128.load(qp+16),lo0=v128.and(qv0,mask),lo1=v128.and(qv1,mask),hi0=v128.and(v128.shr<u8>(qv0,4),mask),hi1=v128.and(v128.shr<u8>(qv1,4),mask);
      let q8a0=v128.load(q8BasePtr+<usize>(qb+g*64)),q8a1=v128.load(q8BasePtr+<usize>(qb+g*64+16)),q8b0=v128.load(q8BasePtr+<usize>(qb+g*64+32)),q8b1=v128.load(q8BasePtr+<usize>(qb+g*64+48));
      let i1=hsumI32x4(v128.add<i32>(dotU8I8x16V(lo0,q8a0),dotU8I8x16V(lo1,q8a1))),i2=hsumI32x4(v128.add<i32>(dotU8I8x16V(hi0,q8b0),dotU8I8x16V(hi1,q8b1)));
      let bs1=<i32>unchecked(q8KBSums[sb+g*4])+<i32>unchecked(q8KBSums[sb+g*4+1]),bs2=<i32>unchecked(q8KBSums[sb+g*4+2])+<i32>unchecked(q8KBSums[sb+g*4+3]);
      let sc1=getScaleK4(scales,is),mn1=getMinK4(scales,is),sc2=getScaleK4(scales,is+1),mn2=getMinK4(scales,is+1);
      sum+=d8*(d4*(<f32>sc1*<f32>i1+<f32>sc2*<f32>i2)-dm4*(<f32>mn1*<f32>bs1+<f32>mn2*<f32>bs2));is+=2;
    }
    ptr+=144;
  }
  return sum;
}
function dotQ4KQ8Scalar(ptr:usize,n:i32):f32 {
  let sum:f32=0.0,blocks=n/256;
  for(let b:i32=0;b<blocks;b++){
    let d4=fp16ToF32(load<u16>(ptr)),dm4=fp16ToF32(load<u16>(ptr+2)),sc=ptr+4,qs=ptr+16,d8=unchecked(q8KD[b]),qb=b*256,sb=b*16,is:i32=0;
    for(let g:i32=0;g<4;g++){
      let a:i32=0,c:i32=0,qp=qs+<usize>(g*32);
      for(let l:i32=0;l<32;l++){let z=load<u8>(qp+<usize>l);a+=(<i32>(z&15))*<i32>unchecked(q8KQs[qb+g*64+l]);c+=(<i32>(z>>4))*<i32>unchecked(q8KQs[qb+g*64+32+l]);}
      let bs1=<i32>unchecked(q8KBSums[sb+g*4])+<i32>unchecked(q8KBSums[sb+g*4+1]),bs2=<i32>unchecked(q8KBSums[sb+g*4+2])+<i32>unchecked(q8KBSums[sb+g*4+3]);
      sum+=d8*(d4*(<f32>getScaleK4(sc,is)*<f32>a+<f32>getScaleK4(sc,is+1)*<f32>c)-dm4*(<f32>getMinK4(sc,is)*<f32>bs1+<f32>getMinK4(sc,is+1)*<f32>bs2));is+=2;
    }ptr+=144;
  }return sum;
}
@inline function dotQ6KQ8(ptr:usize,n:i32):f32 {
  let sum:f32=0.0,blocks=n/256,mask15=v128.splat<u8>(15),mask3=v128.splat<u8>(3),thirty2=v128.splat<i8>(32),q8BasePtr=changetype<usize>(q8KQs.dataStart);
  for(let b:i32=0;b<blocks;b++){
    let ql=ptr,qh=ptr+128,sc=ptr+192,d6=fp16ToF32(load<u16>(ptr+208)),d8=unchecked(q8KD[b]),qb=b*256;
    for(let ip:i32=0;ip<2;ip++){
      let qlBase=ql+<usize>(64*ip),qhBase=qh+<usize>(32*ip),xb=qb+128*ip;
      for(let half:i32=0;half<2;half++){
        let l0=half*16,is=8*ip+half,lq0=v128.load(qlBase+<usize>l0),lq1=v128.load(qlBase+<usize>(l0+32)),hv=v128.load(qhBase+<usize>l0);
        let a=v128.sub<i8>(v128.or(v128.and(lq0,mask15),v128.shl<u8>(v128.and(hv,mask3),4)),thirty2);
        let b1=v128.sub<i8>(v128.or(v128.and(lq1,mask15),v128.shl<u8>(v128.and(v128.shr<u8>(hv,2),mask3),4)),thirty2);
        let c=v128.sub<i8>(v128.or(v128.and(v128.shr<u8>(lq0,4),mask15),v128.shl<u8>(v128.and(v128.shr<u8>(hv,4),mask3),4)),thirty2);
        let e=v128.sub<i8>(v128.or(v128.and(v128.shr<u8>(lq1,4),mask15),v128.shl<u8>(v128.and(v128.shr<u8>(hv,6),mask3),4)),thirty2);
        let s0=dotI8I8x16(a,v128.load(q8BasePtr+<usize>(xb+l0))),s1=dotI8I8x16(b1,v128.load(q8BasePtr+<usize>(xb+32+l0))),s2=dotI8I8x16(c,v128.load(q8BasePtr+<usize>(xb+64+l0))),s3=dotI8I8x16(e,v128.load(q8BasePtr+<usize>(xb+96+l0)));
        sum+=d6*d8*(<f32>load<i8>(sc+<usize>(is+0))*<f32>s0+<f32>load<i8>(sc+<usize>(is+2))*<f32>s1+<f32>load<i8>(sc+<usize>(is+4))*<f32>s2+<f32>load<i8>(sc+<usize>(is+6))*<f32>s3);
      }
    }ptr+=210;
  }return sum;
}
function dotQ6KQ8Scalar(ptr:usize,n:i32):f32 {
  let sum:f32=0.0,blocks=n/256;
  for(let b:i32=0;b<blocks;b++){
    let ql=ptr,qh=ptr+128,sc=ptr+192,d6=fp16ToF32(load<u16>(ptr+208)),d8=unchecked(q8KD[b]),qb=b*256;
    for(let ip:i32=0;ip<2;ip++){let qlBase=ql+<usize>(64*ip),qhBase=qh+<usize>(32*ip),xBase=qb+128*ip;for(let half:i32=0;half<2;half++){let l0=half*16,is=8*ip+half,s0:i32=0,s1:i32=0,s2:i32=0,s3:i32=0;for(let ll:i32=0;ll<16;ll++){let l=l0+ll,q0=load<u8>(qlBase+<usize>l),q1=load<u8>(qlBase+<usize>(l+32)),h=load<u8>(qhBase+<usize>l);let a=(<i32>(q0&15)|(<i32>((h>>0)&3)<<4))-32,b1=(<i32>(q1&15)|(<i32>((h>>2)&3)<<4))-32,c=(<i32>(q0>>4)|(<i32>((h>>4)&3)<<4))-32,e=(<i32>(q1>>4)|(<i32>((h>>6)&3)<<4))-32;s0+=a*<i32>unchecked(q8KQs[xBase+l]);s1+=b1*<i32>unchecked(q8KQs[xBase+32+l]);s2+=c*<i32>unchecked(q8KQs[xBase+64+l]);s3+=e*<i32>unchecked(q8KQs[xBase+96+l]);}sum+=d6*d8*(<f32>load<i8>(sc+<usize>(is+0))*<f32>s0+<f32>load<i8>(sc+<usize>(is+2))*<f32>s1+<f32>load<i8>(sc+<usize>(is+4))*<f32>s2+<f32>load<i8>(sc+<usize>(is+6))*<f32>s3);}}
    ptr+=210;
  }return sum;
}

// Q2_K / Q3_K compatibility kernels. These follow the GGML 256-value
// super-block layouts exactly. V2.5 keeps them as correctness-first scalar
// fallbacks; Q4_K/Q6_K retain the integer SIMD hot path.
@inline function q3ScaleByte(a0:u32,a1:u32,a2:u32,a3:u32,index:i32):i32 {
  let g=index>>2,sh=(index&3)*8,v:u32=g==0?a0:(g==1?a1:(g==2?a2:a3));return <i32>((v>>sh)&255)-32;
}
@inline function dotQ2K(ptr:usize,xv:Float32Array,xo:i32,n:i32):f32 {
  let total:f32=0.0,nb=n/256;
  for(let b:i32=0;b<nb;b++){
    let scales=ptr,qs=ptr+16,d=fp16ToF32(load<u16>(ptr+80)),dm=fp16ToF32(load<u16>(ptr+82)),outBase=xo+b*256,is:i32=0,seq:i32=0;
    for(let half:i32=0;half<2;half++){
      let qp=qs+<usize>(half*32);
      for(let sh:i32=0;sh<=6;sh+=2){
        let sc0=load<u8>(scales+<usize>is);is++;let dl0=d*<f32>(sc0&15),ml0=dm*<f32>(sc0>>4),s0:f32=0.0;
        for(let l:i32=0;l<16;l++)s0+=(dl0*<f32>((load<u8>(qp+<usize>l)>>sh)&3)-ml0)*unchecked(xv[outBase+seq+l]);seq+=16;
        let sc1=load<u8>(scales+<usize>is);is++;let dl1=d*<f32>(sc1&15),ml1=dm*<f32>(sc1>>4),s1:f32=0.0;
        for(let l:i32=0;l<16;l++)s1+=(dl1*<f32>((load<u8>(qp+<usize>(l+16))>>sh)&3)-ml1)*unchecked(xv[outBase+seq+l]);seq+=16;total+=s0+s1;
      }
    }
    ptr+=84;
  }return total;
}
@inline function dotQ3K(ptr:usize,xv:Float32Array,xo:i32,n:i32):f32 {
  let total:f32=0.0,nb=n/256,km1:u32=0x03030303,km2:u32=0x0f0f0f0f;
  for(let b:i32=0;b<nb;b++){
    let hm=ptr,qs=ptr+32,sp=ptr+96,d=fp16ToF32(load<u16>(ptr+108));
    let o0=load<u32>(sp),o1=load<u32>(sp+4),tmp=load<u32>(sp+8);
    let a2=((o0>>4)&km2)|(((tmp>>4)&km1)<<4),a3=((o1>>4)&km2)|(((tmp>>6)&km1)<<4),a0=(o0&km2)|(((tmp>>0)&km1)<<4),a1=(o1&km2)|(((tmp>>2)&km1)<<4);
    let is:i32=0,seq:i32=0,m:u8=1,outBase=xo+b*256;
    for(let half:i32=0;half<2;half++){
      let qp=qs+<usize>(half*32);let shift:i32=0;
      for(let j:i32=0;j<4;j++){
        let dl0=d*<f32>q3ScaleByte(a0,a1,a2,a3,is);is++;for(let l:i32=0;l<16;l++){let qv=<i32>((load<u8>(qp+<usize>l)>>shift)&3)-((load<u8>(hm+<usize>l)&m)!=0?0:4);total+=dl0*<f32>qv*unchecked(xv[outBase+seq+l]);}seq+=16;
        let dl1=d*<f32>q3ScaleByte(a0,a1,a2,a3,is);is++;for(let l:i32=0;l<16;l++){let qv=<i32>((load<u8>(qp+<usize>(l+16))>>shift)&3)-((load<u8>(hm+<usize>(l+16))&m)!=0?0:4);total+=dl1*<f32>qv*unchecked(xv[outBase+seq+l]);}seq+=16;
        shift+=2;m<<=1;
      }
    }
    ptr+=110;
  }return total;
}
@inline function dotQ8KStored(ptr:usize,xv:Float32Array,xo:i32,n:i32):f32 {
  let total:f32=0.0,nb=n/256;
  for(let b:i32=0;b<nb;b++){let d=load<f32>(ptr),qp=ptr+4,base=xo+b*256,s:f32=0.0;for(let j:i32=0;j<256;j++)s+=<f32>load<i8>(qp+<usize>j)*unchecked(xv[base+j]);total+=d*s;ptr+=292;}return total;
}

// Scalar TURBO kernels. They preserve the GGML block math but factor block
// scales/minima outside the element loop, materially reducing multiplications.
@inline function dotQ4_0(ptr:usize,x:Float32Array,xo:i32,n:i32):f32 {
  let sum:f32=0.0,blocks=n/32,mask=v128.splat<u8>(15),eight=v128.splat<f32>(8.0);
  for(let b:i32=0;b<blocks;b++){
    let d=fp16ToF32(load<u16>(ptr));ptr+=2;let base=xo+b*32,q=v128.load(ptr);
    let lo=v128.and(q,mask),hi=v128.and(v128.shr<u8>(q,4),mask);
    // Q4_0 is signed nibble (q - 8). Convert each 4-lane group and subtract 8.
    let p0=v128.mul<f32>(v128.sub<f32>(u8x16LowToF32_0(lo),eight),loadX4(x,base));
    let p1=v128.mul<f32>(v128.sub<f32>(u8x16LowToF32_1(lo),eight),loadX4(x,base+4));
    let p2=v128.mul<f32>(v128.sub<f32>(u8x16LowToF32_2(lo),eight),loadX4(x,base+8));
    let p3=v128.mul<f32>(v128.sub<f32>(u8x16LowToF32_3(lo),eight),loadX4(x,base+12));
    let r0=v128.mul<f32>(v128.sub<f32>(u8x16LowToF32_0(hi),eight),loadX4(x,base+16));
    let r1=v128.mul<f32>(v128.sub<f32>(u8x16LowToF32_1(hi),eight),loadX4(x,base+20));
    let r2=v128.mul<f32>(v128.sub<f32>(u8x16LowToF32_2(hi),eight),loadX4(x,base+24));
    let r3=v128.mul<f32>(v128.sub<f32>(u8x16LowToF32_3(hi),eight),loadX4(x,base+28));
    let acc=v128.add<f32>(v128.add<f32>(v128.add<f32>(p0,p1),v128.add<f32>(p2,p3)),v128.add<f32>(v128.add<f32>(r0,r1),v128.add<f32>(r2,r3)));
    sum+=d*hsumF32x4(acc);ptr+=16;
  }return sum;
}
@inline function dotQ4_1(ptr:usize,x:Float32Array,xo:i32,n:i32):f32 {
  let sum:f32=0.0,blocks=n/32;
  for(let b:i32=0;b<blocks;b++){let d=fp16ToF32(load<u16>(ptr)),m=fp16ToF32(load<u16>(ptr+2));ptr+=4;let base=xo+b*32,qdot:f32=0.0,xsum:f32=0.0;
    for(let j:i32=0;j<16;j++){let z=load<u8>(ptr+<usize>j),x0=unchecked(x[base+j]),x1=unchecked(x[base+j+16]);qdot+=<f32>(z&15)*x0+<f32>(z>>4)*x1;xsum+=x0+x1;}
    sum+=d*qdot+m*xsum;ptr+=16;
  }return sum;
}
@inline function dotQ5_0(ptr:usize,x:Float32Array,xo:i32,n:i32):f32 {
  let sum:f32=0.0,blocks=n/32;
  for(let b:i32=0;b<blocks;b++){let d=fp16ToF32(load<u16>(ptr)),qh=load<u32>(ptr+2),qs=ptr+6,base=xo+b*32,qdot:f32=0.0;
    for(let j:i32=0;j<16;j++){let z=load<u8>(qs+<usize>j);let a=(<i32>(z&15)|(<i32>((qh>>j)&1)<<4))-16,c=(<i32>(z>>4)|(<i32>((qh>>(j+16))&1)<<4))-16;qdot+=<f32>a*unchecked(x[base+j])+<f32>c*unchecked(x[base+j+16]);}
    sum+=d*qdot;ptr+=22;
  }return sum;
}
@inline function dotQ5_1(ptr:usize,x:Float32Array,xo:i32,n:i32):f32 {
  let sum:f32=0.0,blocks=n/32;
  for(let b:i32=0;b<blocks;b++){let d=fp16ToF32(load<u16>(ptr)),m=fp16ToF32(load<u16>(ptr+2)),qh=load<u32>(ptr+4),qs=ptr+8,base=xo+b*32,qdot:f32=0.0,xsum:f32=0.0;
    for(let j:i32=0;j<16;j++){let z=load<u8>(qs+<usize>j),x0=unchecked(x[base+j]),x1=unchecked(x[base+j+16]);let a=<i32>(z&15)|(<i32>((qh>>j)&1)<<4),c=<i32>(z>>4)|(<i32>((qh>>(j+16))&1)<<4);qdot+=<f32>a*x0+<f32>c*x1;xsum+=x0+x1;}
    sum+=d*qdot+m*xsum;ptr+=24;
  }return sum;
}
@inline function dotQ8_0(ptr:usize,x:Float32Array,xo:i32,n:i32):f32 {
  let sum:f32=0.0,blocks=n/32;
  for(let b:i32=0;b<blocks;b++){let d=fp16ToF32(load<u16>(ptr));ptr+=2;let base=xo+b*32,s:f32=0.0;
    for(let j:i32=0;j<32;j++)s+=<f32>load<i8>(ptr+<usize>j)*unchecked(x[base+j]);sum+=d*s;ptr+=32;
  }return sum;
}
@inline function dotQ4K(ptr:usize,x:Float32Array,xo:i32,n:i32):f32 {
  let sum:f32=0.0,blocks=n/256,mask=v128.splat<u8>(15);
  for(let b:i32=0;b<blocks;b++){
    let d=fp16ToF32(load<u16>(ptr)),dm=fp16ToF32(load<u16>(ptr+2)),scales=ptr+4,qs=ptr+16,xb=xo+b*256,is:i32=0;
    for(let g:i32=0;g<4;g++){
      let d1=d*<f32>getScaleK4(scales,is),m1=dm*<f32>getMinK4(scales,is),d2=d*<f32>getScaleK4(scales,is+1),m2=dm*<f32>getMinK4(scales,is+1);
      let qp=qs+<usize>(g*32),base=xb+g*64,qdot1:f32=0.0,qdot2:f32=0.0,xsum1:f32=0.0,xsum2:f32=0.0;
      // 32 packed bytes = 32 low-nibble weights followed logically by 32 high-nibble weights.
      for(let chunk:i32=0;chunk<2;chunk++){
        let q=v128.load(qp+<usize>(chunk*16));
        let lo=v128.and(q,mask),hi=v128.and(v128.shr<u8>(q,4),mask),off=chunk*16;
        qdot1+=dotU8x16F32(lo,x,base+off);qdot2+=dotU8x16F32(hi,x,base+32+off);
        xsum1+=sumX16(x,base+off);xsum2+=sumX16(x,base+32+off);
      }
      sum+=d1*qdot1-m1*xsum1+d2*qdot2-m2*xsum2;is+=2;
    }ptr+=144;
  }return sum;
}
// Scalar reference retained only for one-time startup verification of the SIMD
// Q4_K kernel on real model bytes. It is never used in production GEMV.
function dotQ4KReference(ptr:usize,x:Float32Array,xo:i32,n:i32):f32 {
  let sum:f32=0.0,blocks=n/256;
  for(let b:i32=0;b<blocks;b++){
    let d=fp16ToF32(load<u16>(ptr)),dm=fp16ToF32(load<u16>(ptr+2)),scales=ptr+4,qs=ptr+16,xb=xo+b*256,is:i32=0;
    for(let g:i32=0;g<4;g++){
      let d1=d*<f32>getScaleK4(scales,is),m1=dm*<f32>getMinK4(scales,is),d2=d*<f32>getScaleK4(scales,is+1),m2=dm*<f32>getMinK4(scales,is+1);
      let qp=qs+<usize>(g*32),base=xb+g*64,qdot1:f32=0.0,qdot2:f32=0.0,xsum1:f32=0.0,xsum2:f32=0.0;
      for(let l:i32=0;l<32;l++){let z=load<u8>(qp+<usize>l),x1=unchecked(x[base+l]),x2=unchecked(x[base+32+l]);qdot1+=<f32>(z&15)*x1;qdot2+=<f32>(z>>4)*x2;xsum1+=x1;xsum2+=x2;}
      sum+=d1*qdot1-m1*xsum1+d2*qdot2-m2*xsum2;is+=2;
    }ptr+=144;
  }return sum;
}
function selfTestSimdQ4K():bool {
  let candidate:TensorDesc|null=null;
  for(let i:i32=0;i<tensors.length;i++){let t=unchecked(tensors[i]);if(t.type==GGML_Q4_K&&t.ne0>=256&&t.ne0<=<i64>norm.length){candidate=t;break;}}
  if(candidate==null){logSerial("SELFTEST SIMD Q4_K SKIP (no compatible Q4_K tensor)");return true;}
  let c=changetype<TensorDesc>(candidate),n=<i32>c.ne0;
  for(let i:i32=0;i<n;i++)unchecked(norm[i]=<f32>((i%29)-14)*0.03125);
  let ref=dotQ4KReference(c.ptr,norm,0,n),simd=dotQ4K(c.ptr,norm,0,n),absErr=<f32>Math.abs(<f64>(ref-simd)),den=<f32>Math.max(1.0,Math.abs(<f64>ref)),rel=absErr/den;
  let ok=rel<0.00005;
  logSerial("SELFTEST SIMD Q4_K "+(ok?"PASS":"FAIL")+" ref="+formatF(ref,9)+" simd="+formatF(simd,9)+" rel="+formatF(rel,8));
  return ok;
}
function selfTestQ8KIntegerTurbo():bool {
  let q4:TensorDesc|null=null,q6:TensorDesc|null=null;
  for(let i:i32=0;i<tensors.length;i++){let t=unchecked(tensors[i]);if(t.ne0>=256&&t.ne0<=<i64>q8KQs.length){if(q4==null&&t.type==GGML_Q4_K)q4=t;if(q6==null&&t.type==GGML_Q6_K)q6=t;}}
  let ok=true;
  if(q4!=null){let c=changetype<TensorDesc>(q4),n=<i32>c.ne0;for(let i:i32=0;i<n;i++)unchecked(norm[i]=<f32>((i%41)-20)*0.021);quantizeActivationQ8K(norm,n);let scalar=dotQ4KQ8Scalar(c.ptr,n),simd=dotQ4KQ8(c.ptr,n),floatRef=dotQ4K(c.ptr,norm,0,n),rel=<f32>Math.abs(<f64>(scalar-simd))/<f32>Math.max(1.0,Math.abs(<f64>scalar)),qerr=<f32>Math.abs(<f64>(floatRef-simd))/<f32>Math.max(1.0,Math.abs(<f64>floatRef));let pass=rel<0.00001&&qerr<0.05;logSerial("SELFTEST Q4_KxQ8_K "+(pass?"PASS":"FAIL")+" scalar="+formatF(scalar,9)+" simd="+formatF(simd,9)+" exactRel="+formatF(rel,8)+" q8VsF32="+formatF(qerr,8));ok=ok&&pass;}
  if(q6!=null){let c=changetype<TensorDesc>(q6),n=<i32>c.ne0;for(let i:i32=0;i<n;i++)unchecked(norm[i]=<f32>((i%37)-18)*0.019);quantizeActivationQ8K(norm,n);let scalar=dotQ6KQ8Scalar(c.ptr,n),simd=dotQ6KQ8(c.ptr,n),floatRef=dotQ6K(c.ptr,norm,0,n),rel=<f32>Math.abs(<f64>(scalar-simd))/<f32>Math.max(1.0,Math.abs(<f64>scalar)),qerr=<f32>Math.abs(<f64>(floatRef-simd))/<f32>Math.max(1.0,Math.abs(<f64>floatRef));let pass=rel<0.00001&&qerr<0.05;logSerial("SELFTEST Q6_KxQ8_K "+(pass?"PASS":"FAIL")+" scalar="+formatF(scalar,9)+" simd="+formatF(simd,9)+" exactRel="+formatF(rel,8)+" q8VsF32="+formatF(qerr,8));ok=ok&&pass;}
  if(q4==null&&q6==null)logSerial("SELFTEST Q8_K integer turbo SKIP (no Q4_K/Q6_K matrix)");
  return ok;
}
@inline function dotQ5K(ptr:usize,x:Float32Array,xo:i32,n:i32):f32 {
  let sum:f32=0.0,blocks=n/256;
  for(let b:i32=0;b<blocks;b++){
    let d=fp16ToF32(load<u16>(ptr)),dm=fp16ToF32(load<u16>(ptr+2)),scales=ptr+4,qh=ptr+16,qs=ptr+48,xb=xo+b*256,is:i32=0,u1:i32=1,u2:i32=2;
    for(let g:i32=0;g<4;g++){
      let d1=d*<f32>getScaleK4(scales,is),m1=dm*<f32>getMinK4(scales,is),d2=d*<f32>getScaleK4(scales,is+1),m2=dm*<f32>getMinK4(scales,is+1);
      let qp=qs+<usize>(g*32),base=xb+g*64,qdot1:f32=0.0,qdot2:f32=0.0,xsum1:f32=0.0,xsum2:f32=0.0;
      for(let l:i32=0;l<32;l++){let z=load<u8>(qp+<usize>l),hb=<i32>load<u8>(qh+<usize>l),x1=unchecked(x[base+l]),x2=unchecked(x[base+32+l]);let a=<i32>(z&15)+((hb&u1)!=0?16:0),c=<i32>(z>>4)+((hb&u2)!=0?16:0);qdot1+=<f32>a*x1;qdot2+=<f32>c*x2;xsum1+=x1;xsum2+=x2;}
      sum+=d1*qdot1-m1*xsum1+d2*qdot2-m2*xsum2;is+=2;u1<<=2;u2<<=2;
    }ptr+=176;
  }return sum;
}
@inline function dotQ6K(ptr:usize,x:Float32Array,xo:i32,n:i32):f32 {
  let sum:f32=0.0,blocks=n/256;
  for(let b:i32=0;b<blocks;b++){
    let ql=ptr,qh=ptr+128,sc=ptr+192,d=fp16ToF32(load<u16>(ptr+208)),xb=xo+b*256;
    for(let ip:i32=0;ip<2;ip++){
      let qlBase=ql+<usize>(64*ip),qhBase=qh+<usize>(32*ip),xBase=xb+128*ip;
      for(let half:i32=0;half<2;half++){
        let l0=half*16,is=8*ip+half,s0:f32=0.0,s1:f32=0.0,s2:f32=0.0,s3:f32=0.0;
        for(let ll:i32=0;ll<16;ll++){
          let l=l0+ll,q0=load<u8>(qlBase+<usize>l),q1=load<u8>(qlBase+<usize>(l+32)),h=load<u8>(qhBase+<usize>l);
          let a=(<i32>(q0&15)|(<i32>((h>>0)&3)<<4))-32,b1=(<i32>(q1&15)|(<i32>((h>>2)&3)<<4))-32,c=(<i32>(q0>>4)|(<i32>((h>>4)&3)<<4))-32,e=(<i32>(q1>>4)|(<i32>((h>>6)&3)<<4))-32;
          s0+=<f32>a*unchecked(x[xBase+l]);s1+=<f32>b1*unchecked(x[xBase+32+l]);s2+=<f32>c*unchecked(x[xBase+64+l]);s3+=<f32>e*unchecked(x[xBase+96+l]);
        }
        sum+=d*(<f32>load<i8>(sc+<usize>(is+0))*s0+<f32>load<i8>(sc+<usize>(is+2))*s1+<f32>load<i8>(sc+<usize>(is+4))*s2+<f32>load<i8>(sc+<usize>(is+6))*s3);
      }
    }ptr+=210;
  }return sum;
}

@inline function dotF32(ptr:usize,x:Float32Array,cols:i32):f32 {
  let acc=v128.splat<f32>(0.0),i:i32=0,xp=changetype<usize>(x.dataStart);
  for(;i+3<cols;i+=4){acc=v128.add<f32>(acc,v128.mul<f32>(v128.load(ptr+<usize>(i*4)),v128.load(xp+<usize>(i*4))));}
  let s=hsumF32x4(acc);for(;i<cols;i++)s+=load<f32>(ptr+<usize>(i*4))*unchecked(x[i]);return s;
}
@inline function dotF16(ptr:usize,x:Float32Array,cols:i32):f32 {
  let s0:f32=0.0,s1:f32=0.0,s2:f32=0.0,s3:f32=0.0,i:i32=0;
  for(;i+3<cols;i+=4){s0+=fp16ToF32(load<u16>(ptr+<usize>(i*2)))*unchecked(x[i]);s1+=fp16ToF32(load<u16>(ptr+<usize>((i+1)*2)))*unchecked(x[i+1]);s2+=fp16ToF32(load<u16>(ptr+<usize>((i+2)*2)))*unchecked(x[i+2]);s3+=fp16ToF32(load<u16>(ptr+<usize>((i+3)*2)))*unchecked(x[i+3]);}
  let s=s0+s1+s2+s3;for(;i<cols;i++)s+=fp16ToF32(load<u16>(ptr+<usize>(i*2)))*unchecked(x[i]);return s;
}
@inline function dotBF16(ptr:usize,x:Float32Array,cols:i32):f32 {
  let s:f32=0.0;for(let i:i32=0;i<cols;i++)s+=bf16ToF32(load<u16>(ptr+<usize>(i*2)))*unchecked(x[i]);return s;
}

// Dispatch once per matrix, not once per row. This is especially important for
// the 128k-row LM head where branch/pointer overhead otherwise repeats 128k times.
@inline function tensorUsesQ8Turbo(t:TensorDesc|null):bool { return q8TurboEnabled&&t!=null&&(changetype<TensorDesc>(t).type==GGML_Q4_K||changetype<TensorDesc>(t).type==GGML_Q6_K); }
function prepareSharedQ8(xv:Float32Array,cols:i32,a:TensorDesc|null,b:TensorDesc|null,c:TensorDesc|null=null):bool {
  if(cols%256!=0||!(tensorUsesQ8Turbo(a)||tensorUsesQ8Turbo(b)||tensorUsesQ8Turbo(c)))return false;
  let qt=now_ms(),ok=quantizeActivationQ8K(xv,cols);perfQ8QuantMs+=now_ms()-qt;return ok;
}

function selfTestFusedBatchKernels():bool {
  let ok:bool=true,foundQ4:bool=false,foundQ6:bool=false,count:i32=PREFILL_BATCH_MAX;
  for(let ti:i32=0;ti<tensors.length;ti++){
    let td=unchecked(tensors[ti]);if((td.type!=GGML_Q4_K&&td.type!=GGML_Q6_K)||td.ne0<=0||td.ne0><i64>cfg.dim||td.ne0%256!=0)continue;let n=<i32>td.ne0;
    for(let lane:i32=0;lane<count;lane++){let a=unchecked(bnorm[lane]);for(let i:i32=0;i<n;i++)unchecked(a[i]=<f32>(((i+lane*7)%47)-23)*0.017);if(!quantizeBatchLane(a,n,lane))return false;}
    if(td.type==GGML_Q4_K)dotQ4KQ8BatchMulti(td.ptr,n,count);else dotQ6KQ8BatchMulti(td.ptr,n,count);
    let pass:bool=true;for(let lane:i32=0;lane<count;lane++){let fused=unchecked(batchDotOut[lane]),ref=td.type==GGML_Q4_K?dotQ4KQ8Batch(td.ptr,n,lane):dotQ6KQ8Batch(td.ptr,n,lane),rel=<f32>Math.abs(<f64>(fused-ref))/<f32>Math.max(1.0,Math.abs(<f64>ref));if(rel>=0.00001)pass=false;}ok=ok&&pass;
    logSerial("SELFTEST FUSED "+typeName(td.type)+"xQ8_K lanes="+count.toString()+" "+(pass?"PASS":"FAIL")+" tensor="+td.name);
    if(td.type==GGML_Q4_K)foundQ4=true;else foundQ6=true;if(foundQ4&&foundQ6)break;
  }
  if(!foundQ4)logSerial("SELFTEST FUSED Q4_K SKIP (no dim-compatible tensor)");if(!foundQ6)logSerial("SELFTEST FUSED Q6_K SKIP (no dim-compatible tensor)");return ok;
}

function selfTestExpandedQuantCompatibility():bool {
  let ok:bool=true,foundQ2:bool=false,foundQ3:bool=false;
  for(let ti:i32=0;ti<tensors.length;ti++){
    let td=unchecked(tensors[ti]);
    if((td.type!=GGML_Q2_K&&td.type!=GGML_Q3_K)||td.ne1<=0||td.ne0<=0||td.ne0><i64>norm.length||td.ne0%256!=0)continue;
    let n=<i32>td.ne0;
    for(let i:i32=0;i<n;i++)unchecked(norm[i]=<f32>((i%53)-26)*0.0137);
    let direct:f32=td.type==GGML_Q2_K?dotQ2K(td.ptr,norm,0,n):dotQ3K(td.ptr,norm,0,n);
    if(!decodeTensorRow(td,0,x,n)){logSerial("SELFTEST "+typeName(td.type)+" FAIL decode row");return false;}
    let ref:f32=0.0;for(let i:i32=0;i<n;i++)ref+=unchecked(x[i])*unchecked(norm[i]);
    let rel=<f32>Math.abs(<f64>(direct-ref))/<f32>Math.max(1.0,Math.abs(<f64>ref));
    let pass=rel<0.00025;
    logSerial("SELFTEST "+typeName(td.type)+" ROW "+(pass?"PASS":"FAIL")+" ref="+formatF(ref,10)+" direct="+formatF(direct,10)+" rel="+formatF(rel,9)+" tensor="+td.name);
    ok=ok&&pass;if(td.type==GGML_Q2_K)foundQ2=true;else foundQ3=true;if(foundQ2&&foundQ3)break;
  }
  if(!foundQ2)logSerial("SELFTEST Q2_K compatibility SKIP (model has no suitable Q2_K row)");
  if(!foundQ3)logSerial("SELFTEST Q3_K compatibility SKIP (model has no suitable Q3_K row)");
  return ok;
}

function matVec(out:Float32Array,t:TensorDesc|null,xv:Float32Array,rows:i32,cols:i32,q8Prepared:bool=false):void {
  if(t==null)return;let p=t.ptr,ty=t.type,rb:i32=0;
  if(ty==GGML_Q4_0)rb=(cols/32)*18;else if(ty==GGML_Q4_1)rb=(cols/32)*20;else if(ty==GGML_Q5_0)rb=(cols/32)*22;else if(ty==GGML_Q5_1)rb=(cols/32)*24;else if(ty==GGML_Q8_0)rb=(cols/32)*34;else if(ty==GGML_Q2_K)rb=(cols/256)*84;else if(ty==GGML_Q3_K)rb=(cols/256)*110;else if(ty==GGML_Q4_K)rb=(cols/256)*144;else if(ty==GGML_Q5_K)rb=(cols/256)*176;else if(ty==GGML_Q6_K)rb=(cols/256)*210;else if(ty==GGML_Q8_K)rb=(cols/256)*292;else if(ty==GGML_F32)rb=cols*4;else if(ty==GGML_F16||ty==GGML_BF16)rb=cols*2;
  if(rb<=0)return;
  let q8Turbo=q8TurboEnabled&&(ty==GGML_Q4_K||ty==GGML_Q6_K)&&cols%256==0;
  if(q8Turbo&&!q8Prepared){let qt=now_ms();if(!quantizeActivationQ8K(xv,cols))q8Turbo=false;perfQ8QuantMs+=now_ms()-qt;}
  // IMPORTANT: tensor-type dispatch is outside the row loop. This removes a
  // long branch chain from every one of 128256 LM-head rows and every FFN row.
  if(ty==GGML_Q4_K){if(q8Turbo){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ4KQ8(p,cols));p+=<usize>rb;}}else{for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ4K(p,xv,0,cols));p+=<usize>rb;}}return;}
  if(ty==GGML_Q6_K){if(q8Turbo){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ6KQ8(p,cols));p+=<usize>rb;}}else{for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ6K(p,xv,0,cols));p+=<usize>rb;}}return;}
  if(ty==GGML_Q4_0){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ4_0(p,xv,0,cols));p+=<usize>rb;}return;}
  if(ty==GGML_Q4_1){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ4_1(p,xv,0,cols));p+=<usize>rb;}return;}
  if(ty==GGML_Q5_0){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ5_0(p,xv,0,cols));p+=<usize>rb;}return;}
  if(ty==GGML_Q5_1){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ5_1(p,xv,0,cols));p+=<usize>rb;}return;}
  if(ty==GGML_Q8_0){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ8_0(p,xv,0,cols));p+=<usize>rb;}return;}
  if(ty==GGML_Q2_K){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ2K(p,xv,0,cols));p+=<usize>rb;}return;}
  if(ty==GGML_Q3_K){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ3K(p,xv,0,cols));p+=<usize>rb;}return;}
  if(ty==GGML_Q5_K){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ5K(p,xv,0,cols));p+=<usize>rb;}return;}
  if(ty==GGML_Q8_K){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotQ8KStored(p,xv,0,cols));p+=<usize>rb;}return;}
  if(ty==GGML_F32){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotF32(p,xv,cols));p+=<usize>rb;}return;}
  if(ty==GGML_F16){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotF16(p,xv,cols));p+=<usize>rb;}return;}
  if(ty==GGML_BF16){for(let r:i32=0;r<rows;r++){unchecked(out[r]=dotBF16(p,xv,cols));p+=<usize>rb;}return;}
}

function readVector(out:Float32Array,t:TensorDesc|null,n:i32,defaultValue:f32=0.0):bool {
  if(t==null){out.fill(defaultValue);return false;}if(t.ne0!=<i64>n&&t.elements()!=<i64>n)return false;
  if(t.type==GGML_F32){for(let i:i32=0;i<n;i++)unchecked(out[i]=load<f32>(t.ptr+<usize>(i*4)));return true;}
  if(t.type==GGML_F16){for(let i:i32=0;i<n;i++)unchecked(out[i]=fp16ToF32(load<u16>(t.ptr+<usize>(i*2))));return true;}
  if(t.type==GGML_BF16){for(let i:i32=0;i<n;i++)unchecked(out[i]=bf16ToF32(load<u16>(t.ptr+<usize>(i*2))));return true;}
  // General quantized vector path via basis chunks is deliberately rejected for 1-D norms/biases.
  return false;
}
function rmsNorm(out:Float32Array,x:Float32Array,w:Float32Array,n:i32,eps:f32):void {
  let xp=changetype<usize>(x.dataStart),wp=changetype<usize>(w.dataStart),op=changetype<usize>(out.dataStart),acc=v128.splat<f32>(0.0),i:i32=0;
  for(;i+3<n;i+=4){let xv=v128.load(xp+<usize>(i*4));acc=v128.add<f32>(acc,v128.mul<f32>(xv,xv));}
  let ss=hsumF32x4(acc);for(;i<n;i++){let z=unchecked(x[i]);ss+=z*z;}
  let inv=<f32>(1.0/Math.sqrt(<f64>(ss/<f32>n+eps))),iv=v128.splat<f32>(inv);i=0;
  for(;i+3<n;i+=4){let xv=v128.load(xp+<usize>(i*4)),wv=v128.load(wp+<usize>(i*4));v128.store(op+<usize>(i*4),v128.mul<f32>(v128.mul<f32>(xv,iv),wv));}
  for(;i<n;i++)unchecked(out[i]=unchecked(x[i])*inv*unchecked(w[i]));
}
function addInPlace(a:Float32Array,b:Float32Array,n:i32):void {
  let ap=changetype<usize>(a.dataStart),bp=changetype<usize>(b.dataStart),i:i32=0;
  for(;i+3<n;i+=4)v128.store(ap+<usize>(i*4),v128.add<f32>(v128.load(ap+<usize>(i*4)),v128.load(bp+<usize>(i*4))));
  for(;i<n;i++)unchecked(a[i]=unchecked(a[i])+unchecked(b[i]));
}
function addBias(a:Float32Array,b:Float32Array,n:i32):void {if(b.length<n)return;let ap=changetype<usize>(a.dataStart),bp=changetype<usize>(b.dataStart),i:i32=0;for(;i+3<n;i+=4)v128.store(ap+<usize>(i*4),v128.add<f32>(v128.load(ap+<usize>(i*4)),v128.load(bp+<usize>(i*4))));for(;i<n;i++)unchecked(a[i]=unchecked(a[i])+unchecked(b[i]));}
function siluMul(gate:Float32Array,up:Float32Array,n:i32):void {for(let i:i32=0;i<n;i++){let g=unchecked(gate[i]);unchecked(gate[i]=(g/<f32>(1.0+Math.exp(<f64>-g)))*unchecked(up[i]));}}

// =============================================================================
// COMPILED EXECUTION GRAPH
// =============================================================================
class Layer {
  attnNorm:TensorDesc|null=null;q:TensorDesc|null=null;k:TensorDesc|null=null;v:TensorDesc|null=null;o:TensorDesc|null=null;
  qBias:TensorDesc|null=null;kBias:TensorDesc|null=null;vBias:TensorDesc|null=null;
  ffnNorm:TensorDesc|null=null;gate:TensorDesc|null=null;up:TensorDesc|null=null;down:TensorDesc|null=null;
  attnNormW:Float32Array=new Float32Array(0);ffnNormW:Float32Array=new Float32Array(0);qB:Float32Array=new Float32Array(0);kB:Float32Array=new Float32Array(0);vB:Float32Array=new Float32Array(0);
}
const layers:Layer[]=new Array<Layer>(0);
let tokEmb:TensorDesc|null=null,outNorm:TensorDesc|null=null,lmHead:TensorDesc|null=null,ropeFreqTensor:TensorDesc|null=null;
let outputNormW:Float32Array=new Float32Array(0);

function T(name:string):TensorDesc|null {return tensorMap.has(name)?tensorMap.get(name):null;}
function requireTensor(name:string):TensorDesc|null {let t=T(name);if(t==null)model.validationError="Missing required tensor: "+name;return t;}
function qBlockSize(t:i32):i32 { if(t==GGML_Q4_0||t==GGML_Q4_1||t==GGML_Q5_0||t==GGML_Q5_1||t==GGML_Q8_0)return 32; if(t==GGML_Q2_K||t==GGML_Q3_K||t==GGML_Q4_K||t==GGML_Q5_K||t==GGML_Q6_K||t==GGML_Q8_K)return 256; return 1; }
function matrixOk(t:TensorDesc|null,cols:i32,rows:i32,label:string):bool { if(t==null)return false; if(t.ne0!=<i64>cols||t.ne1!=<i64>rows){model.validationError="Shape mismatch "+label+" got ["+t.ne0.toString()+"x"+t.ne1.toString()+"] expected ["+cols.toString()+"x"+rows.toString()+"]";return false;} let bs=qBlockSize(t.type); if(bs>1&&cols%bs!=0){model.validationError="Quant row misaligned "+label+" type="+typeName(t.type)+" cols="+cols.toString();return false;} return true;}
function compileGraph():bool {
  layers.length=0;tokEmb=requireTensor("token_embd.weight");outNorm=requireTensor("output_norm.weight");lmHead=T("output.weight");if(lmHead==null)lmHead=tokEmb;
  ropeFreqTensor=T("rope_freqs.weight");
  if(tokEmb==null||outNorm==null||lmHead==null)return false;
  if(!matrixOk(tokEmb,cfg.dim,cfg.vocabSize,"token_embd.weight")||!matrixOk(lmHead,cfg.dim,cfg.vocabSize,"output.weight"))return false;
  outputNormW=new Float32Array(cfg.dim);if(!readVector(outputNormW,outNorm,cfg.dim,1.0)){model.validationError="output_norm.weight must be F32/F16/BF16 vector";return false;}
  for(let l:i32=0;l<cfg.nLayers;l++){
    let p="blk."+l.toString()+".";let x=new Layer();
    x.attnNorm=requireTensor(p+"attn_norm.weight");x.q=requireTensor(p+"attn_q.weight");x.k=requireTensor(p+"attn_k.weight");x.v=requireTensor(p+"attn_v.weight");x.o=requireTensor(p+"attn_output.weight");
    x.ffnNorm=requireTensor(p+"ffn_norm.weight");x.gate=requireTensor(p+"ffn_gate.weight");x.up=requireTensor(p+"ffn_up.weight");x.down=requireTensor(p+"ffn_down.weight");
    if(x.attnNorm==null||x.q==null||x.k==null||x.v==null||x.o==null||x.ffnNorm==null||x.gate==null||x.up==null||x.down==null)return false;
    if(!matrixOk(x.q,cfg.dim,cfg.nHeads*cfg.headDim,p+"attn_q.weight")||!matrixOk(x.k,cfg.dim,cfg.nKvHeads*cfg.headDim,p+"attn_k.weight")||!matrixOk(x.v,cfg.dim,cfg.nKvHeads*cfg.headDim,p+"attn_v.weight")||!matrixOk(x.o,cfg.nHeads*cfg.headDim,cfg.dim,p+"attn_output.weight")||!matrixOk(x.gate,cfg.dim,cfg.hiddenDim,p+"ffn_gate.weight")||!matrixOk(x.up,cfg.dim,cfg.hiddenDim,p+"ffn_up.weight")||!matrixOk(x.down,cfg.hiddenDim,cfg.dim,p+"ffn_down.weight"))return false;
    x.qBias=T(p+"attn_q.bias");x.kBias=T(p+"attn_k.bias");x.vBias=T(p+"attn_v.bias");
    x.attnNormW=new Float32Array(cfg.dim);x.ffnNormW=new Float32Array(cfg.dim);if(!readVector(x.attnNormW,x.attnNorm,cfg.dim,1.0)||!readVector(x.ffnNormW,x.ffnNorm,cfg.dim,1.0)){model.validationError="Layer norm vector type unsupported at layer "+l.toString();return false;}
    x.qB=new Float32Array(cfg.nHeads*cfg.headDim);x.kB=new Float32Array(cfg.nKvHeads*cfg.headDim);x.vB=new Float32Array(cfg.nKvHeads*cfg.headDim);
    if(x.qBias!=null&&!readVector(x.qB,x.qBias,x.qB.length,0.0)){model.validationError="Q bias vector unsupported";return false;}if(x.kBias!=null&&!readVector(x.kB,x.kBias,x.kB.length,0.0)){model.validationError="K bias vector unsupported";return false;}if(x.vBias!=null&&!readVector(x.vB,x.vBias,x.vB.length,0.0)){model.validationError="V bias vector unsupported";return false;}
    layers.push(x);
  }
  return true;
}

// =============================================================================
// DYNAMIC RUNTIME BUFFERS / KV CACHE
// =============================================================================
let x:Float32Array=new Float32Array(0),norm:Float32Array=new Float32Array(0),q:Float32Array=new Float32Array(0),k:Float32Array=new Float32Array(0),v:Float32Array=new Float32Array(0);
let attnOut:Float32Array=new Float32Array(0),proj:Float32Array=new Float32Array(0),gate:Float32Array=new Float32Array(0),up:Float32Array=new Float32Array(0),logits:Float32Array=new Float32Array(0),scores:Float32Array=new Float32Array(0);
let kvK:Float32Array=new Float32Array(0),kvV:Float32Array=new Float32Array(0);
let ropeCos:Float32Array=new Float32Array(0),ropeSin:Float32Array=new Float32Array(0),ropeFactors:Float32Array=new Float32Array(0);
let q8KQs:Int8Array=new Int8Array(0),q8KD:Float32Array=new Float32Array(0),q8KBSums:Int16Array=new Int16Array(0);
const PREFILL_BATCH_MAX:i32=4;
let prefillBatchSize:i32=1;
let prefillAutoMode:bool=true; // Hardware result: fused B4 regressed TTFT on this CPU; AUTO starts from proven B1.
let prefillLastBatchMs:f64=0.0;
const batchDotOut:Float32Array=new Float32Array(PREFILL_BATCH_MAX);
const bx:Float32Array[]=new Array<Float32Array>(0),bnorm:Float32Array[]=new Array<Float32Array>(0),bq:Float32Array[]=new Array<Float32Array>(0),bk:Float32Array[]=new Array<Float32Array>(0),bv:Float32Array[]=new Array<Float32Array>(0),battn:Float32Array[]=new Array<Float32Array>(0),bproj:Float32Array[]=new Array<Float32Array>(0),bgate:Float32Array[]=new Array<Float32Array>(0),bup:Float32Array[]=new Array<Float32Array>(0);
let batchQ8Qs:Int8Array=new Int8Array(0),batchQ8D:Float32Array=new Float32Array(0),batchQ8Sums:Int16Array=new Int16Array(0),batchQ8Max:i32=0,batchQ8Blocks:i32=0;
let prefillBatchedTokens:i32=0,prefillReusedTokens:i32=0,prefillComputedTokens:i32=0;
let cachedPromptIds:Int32Array=new Int32Array(0),cachedPromptLogits:Float32Array=new Float32Array(0),prefixCacheValid:bool=false;
let cachedPromptNextToken:i32=-1,cachedPromptHasLogits:bool=false;
// Greedy-head fast path state. In deterministic mode the 128K-row output matrix
// is scanned once: top token/top5/diagnostics are accumulated in-flight instead
// of writing 128K logits and scanning the array again.
let headGreedyValid:bool=false,headGreedyToken:i32=-1,headDiagValid:bool=false;
let headDiagMin:f32=0.0,headDiagMax:f32=0.0,headDiagRms:f64=0.0;
let headTopVals:Float32Array=new Float32Array(5);
let candidateIds:Int32Array=new Int32Array(128),candidateVals:Float32Array=new Float32Array(128),candidateProb:Float32Array=new Float32Array(128);
let perfEmbedMs:f64=0.0,perfQkvMs:f64=0.0,perfAttnMs:f64=0.0,perfFfnMs:f64=0.0,perfLmHeadMs:f64=0.0,perfQ8QuantMs:f64=0.0;
let q8TurboEnabled:bool=true; // runtime A/B correctness/performance gate

function allocateRuntime():bool {
  let dim=cfg.dim,hd=cfg.hiddenDim,qDim=cfg.nHeads*cfg.headDim,kvDim=cfg.nKvHeads*cfg.headDim;
  let kvFloats64=<i64>cfg.nLayers*<i64>cfg.activeContext*<i64>kvDim;
  if(kvFloats64<=<i64>0||kvFloats64><i64>350000000){logSerial("ERROR: requested KV allocation unsafe: "+kvFloats64.toString()+" floats");return false;}
  x=new Float32Array(dim);norm=new Float32Array(dim);q=new Float32Array(qDim);k=new Float32Array(kvDim);v=new Float32Array(kvDim);attnOut=new Float32Array(qDim);proj=new Float32Array(dim);gate=new Float32Array(hd);up=new Float32Array(hd);logits=new Float32Array(cfg.vocabSize);scores=new Float32Array(cfg.nHeads*cfg.activeContext);
  ropeCos=new Float32Array(cfg.headDim/2);ropeSin=new Float32Array(cfg.headDim/2);ropeFactors=new Float32Array(cfg.headDim/2);ropeFactors.fill(1.0);
  if(ropeFreqTensor!=null){
    if(!readVector(ropeFactors,ropeFreqTensor,ropeFactors.length,1.0)){logSerial("ERROR: rope_freqs.weight exists but is not a supported float vector");return false;}
    logSerial("RoPE contract: "+(cfg.architecture=="qwen2"?"NEOX half-split":"STANDARD adjacent-pair")+" + GGUF rope_freqs.weight factors, n="+ropeFactors.length.toString()+" first="+formatF(unchecked(ropeFactors[0]),7)+" last="+formatF(unchecked(ropeFactors[ropeFactors.length-1]),7));
  }else{
    logSerial("RoPE contract: "+(cfg.architecture=="qwen2"?"NEOX half-split":"STANDARD adjacent-pair")+", no factor tensor present.");
    if(cfg.architecture=="llama"&&cfg.modelContext>8192&&cfg.ropeTheta>=100000.0){logSerial("WARNING: long-context Llama has no rope_freqs.weight; positions beyond training context may be inaccurate.");}
  }
  let q8Max=maxI(dim,maxI(hd,qDim)),q8Blocks=(q8Max+255)/256;
  q8KQs=new Int8Array(q8Blocks*256);q8KD=new Float32Array(q8Blocks);q8KBSums=new Int16Array(q8Blocks*16);
  batchQ8Max=q8Blocks*256;batchQ8Blocks=q8Blocks;batchQ8Qs=new Int8Array(PREFILL_BATCH_MAX*batchQ8Max);batchQ8D=new Float32Array(PREFILL_BATCH_MAX*batchQ8Blocks);batchQ8Sums=new Int16Array(PREFILL_BATCH_MAX*batchQ8Blocks*16);
  bx.length=0;bnorm.length=0;bq.length=0;bk.length=0;bv.length=0;battn.length=0;bproj.length=0;bgate.length=0;bup.length=0;
  for(let bi:i32=0;bi<PREFILL_BATCH_MAX;bi++){bx.push(new Float32Array(dim));bnorm.push(new Float32Array(dim));bq.push(new Float32Array(qDim));bk.push(new Float32Array(kvDim));bv.push(new Float32Array(kvDim));battn.push(new Float32Array(qDim));bproj.push(new Float32Array(dim));bgate.push(new Float32Array(hd));bup.push(new Float32Array(hd));}
  cachedPromptLogits=new Float32Array(cfg.vocabSize);cachedPromptIds=new Int32Array(0);prefixCacheValid=false;
  penaltyEpoch=new Int32Array(cfg.vocabSize);
  kvK=new Float32Array(<i32>kvFloats64);kvV=new Float32Array(<i32>kvFloats64);
  resetConversation();return true;
}
@inline function kvIndex(layer:i32,absolutePos:i32,kvHead:i32,d:i32):i32 {let slot=absolutePos%cfg.activeContext;let kvDim=cfg.nKvHeads*cfg.headDim;return (layer*cfg.activeContext+slot)*kvDim+kvHead*cfg.headDim+d;}

function prepareRope(pos:i32):void {
  let hd=cfg.headDim,half=hd/2;let ropePos=<f64>pos;
  if(cfg.ropeScalingType=="linear"&&cfg.ropeScalingFactor>1.0)ropePos/=<f64>cfg.ropeScalingFactor;
  // GGUF Llama uses STANDARD RoPE. rope_freqs.weight stores frequency DIVISORS
  // (Llama-3 long-context scaling factors), so angle = pos * base_freq / factor.
  for(let i:i32=0;i<half;i++){
    let freq=1.0/Math.pow(<f64>cfg.ropeTheta,<f64>(i*2)/<f64>hd);
    let factor=ropeFactors.length>i?<f64>unchecked(ropeFactors[i]):1.0;if(factor<=0.0)factor=1.0;
    let a=ropePos*freq/factor;unchecked(ropeCos[i]=<f32>Math.cos(a));unchecked(ropeSin[i]=<f32>Math.sin(a));
  }
}
@inline function applyRopeArrays(qa:Float32Array,ka:Float32Array):void {
  let hd=cfg.headDim,half=hd/2;
  if(cfg.architecture=="qwen2"){
    // Qwen/Qwen2 use GGML NeoX RoPE ordering: i <-> i+half.
    for(let h:i32=0;h<cfg.nHeads;h++){let o=h*hd;for(let i:i32=0;i<half;i++){let c=unchecked(ropeCos[i]),sn=unchecked(ropeSin[i]),a0=unchecked(qa[o+i]),a1=unchecked(qa[o+i+half]);unchecked(qa[o+i]=a0*c-a1*sn);unchecked(qa[o+i+half]=a0*sn+a1*c);}}
    for(let h:i32=0;h<cfg.nKvHeads;h++){let o=h*hd;for(let i:i32=0;i<half;i++){let c=unchecked(ropeCos[i]),sn=unchecked(ropeSin[i]),a0=unchecked(ka[o+i]),a1=unchecked(ka[o+i+half]);unchecked(ka[o+i]=a0*c-a1*sn);unchecked(ka[o+i+half]=a0*sn+a1*c);}}
  }else{
    for(let h:i32=0;h<cfg.nHeads;h++){let o=h*hd;for(let i:i32=0;i<half;i++){let j=i*2,c=unchecked(ropeCos[i]),sn=unchecked(ropeSin[i]),a0=unchecked(qa[o+j]),a1=unchecked(qa[o+j+1]);unchecked(qa[o+j]=a0*c-a1*sn);unchecked(qa[o+j+1]=a0*sn+a1*c);}}
    for(let h:i32=0;h<cfg.nKvHeads;h++){let o=h*hd;for(let i:i32=0;i<half;i++){let j=i*2,c=unchecked(ropeCos[i]),sn=unchecked(ropeSin[i]),a0=unchecked(ka[o+j]),a1=unchecked(ka[o+j+1]);unchecked(ka[o+j]=a0*c-a1*sn);unchecked(ka[o+j+1]=a0*sn+a1*c);}}
  }
}
@inline function applyRopePrepared():void { applyRopeArrays(q,k); }

function attention(layer:i32,pos:i32):void {
  let hd=cfg.headDim,group=cfg.nHeads/cfg.nKvHeads,ctx=cfg.activeContext,kvDim=cfg.nKvHeads*hd;
  let scale=<f32>(1.0/Math.sqrt(<f64>hd));let window=ctx;if(cfg.slidingWindow>0&&cfg.slidingWindow<window)window=cfg.slidingWindow;let start=pos-window+1;if(start<0)start=0;let count=pos-start+1;
  let slot=pos%ctx,layerSlotBase=(layer*ctx+slot)*kvDim,kp=changetype<usize>(k.dataStart),vp=changetype<usize>(v.dataStart),kkp=changetype<usize>(kvK.dataStart),kvp=changetype<usize>(kvV.dataStart);
  for(let kh:i32=0;kh<cfg.nKvHeads;kh++){let src=kh*hd,dst=layerSlotBase+kh*hd,d:i32=0;for(;d+3<hd;d+=4){v128.store(kkp+<usize>((dst+d)*4),v128.load(kp+<usize>((src+d)*4)));v128.store(kvp+<usize>((dst+d)*4),v128.load(vp+<usize>((src+d)*4)));}for(;d<hd;d++){unchecked(kvK[dst+d]=unchecked(k[src+d]));unchecked(kvV[dst+d]=unchecked(v[src+d]));}}
  let qp=changetype<usize>(q.dataStart),op=changetype<usize>(attnOut.dataStart);
  for(let h:i32=0;h<cfg.nHeads;h++){
    let kh=h/group,qo=h*hd,so=h*ctx,mx:f32=-3.4e38;
    for(let tt:i32=0;tt<count;tt++){let ap=start+tt,tslot=ap%ctx,kb=(layer*ctx+tslot)*kvDim+kh*hd,acc=v128.splat<f32>(0.0),d:i32=0;for(;d+3<hd;d+=4)acc=v128.add<f32>(acc,v128.mul<f32>(v128.load(qp+<usize>((qo+d)*4)),v128.load(kkp+<usize>((kb+d)*4))));let dot=hsumF32x4(acc);for(;d<hd;d++)dot+=unchecked(q[qo+d])*unchecked(kvK[kb+d]);let sv=dot*scale;unchecked(scores[so+tt]=sv);if(sv>mx)mx=sv;}
    let sum:f64=0.0;for(let tt:i32=0;tt<count;tt++){let e=<f32>Math.exp(<f64>(unchecked(scores[so+tt])-mx));unchecked(scores[so+tt]=e);sum+=e;}let inv=<f32>(1.0/sum),d:i32=0;for(;d+3<hd;d+=4)v128.store(op+<usize>((qo+d)*4),v128.splat<f32>(0.0));for(;d<hd;d++)unchecked(attnOut[qo+d]=0.0);
    for(let tt:i32=0;tt<count;tt++){let wt=unchecked(scores[so+tt])*inv,wv=v128.splat<f32>(wt),ap=start+tt,tslot=ap%ctx,vb=(layer*ctx+tslot)*kvDim+kh*hd;d=0;for(;d+3<hd;d+=4){let dst=op+<usize>((qo+d)*4);v128.store(dst,v128.add<f32>(v128.load(dst),v128.mul<f32>(wv,v128.load(kvp+<usize>((vb+d)*4)))));}for(;d<hd;d++)unchecked(attnOut[qo+d]=unchecked(attnOut[qo+d])+wt*unchecked(kvV[vb+d]));}
  }
}

function decodeTensorRow(t:TensorDesc,row:i32,out:Float32Array,cols:i32):bool {
  if(out.length<cols||row<0)return false;
  if(t.type==GGML_F32){let p=t.ptr+<usize>row*<usize>cols*4;for(let i:i32=0;i<cols;i++)unchecked(out[i]=load<f32>(p+<usize>(i*4)));return true;}
  if(t.type==GGML_F16){let p=t.ptr+<usize>row*<usize>cols*2;for(let i:i32=0;i<cols;i++)unchecked(out[i]=fp16ToF32(load<u16>(p+<usize>(i*2))));return true;}
  if(t.type==GGML_BF16){let p=t.ptr+<usize>row*<usize>cols*2;for(let i:i32=0;i<cols;i++)unchecked(out[i]=bf16ToF32(load<u16>(p+<usize>(i*2))));return true;}
  if(t.type==GGML_Q4_0){let p=t.ptr+<usize>row*<usize>((cols/32)*18),oi:i32=0;for(let b:i32=0;b<cols/32;b++){let d=fp16ToF32(load<u16>(p));p+=2;for(let j:i32=0;j<16;j++){let z=load<u8>(p+<usize>j);unchecked(out[oi+j]=d*<f32>((<i32>(z&15))-8));unchecked(out[oi+j+16]=d*<f32>((<i32>(z>>4))-8));}p+=16;oi+=32;}return true;}
  if(t.type==GGML_Q4_1){let p=t.ptr+<usize>row*<usize>((cols/32)*20),oi:i32=0;for(let b:i32=0;b<cols/32;b++){let d=fp16ToF32(load<u16>(p)),m=fp16ToF32(load<u16>(p+2));p+=4;for(let j:i32=0;j<16;j++){let z=load<u8>(p+<usize>j);unchecked(out[oi+j]=d*<f32>(z&15)+m);unchecked(out[oi+j+16]=d*<f32>(z>>4)+m);}p+=16;oi+=32;}return true;}
  if(t.type==GGML_Q5_0){let p=t.ptr+<usize>row*<usize>((cols/32)*22),oi:i32=0;for(let b:i32=0;b<cols/32;b++){let d=fp16ToF32(load<u16>(p)),qh=load<u32>(p+2),qs=p+6;for(let j:i32=0;j<16;j++){let z=load<u8>(qs+<usize>j);let a=(<i32>(z&15)|(<i32>((qh>>j)&1)<<4))-16,c=(<i32>(z>>4)|(<i32>((qh>>(j+16))&1)<<4))-16;unchecked(out[oi+j]=d*<f32>a);unchecked(out[oi+j+16]=d*<f32>c);}p+=22;oi+=32;}return true;}
  if(t.type==GGML_Q5_1){let p=t.ptr+<usize>row*<usize>((cols/32)*24),oi:i32=0;for(let b:i32=0;b<cols/32;b++){let d=fp16ToF32(load<u16>(p)),m=fp16ToF32(load<u16>(p+2)),qh=load<u32>(p+4),qs=p+8;for(let j:i32=0;j<16;j++){let z=load<u8>(qs+<usize>j);let a=<i32>(z&15)|(<i32>((qh>>j)&1)<<4),c=<i32>(z>>4)|(<i32>((qh>>(j+16))&1)<<4);unchecked(out[oi+j]=d*<f32>a+m);unchecked(out[oi+j+16]=d*<f32>c+m);}p+=24;oi+=32;}return true;}
  if(t.type==GGML_Q8_0){let p=t.ptr+<usize>row*<usize>((cols/32)*34),oi:i32=0;for(let b:i32=0;b<cols/32;b++){let d=fp16ToF32(load<u16>(p));p+=2;for(let j:i32=0;j<32;j++)unchecked(out[oi+j]=d*<f32>load<i8>(p+<usize>j));p+=32;oi+=32;}return true;}
  if(t.type==GGML_Q2_K){if(cols%256!=0)return false;let p=t.ptr+<usize>row*<usize>((cols/256)*84),oi:i32=0;for(let b:i32=0;b<cols/256;b++){let scales=p,qs=p+16,d=fp16ToF32(load<u16>(p+80)),dm=fp16ToF32(load<u16>(p+82)),is:i32=0;for(let half:i32=0;half<2;half++){let qp=qs+<usize>(half*32);for(let sh:i32=0;sh<=6;sh+=2){let sc0=load<u8>(scales+<usize>is);is++;let dl0=d*<f32>(sc0&15),ml0=dm*<f32>(sc0>>4);for(let l:i32=0;l<16;l++)unchecked(out[oi++]=dl0*<f32>((load<u8>(qp+<usize>l)>>sh)&3)-ml0);let sc1=load<u8>(scales+<usize>is);is++;let dl1=d*<f32>(sc1&15),ml1=dm*<f32>(sc1>>4);for(let l:i32=0;l<16;l++)unchecked(out[oi++]=dl1*<f32>((load<u8>(qp+<usize>(l+16))>>sh)&3)-ml1);}}p+=84;}return true;}
  if(t.type==GGML_Q3_K){if(cols%256!=0)return false;let p=t.ptr+<usize>row*<usize>((cols/256)*110),oi:i32=0,km1:u32=0x03030303,km2:u32=0x0f0f0f0f;for(let b:i32=0;b<cols/256;b++){let hm=p,qs=p+32,sp=p+96,d=fp16ToF32(load<u16>(p+108)),o0=load<u32>(sp),o1=load<u32>(sp+4),tmp=load<u32>(sp+8);let a2=((o0>>4)&km2)|(((tmp>>4)&km1)<<4),a3=((o1>>4)&km2)|(((tmp>>6)&km1)<<4),a0=(o0&km2)|(((tmp>>0)&km1)<<4),a1=(o1&km2)|(((tmp>>2)&km1)<<4),is:i32=0,m:u8=1;for(let half:i32=0;half<2;half++){let qp=qs+<usize>(half*32),shift:i32=0;for(let j:i32=0;j<4;j++){let dl0=d*<f32>q3ScaleByte(a0,a1,a2,a3,is);is++;for(let l:i32=0;l<16;l++){let qv=<i32>((load<u8>(qp+<usize>l)>>shift)&3)-((load<u8>(hm+<usize>l)&m)!=0?0:4);unchecked(out[oi++]=dl0*<f32>qv);}let dl1=d*<f32>q3ScaleByte(a0,a1,a2,a3,is);is++;for(let l:i32=0;l<16;l++){let qv=<i32>((load<u8>(qp+<usize>(l+16))>>shift)&3)-((load<u8>(hm+<usize>(l+16))&m)!=0?0:4);unchecked(out[oi++]=dl1*<f32>qv);}shift+=2;m<<=1;}}p+=110;}return true;}
  if(t.type==GGML_Q8_K){if(cols%256!=0)return false;let p=t.ptr+<usize>row*<usize>((cols/256)*292),oi:i32=0;for(let b:i32=0;b<cols/256;b++){let d=load<f32>(p),qp=p+4;for(let j:i32=0;j<256;j++)unchecked(out[oi++]=d*<f32>load<i8>(qp+<usize>j));p+=292;}return true;}
  if(t.type==GGML_Q4_K){if(cols%256!=0)return false;let p=t.ptr+<usize>row*<usize>((cols/256)*144),oi:i32=0;for(let b:i32=0;b<cols/256;b++){let d=fp16ToF32(load<u16>(p)),dm=fp16ToF32(load<u16>(p+2)),sc=p+4,qs=p+16,is:i32=0;for(let g:i32=0;g<4;g++){let d1=d*<f32>getScaleK4(sc,is),m1=dm*<f32>getMinK4(sc,is),d2=d*<f32>getScaleK4(sc,is+1),m2=dm*<f32>getMinK4(sc,is+1);let q0=qs+<usize>(g*32);for(let l:i32=0;l<32;l++){let z=load<u8>(q0+<usize>l);unchecked(out[oi+g*64+l]=d1*<f32>(z&15)-m1);unchecked(out[oi+g*64+32+l]=d2*<f32>(z>>4)-m2);}is+=2;}p+=144;oi+=256;}return true;}
  if(t.type==GGML_Q5_K){if(cols%256!=0)return false;let p=t.ptr+<usize>row*<usize>((cols/256)*176),oi:i32=0;for(let b:i32=0;b<cols/256;b++){let d=fp16ToF32(load<u16>(p)),dm=fp16ToF32(load<u16>(p+2)),sc=p+4,qh=p+16,qs=p+48,is:i32=0;for(let g:i32=0;g<4;g++){let d1=d*<f32>getScaleK4(sc,is),m1=dm*<f32>getMinK4(sc,is),d2=d*<f32>getScaleK4(sc,is+1),m2=dm*<f32>getMinK4(sc,is+1);let mask1=1<<(g*2),mask2=mask1<<1,q0=qs+<usize>(g*32);for(let l:i32=0;l<32;l++){let z=load<u8>(q0+<usize>l),hb=<i32>load<u8>(qh+<usize>l),a=<i32>(z&15)+((hb&mask1)!=0?16:0),c=<i32>(z>>4)+((hb&mask2)!=0?16:0);unchecked(out[oi+g*64+l]=d1*<f32>a-m1);unchecked(out[oi+g*64+32+l]=d2*<f32>c-m2);}is+=2;}p+=176;oi+=256;}return true;}
  if(t.type==GGML_Q6_K){if(cols%256!=0)return false;let p=t.ptr+<usize>row*<usize>((cols/256)*210),oi:i32=0;for(let b:i32=0;b<cols/256;b++){let ql=p,qh=p+128,sc=p+192,d=fp16ToF32(load<u16>(p+208));for(let ip:i32=0;ip<2;ip++)for(let il:i32=0;il<32;il++){let is=8*ip+il/16,z0=load<u8>(ql+<usize>(64*ip+il)),z1=load<u8>(ql+<usize>(64*ip+il+32)),h=load<u8>(qh+<usize>(32*ip+il)),base=oi+128*ip+il;let a=(<i32>(z0&15)|(<i32>((h>>0)&3)<<4))-32,b1=(<i32>(z1&15)|(<i32>((h>>2)&3)<<4))-32,c=(<i32>(z0>>4)|(<i32>((h>>4)&3)<<4))-32,e=(<i32>(z1>>4)|(<i32>((h>>6)&3)<<4))-32;unchecked(out[base]=d*<f32>load<i8>(sc+<usize>is)*<f32>a);unchecked(out[base+32]=d*<f32>load<i8>(sc+<usize>(is+2))*<f32>b1);unchecked(out[base+64]=d*<f32>load<i8>(sc+<usize>(is+4))*<f32>c);unchecked(out[base+96]=d*<f32>load<i8>(sc+<usize>(is+6))*<f32>e);}p+=210;oi+=256;}return true;}
  return false;
}
function embedToken(token:i32):bool {
  if(tokEmb==null||token<0||token>=cfg.vocabSize)return false;
  let t=tokEmb; if(t==null)return false;
  if(!decodeTensorRow(t,token,x,cfg.dim)){logSerial("ERROR: embedding row decode unsupported: "+typeName(t.type)+" dim="+cfg.dim.toString());return false;}
  return true;
}


// =============================================================================
// LAYER-SYNCHRONOUS MICRO-BATCH PREFILL
// Up to 4 prompt tokens share each matrix row while it remains hot in cache.
// Attention remains causal: each lane only reads KV positions <= its own pos.
// =============================================================================
function quantizeBatchLane(xv:Float32Array,n:i32,lane:i32):bool {
  if(n<=0||n%256!=0||lane<0||lane>=PREFILL_BATCH_MAX)return false;let blocks=n/256,qBase=lane*batchQ8Max,dBase=lane*batchQ8Blocks,sBase=lane*batchQ8Blocks*16;
  for(let b:i32=0;b<blocks;b++){let base=b*256,minv:f32=unchecked(xv[base]),maxv:f32=minv;for(let j:i32=1;j<256;j++){let z=unchecked(xv[base+j]);if(z<minv)minv=z;if(z>maxv)maxv=z;}let amax:f32=(-minv>maxv)?minv:maxv;if(amax==0.0){unchecked(batchQ8D[dBase+b]=0.0);for(let j:i32=0;j<256;j++)unchecked(batchQ8Qs[qBase+base+j]=0);for(let c:i32=0;c<16;c++)unchecked(batchQ8Sums[sBase+b*16+c]=0);continue;}let iscale:f32=-127.0/amax,d:f32=1.0/iscale;unchecked(batchQ8D[dBase+b]=d);for(let c:i32=0;c<16;c++){let sm:i32=0,cb=base+c*16;for(let j:i32=0;j<16;j++){let qi=<i32>Math.round(<f64>(unchecked(xv[cb+j])*iscale));if(qi>127)qi=127;else if(qi<-127)qi=-127;unchecked(batchQ8Qs[qBase+cb+j]=<i8>qi);sm+=qi;}unchecked(batchQ8Sums[sBase+b*16+c]=<i16>sm);}}
  return true;
}
@inline function dotQ4KQ8Batch(ptr:usize,n:i32,lane:i32):f32 {
  let sum:f32=0.0,blocks=n/256,mask=v128.splat<u8>(15),qBase=lane*batchQ8Max,dBase=lane*batchQ8Blocks,sBase=lane*batchQ8Blocks*16,qPtr=changetype<usize>(batchQ8Qs.dataStart);
  for(let b:i32=0;b<blocks;b++){let d4=fp16ToF32(load<u16>(ptr)),dm4=fp16ToF32(load<u16>(ptr+2)),scales=ptr+4,qs=ptr+16,d8=unchecked(batchQ8D[dBase+b]),qb=qBase+b*256,sb=sBase+b*16,is:i32=0;for(let g:i32=0;g<4;g++){let qp=qs+<usize>(g*32),qv0=v128.load(qp),qv1=v128.load(qp+16),lo0=v128.and(qv0,mask),lo1=v128.and(qv1,mask),hi0=v128.and(v128.shr<u8>(qv0,4),mask),hi1=v128.and(v128.shr<u8>(qv1,4),mask);let a0=v128.load(qPtr+<usize>(qb+g*64)),a1=v128.load(qPtr+<usize>(qb+g*64+16)),b0=v128.load(qPtr+<usize>(qb+g*64+32)),b1=v128.load(qPtr+<usize>(qb+g*64+48));let i1=hsumI32x4(v128.add<i32>(dotU8I8x16V(lo0,a0),dotU8I8x16V(lo1,a1))),i2=hsumI32x4(v128.add<i32>(dotU8I8x16V(hi0,b0),dotU8I8x16V(hi1,b1)));let bs1=<i32>unchecked(batchQ8Sums[sb+g*4])+<i32>unchecked(batchQ8Sums[sb+g*4+1]),bs2=<i32>unchecked(batchQ8Sums[sb+g*4+2])+<i32>unchecked(batchQ8Sums[sb+g*4+3]),sc1=getScaleK4(scales,is),mn1=getMinK4(scales,is),sc2=getScaleK4(scales,is+1),mn2=getMinK4(scales,is+1);sum+=d8*(d4*(<f32>sc1*<f32>i1+<f32>sc2*<f32>i2)-dm4*(<f32>mn1*<f32>bs1+<f32>mn2*<f32>bs2));is+=2;}ptr+=144;}return sum;
}
@inline function dotQ6KQ8Batch(ptr:usize,n:i32,lane:i32):f32 {
  let sum:f32=0.0,blocks=n/256,mask15=v128.splat<u8>(15),mask3=v128.splat<u8>(3),thirty2=v128.splat<i8>(32),qBase=lane*batchQ8Max,dBase=lane*batchQ8Blocks,qPtr=changetype<usize>(batchQ8Qs.dataStart);
  for(let b:i32=0;b<blocks;b++){let ql=ptr,qh=ptr+128,sc=ptr+192,d6=fp16ToF32(load<u16>(ptr+208)),d8=unchecked(batchQ8D[dBase+b]),qb=qBase+b*256;for(let ip:i32=0;ip<2;ip++){let qlBase=ql+<usize>(64*ip),qhBase=qh+<usize>(32*ip),xb=qb+128*ip;for(let half:i32=0;half<2;half++){let l0=half*16,is=8*ip+half,lq0=v128.load(qlBase+<usize>l0),lq1=v128.load(qlBase+<usize>(l0+32)),hv=v128.load(qhBase+<usize>l0);let a=v128.sub<i8>(v128.or(v128.and(lq0,mask15),v128.shl<u8>(v128.and(hv,mask3),4)),thirty2),b1=v128.sub<i8>(v128.or(v128.and(lq1,mask15),v128.shl<u8>(v128.and(v128.shr<u8>(hv,2),mask3),4)),thirty2),c=v128.sub<i8>(v128.or(v128.and(v128.shr<u8>(lq0,4),mask15),v128.shl<u8>(v128.and(v128.shr<u8>(hv,4),mask3),4)),thirty2),e=v128.sub<i8>(v128.or(v128.and(v128.shr<u8>(lq1,4),mask15),v128.shl<u8>(v128.and(v128.shr<u8>(hv,6),mask3),4)),thirty2);let s0=hsumI32x4(dotI8I8x16V(a,v128.load(qPtr+<usize>(xb+l0)))),s1=hsumI32x4(dotI8I8x16V(b1,v128.load(qPtr+<usize>(xb+32+l0)))),s2=hsumI32x4(dotI8I8x16V(c,v128.load(qPtr+<usize>(xb+64+l0)))),s3=hsumI32x4(dotI8I8x16V(e,v128.load(qPtr+<usize>(xb+96+l0))));sum+=d6*d8*(<f32>load<i8>(sc+<usize>(is))*<f32>s0+<f32>load<i8>(sc+<usize>(is+2))*<f32>s1+<f32>load<i8>(sc+<usize>(is+4))*<f32>s2+<f32>load<i8>(sc+<usize>(is+6))*<f32>s3);}}ptr+=210;}return sum;
}

function dotQ4KQ8BatchMulti(ptr:usize,n:i32,count:i32):void {
  for(let lane:i32=0;lane<count;lane++)unchecked(batchDotOut[lane]=0.0);
  let blocks=n/256,mask=v128.splat<u8>(15),qPtr=changetype<usize>(batchQ8Qs.dataStart);
  for(let bi:i32=0;bi<blocks;bi++){
    let d4=fp16ToF32(load<u16>(ptr)),dm4=fp16ToF32(load<u16>(ptr+2)),scales=ptr+4,qs=ptr+16,is:i32=0;
    for(let g:i32=0;g<4;g++){
      let qp=qs+<usize>(g*32),qv0=v128.load(qp),qv1=v128.load(qp+16),lo0=v128.and(qv0,mask),lo1=v128.and(qv1,mask),hi0=v128.and(v128.shr<u8>(qv0,4),mask),hi1=v128.and(v128.shr<u8>(qv1,4),mask);
      let sc1=getScaleK4(scales,is),mn1=getMinK4(scales,is),sc2=getScaleK4(scales,is+1),mn2=getMinK4(scales,is+1);
      for(let lane:i32=0;lane<count;lane++){
        let qBase=lane*batchQ8Max,dBase=lane*batchQ8Blocks,sBase=lane*batchQ8Blocks*16,qb=qBase+bi*256,sb=sBase+bi*16,d8=unchecked(batchQ8D[dBase+bi]);
        let a0=v128.load(qPtr+<usize>(qb+g*64)),a1=v128.load(qPtr+<usize>(qb+g*64+16)),b0=v128.load(qPtr+<usize>(qb+g*64+32)),b1=v128.load(qPtr+<usize>(qb+g*64+48));
        let i1=hsumI32x4(v128.add<i32>(dotU8I8x16V(lo0,a0),dotU8I8x16V(lo1,a1))),i2=hsumI32x4(v128.add<i32>(dotU8I8x16V(hi0,b0),dotU8I8x16V(hi1,b1)));
        let bs1=<i32>unchecked(batchQ8Sums[sb+g*4])+<i32>unchecked(batchQ8Sums[sb+g*4+1]),bs2=<i32>unchecked(batchQ8Sums[sb+g*4+2])+<i32>unchecked(batchQ8Sums[sb+g*4+3]);
        unchecked(batchDotOut[lane]=unchecked(batchDotOut[lane])+d8*(d4*(<f32>sc1*<f32>i1+<f32>sc2*<f32>i2)-dm4*(<f32>mn1*<f32>bs1+<f32>mn2*<f32>bs2)));
      }
      is+=2;
    }
    ptr+=144;
  }
}
function dotQ6KQ8BatchMulti(ptr:usize,n:i32,count:i32):void {
  for(let lane:i32=0;lane<count;lane++)unchecked(batchDotOut[lane]=0.0);
  let blocks=n/256,mask15=v128.splat<u8>(15),mask3=v128.splat<u8>(3),thirty2=v128.splat<i8>(32),qPtr=changetype<usize>(batchQ8Qs.dataStart);
  for(let bi:i32=0;bi<blocks;bi++){
    let ql=ptr,qh=ptr+128,sc=ptr+192,d6=fp16ToF32(load<u16>(ptr+208));
    for(let ip:i32=0;ip<2;ip++){
      let qlBase=ql+<usize>(64*ip),qhBase=qh+<usize>(32*ip);
      for(let half:i32=0;half<2;half++){
        let l0=half*16,is=8*ip+half,lq0=v128.load(qlBase+<usize>l0),lq1=v128.load(qlBase+<usize>(l0+32)),hv=v128.load(qhBase+<usize>l0);
        let a=v128.sub<i8>(v128.or(v128.and(lq0,mask15),v128.shl<u8>(v128.and(hv,mask3),4)),thirty2),b1=v128.sub<i8>(v128.or(v128.and(lq1,mask15),v128.shl<u8>(v128.and(v128.shr<u8>(hv,2),mask3),4)),thirty2),c=v128.sub<i8>(v128.or(v128.and(v128.shr<u8>(lq0,4),mask15),v128.shl<u8>(v128.and(v128.shr<u8>(hv,4),mask3),4)),thirty2),e=v128.sub<i8>(v128.or(v128.and(v128.shr<u8>(lq1,4),mask15),v128.shl<u8>(v128.and(v128.shr<u8>(hv,6),mask3),4)),thirty2);
        let sc0=<f32>load<i8>(sc+<usize>is),sc1=<f32>load<i8>(sc+<usize>(is+2)),sc2=<f32>load<i8>(sc+<usize>(is+4)),sc3=<f32>load<i8>(sc+<usize>(is+6));
        for(let lane:i32=0;lane<count;lane++){
          let qBase=lane*batchQ8Max,dBase=lane*batchQ8Blocks,qb=qBase+bi*256,xb=qb+128*ip,d8=unchecked(batchQ8D[dBase+bi]);
          let s0=hsumI32x4(dotI8I8x16V(a,v128.load(qPtr+<usize>(xb+l0)))),s1=hsumI32x4(dotI8I8x16V(b1,v128.load(qPtr+<usize>(xb+32+l0)))),s2=hsumI32x4(dotI8I8x16V(c,v128.load(qPtr+<usize>(xb+64+l0)))),s3=hsumI32x4(dotI8I8x16V(e,v128.load(qPtr+<usize>(xb+96+l0))));
          unchecked(batchDotOut[lane]=unchecked(batchDotOut[lane])+d6*d8*(sc0*<f32>s0+sc1*<f32>s1+sc2*<f32>s2+sc3*<f32>s3));
        }
      }
    }
    ptr+=210;
  }
}

function matVecBatch(outA:Float32Array[],t:TensorDesc|null,inA:Float32Array[],rows:i32,cols:i32,count:i32,prepared:bool=false):void {
  if(t==null||count<=0)return;let ty=changetype<TensorDesc>(t).type,rb:i32=0;if(ty==GGML_Q4_K)rb=(cols/256)*144;else if(ty==GGML_Q6_K)rb=(cols/256)*210;
  if(rb<=0||!q8TurboEnabled){for(let lane:i32=0;lane<count;lane++)matVec(unchecked(outA[lane]),t,unchecked(inA[lane]),rows,cols,false);return;}
  if(!prepared){for(let lane:i32=0;lane<count;lane++)quantizeBatchLane(unchecked(inA[lane]),cols,lane);}
  let p=changetype<TensorDesc>(t).ptr;
  for(let r:i32=0;r<rows;r++){
    if(ty==GGML_Q4_K)dotQ4KQ8BatchMulti(p,cols,count);else dotQ6KQ8BatchMulti(p,cols,count);
    for(let lane:i32=0;lane<count;lane++)unchecked(unchecked(outA[lane])[r]=unchecked(batchDotOut[lane]));
    p+=<usize>rb;
  }
}
function prepareBatchQ8(inA:Float32Array[],count:i32,cols:i32,a:TensorDesc|null,b:TensorDesc|null,c:TensorDesc|null=null):bool {
  if(cols%256!=0||!(tensorUsesQ8Turbo(a)||tensorUsesQ8Turbo(b)||tensorUsesQ8Turbo(c)))return false;let t=now_ms();for(let lane:i32=0;lane<count;lane++)if(!quantizeBatchLane(unchecked(inA[lane]),cols,lane))return false;perfQ8QuantMs+=now_ms()-t;return true;
}
function attentionArrays(layer:i32,pos:i32,qa:Float32Array,ka:Float32Array,va:Float32Array,outA:Float32Array):void {
  let hd=cfg.headDim,group=cfg.nHeads/cfg.nKvHeads,ctx=cfg.activeContext,kvDim=cfg.nKvHeads*hd,scale=<f32>(1.0/Math.sqrt(<f64>hd)),window=ctx;if(cfg.slidingWindow>0&&cfg.slidingWindow<window)window=cfg.slidingWindow;let start=pos-window+1;if(start<0)start=0;let count=pos-start+1,slot=pos%ctx,layerSlotBase=(layer*ctx+slot)*kvDim;
  let kap=changetype<usize>(ka.dataStart),vap=changetype<usize>(va.dataStart),kkp=changetype<usize>(kvK.dataStart),kvp=changetype<usize>(kvV.dataStart),qap=changetype<usize>(qa.dataStart),oap=changetype<usize>(outA.dataStart);
  for(let kh:i32=0;kh<cfg.nKvHeads;kh++){let src=kh*hd,dst=layerSlotBase+kh*hd,d:i32=0;for(;d+3<hd;d+=4){v128.store(kkp+<usize>((dst+d)*4),v128.load(kap+<usize>((src+d)*4)));v128.store(kvp+<usize>((dst+d)*4),v128.load(vap+<usize>((src+d)*4)));}for(;d<hd;d++){unchecked(kvK[dst+d]=unchecked(ka[src+d]));unchecked(kvV[dst+d]=unchecked(va[src+d]));}}
  for(let h:i32=0;h<cfg.nHeads;h++){let kh=h/group,qo=h*hd,so=h*ctx,mx:f32=-3.4e38;for(let tt:i32=0;tt<count;tt++){let ap=start+tt,tslot=ap%ctx,kb=(layer*ctx+tslot)*kvDim+kh*hd,acc=v128.splat<f32>(0.0),d:i32=0;for(;d+3<hd;d+=4)acc=v128.add<f32>(acc,v128.mul<f32>(v128.load(qap+<usize>((qo+d)*4)),v128.load(kkp+<usize>((kb+d)*4))));let dot=hsumF32x4(acc);for(;d<hd;d++)dot+=unchecked(qa[qo+d])*unchecked(kvK[kb+d]);let sv=dot*scale;unchecked(scores[so+tt]=sv);if(sv>mx)mx=sv;}let sm:f64=0.0;for(let tt:i32=0;tt<count;tt++){let ev=<f32>Math.exp(<f64>(unchecked(scores[so+tt])-mx));unchecked(scores[so+tt]=ev);sm+=ev;}let inv=<f32>(1.0/sm),d:i32=0;for(;d+3<hd;d+=4)v128.store(oap+<usize>((qo+d)*4),v128.splat<f32>(0.0));for(;d<hd;d++)unchecked(outA[qo+d]=0.0);for(let tt:i32=0;tt<count;tt++){let wt=unchecked(scores[so+tt])*inv,wv=v128.splat<f32>(wt),ap=start+tt,tslot=ap%ctx,vb=(layer*ctx+tslot)*kvDim+kh*hd;d=0;for(;d+3<hd;d+=4){let dst=oap+<usize>((qo+d)*4);v128.store(dst,v128.add<f32>(v128.load(dst),v128.mul<f32>(wv,v128.load(kvp+<usize>((vb+d)*4)))));}for(;d<hd;d++)unchecked(outA[qo+d]=unchecked(outA[qo+d])+wt*unchecked(kvV[vb+d]));}}
}

function forwardPrefillBatch(ids:Int32Array,startIndex:i32,count:i32,startPos:i32):bool {
  if(count<=0||count>PREFILL_BATCH_MAX)return false;let t0=now_ms();perfQkvMs=0;perfAttnMs=0;perfFfnMs=0;perfQ8QuantMs=0;
  for(let lane:i32=0;lane<count;lane++){let tok=unchecked(ids[startIndex+lane]),xx=unchecked(bx[lane]);if(tokEmb==null||!decodeTensorRow(changetype<TensorDesc>(tokEmb),tok,xx,cfg.dim))return false;}
  for(let l:i32=0;l<cfg.nLayers;l++){let L=unchecked(layers[l]),t=now_ms();for(let lane:i32=0;lane<count;lane++)rmsNorm(unchecked(bnorm[lane]),unchecked(bx[lane]),L.attnNormW,cfg.dim,cfg.normEps);let p=prepareBatchQ8(bnorm,count,cfg.dim,L.q,L.k,L.v);matVecBatch(bq,L.q,bnorm,cfg.nHeads*cfg.headDim,cfg.dim,count,p);matVecBatch(bk,L.k,bnorm,cfg.nKvHeads*cfg.headDim,cfg.dim,count,p);matVecBatch(bv,L.v,bnorm,cfg.nKvHeads*cfg.headDim,cfg.dim,count,p);for(let lane:i32=0;lane<count;lane++){addBias(unchecked(bq[lane]),L.qB,unchecked(bq[lane]).length);addBias(unchecked(bk[lane]),L.kB,unchecked(bk[lane]).length);addBias(unchecked(bv[lane]),L.vB,unchecked(bv[lane]).length);prepareRope(startPos+lane);applyRopeArrays(unchecked(bq[lane]),unchecked(bk[lane]));}perfQkvMs+=now_ms()-t;
    t=now_ms();for(let lane:i32=0;lane<count;lane++)attentionArrays(l,startPos+lane,unchecked(bq[lane]),unchecked(bk[lane]),unchecked(bv[lane]),unchecked(battn[lane]));let po=prepareBatchQ8(battn,count,cfg.nHeads*cfg.headDim,L.o,null);matVecBatch(bproj,L.o,battn,cfg.dim,cfg.nHeads*cfg.headDim,count,po);for(let lane:i32=0;lane<count;lane++)addInPlace(unchecked(bx[lane]),unchecked(bproj[lane]),cfg.dim);perfAttnMs+=now_ms()-t;
    t=now_ms();for(let lane:i32=0;lane<count;lane++)rmsNorm(unchecked(bnorm[lane]),unchecked(bx[lane]),L.ffnNormW,cfg.dim,cfg.normEps);let pf=prepareBatchQ8(bnorm,count,cfg.dim,L.gate,L.up);matVecBatch(bgate,L.gate,bnorm,cfg.hiddenDim,cfg.dim,count,pf);matVecBatch(bup,L.up,bnorm,cfg.hiddenDim,cfg.dim,count,pf);for(let lane:i32=0;lane<count;lane++)siluMul(unchecked(bgate[lane]),unchecked(bup[lane]),cfg.hiddenDim);let pd=prepareBatchQ8(bgate,count,cfg.hiddenDim,L.down,null);matVecBatch(bproj,L.down,bgate,cfg.dim,cfg.hiddenDim,count,pd);for(let lane:i32=0;lane<count;lane++)addInPlace(unchecked(bx[lane]),unchecked(bproj[lane]),cfg.dim);perfFfnMs+=now_ms()-t;
  }
  let last=count-1;for(let i:i32=0;i<cfg.dim;i++)unchecked(x[i]=unchecked(unchecked(bx[last])[i]));lastForwardMs=now_ms()-t0;prefillBatchedTokens+=count;return true;
}
function commonPrefix(a:Int32Array,b:Int32Array):i32 {let n=minI(a.length,b.length),i:i32=0;while(i<n&&unchecked(a[i])==unchecked(b[i]))i++;return i;}
function cachePrompt(ids:Int32Array,nextToken:i32):void {cachedPromptIds=new Int32Array(ids.length);for(let i:i32=0;i<ids.length;i++)unchecked(cachedPromptIds[i]=unchecked(ids[i]));cachedPromptNextToken=nextToken;cachedPromptHasLogits=!headDiagValid;if(cachedPromptHasLogits&&cachedPromptLogits.length==logits.length)for(let i:i32=0;i<logits.length;i++)unchecked(cachedPromptLogits[i]=unchecked(logits[i]));prefixCacheValid=true;}

let lastForwardMs:f64=0.0;
@inline function headInsertTop5(id:i32,z:f32):void {for(let k:i32=0;k<5;k++)if(z>unchecked(headTopVals[k])){for(let m:i32=4;m>k;m--){unchecked(headTopVals[m]=unchecked(headTopVals[m-1]));unchecked(topIds[m]=unchecked(topIds[m-1]));}unchecked(headTopVals[k]=z);unchecked(topIds[k]=id);break;}}
function computeGreedyLmHead(xv:Float32Array):bool {
  if(lmHead==null||temperature>0.05||repPenalty>1.0)return false;let t=changetype<TensorDesc>(lmHead),ty=t.type;if((ty!=GGML_Q4_K&&ty!=GGML_Q6_K)||cfg.dim%256!=0)return false;
  let qt=now_ms();if(!quantizeActivationQ8K(xv,cfg.dim))return false;perfQ8QuantMs+=now_ms()-qt;headTopVals.fill(-3.4e38);topIds.fill(-1);let p=t.ptr,rb=ty==GGML_Q4_K?(cfg.dim/256)*144:(cfg.dim/256)*210,best:i32=0,mx:f32=-3.4e38,mn:f32=3.4e38,ss:f64=0.0;
  for(let r:i32=0;r<cfg.vocabSize;r++){let z=ty==GGML_Q4_K?dotQ4KQ8(p,cfg.dim):dotQ6KQ8(p,cfg.dim);if(z>mx){mx=z;best=r;}if(z<mn)mn=z;ss+=<f64>z*<f64>z;headInsertTop5(r,z);p+=<usize>rb;}
  // UI probabilities are normalized over displayed top-5 only; decoding itself is exact argmax.
  let topMx=unchecked(headTopVals[0]),psum:f64=0.0;for(let i:i32=0;i<5;i++){let e=<f32>Math.exp(<f64>(unchecked(headTopVals[i])-topMx));unchecked(topProbs[i]=e);psum+=e;}if(psum>0.0)for(let i:i32=0;i<5;i++)unchecked(topProbs[i]=unchecked(topProbs[i])/<f32>psum);
  headGreedyToken=best;headGreedyValid=true;headDiagValid=true;headDiagMin=mn;headDiagMax=mx;headDiagRms=Math.sqrt(ss/<f64>maxI(1,cfg.vocabSize));return true;
}
function forward(token:i32,pos:i32,needLogits:bool=true):bool {
  let t0=now_ms(),t=now_ms();if(!embedToken(token))return false;perfEmbedMs=now_ms()-t;prepareRope(pos);perfQkvMs=0.0;perfAttnMs=0.0;perfFfnMs=0.0;perfQ8QuantMs=0.0;
  for(let l:i32=0;l<cfg.nLayers;l++){
    let L=unchecked(layers[l]);t=now_ms();rmsNorm(norm,x,L.attnNormW,cfg.dim,cfg.normEps);
    let qkvQ8=prepareSharedQ8(norm,cfg.dim,L.q,L.k,L.v);matVec(q,L.q,norm,cfg.nHeads*cfg.headDim,cfg.dim,qkvQ8);matVec(k,L.k,norm,cfg.nKvHeads*cfg.headDim,cfg.dim,qkvQ8);matVec(v,L.v,norm,cfg.nKvHeads*cfg.headDim,cfg.dim,qkvQ8);addBias(q,L.qB,q.length);addBias(k,L.kB,k.length);addBias(v,L.vB,v.length);applyRopePrepared();perfQkvMs+=now_ms()-t;
    t=now_ms();attention(l,pos);matVec(proj,L.o,attnOut,cfg.dim,cfg.nHeads*cfg.headDim);addInPlace(x,proj,cfg.dim);perfAttnMs+=now_ms()-t;
    t=now_ms();rmsNorm(norm,x,L.ffnNormW,cfg.dim,cfg.normEps);let ffnQ8=prepareSharedQ8(norm,cfg.dim,L.gate,L.up);matVec(gate,L.gate,norm,cfg.hiddenDim,cfg.dim,ffnQ8);matVec(up,L.up,norm,cfg.hiddenDim,cfg.dim,ffnQ8);siluMul(gate,up,cfg.hiddenDim);matVec(proj,L.down,gate,cfg.dim,cfg.hiddenDim);addInPlace(x,proj,cfg.dim);perfFfnMs+=now_ms()-t;
  }
  if(needLogits){t=now_ms();rmsNorm(norm,x,outputNormW,cfg.dim,cfg.normEps);headDiagValid=false;headGreedyValid=false;if(!computeGreedyLmHead(norm))matVec(logits,lmHead,norm,cfg.vocabSize,cfg.dim);perfLmHeadMs=now_ms()-t;}else{perfLmHeadMs=0.0;headDiagValid=false;headGreedyValid=false;}lastForwardMs=now_ms()-t0;return true;
}

// =============================================================================
// SAMPLER // correct sorted Top-K + Top-P over candidate distribution
// =============================================================================
const RECENT_CAP:i32=128;let recent:Int32Array=new Int32Array(RECENT_CAP),recentN:i32=0;
let temperature:f32=0.0,topP:f32=0.9,repPenalty:f32=1.0;let topK:i32=40;let maxNewTokens:i32=128;
// Repetition penalty must be applied once per UNIQUE recent token, never once per occurrence.
let penaltyEpoch:Int32Array=new Int32Array(0);let penaltyGeneration:i32=1;
let topIds:Int32Array=new Int32Array(5),topProbs:Float32Array=new Float32Array(5);
function pushRecent(id:i32):void{unchecked(recent[recentN%RECENT_CAP]=id);recentN++;}
function applyPenalty():void{
  if(repPenalty<=1.0)return;
  penaltyGeneration++;if(penaltyGeneration==0x7fffffff){penaltyEpoch.fill(0);penaltyGeneration=1;}
  let n=minI(recentN,RECENT_CAP);
  for(let r:i32=0;r<n;r++){
    let id=unchecked(recent[r]);if(id<0||id>=logits.length)continue;
    if(unchecked(penaltyEpoch[id])==penaltyGeneration)continue;
    unchecked(penaltyEpoch[id]=penaltyGeneration);
    // Do not distort control/special tokens.
    if(id<vocabTokens.length){let tok=unchecked(vocabTokens[id]);if(tok.startsWith("<|")&&tok.endsWith("|>"))continue;}
    let v=unchecked(logits[id]);unchecked(logits[id]=v>0?v/repPenalty:v*repPenalty);
  }
}
function argmax():i32{let id:i32=0,m=unchecked(logits[0]);for(let i:i32=1;i<logits.length;i++){let v=unchecked(logits[i]);if(v>m){m=v;id=i;}}return id;}
function logLogitDiagnostics(label:string):bool {
  if(headDiagValid){let top="";for(let k:i32=0;k<5;k++){let id=unchecked(topIds[k]),nm=id>=0&&id<vocabTokens.length?decodeToken(id):"";top+=(k>0?" | ":"")+id.toString()+":"+nm+"="+formatF(unchecked(headTopVals[k]),7);}logSerial("LOGITS "+label+" GREEDY-FUSED min="+formatF(headDiagMin,7)+" max="+formatF(headDiagMax,7)+" rms="+formatF(headDiagRms,7)+" nan=0 top5="+top);return true;}
  if(logits.length==0)return false;let nan:i32=0,mn:f32=3.4e38,mx:f32=-3.4e38,ss:f64=0.0;let ids=new Int32Array(5),vals=new Float32Array(5);vals.fill(-3.4e38);
  for(let i:i32=0;i<logits.length;i++){let z=unchecked(logits[i]);if(z!=z){nan++;continue;}if(z<mn)mn=z;if(z>mx)mx=z;ss+=<f64>z*<f64>z;for(let k:i32=0;k<5;k++)if(z>unchecked(vals[k])){for(let m:i32=4;m>k;m--){unchecked(vals[m]=unchecked(vals[m-1]));unchecked(ids[m]=unchecked(ids[m-1]));}unchecked(vals[k]=z);unchecked(ids[k]=i);break;}}
  let top="";for(let k:i32=0;k<5;k++){let id=unchecked(ids[k]),nm=id<vocabTokens.length?decodeToken(id):"";top+=(k>0?" | ":"")+id.toString()+":"+nm+"="+formatF(unchecked(vals[k]),7);}
  logSerial("LOGITS "+label+" min="+formatF(mn,7)+" max="+formatF(mx,7)+" rms="+formatF(Math.sqrt(ss/<f64>maxI(1,logits.length)),7)+" nan="+nan.toString()+" top5="+top);return nan==0;
}
@inline function heapSwap(a:i32,b:i32):void {let tv=unchecked(candidateVals[a]),ti=unchecked(candidateIds[a]);unchecked(candidateVals[a]=unchecked(candidateVals[b]));unchecked(candidateIds[a]=unchecked(candidateIds[b]));unchecked(candidateVals[b]=tv);unchecked(candidateIds[b]=ti);}
function heapUp(i:i32):void {while(i>0){let p=(i-1)>>1;if(unchecked(candidateVals[p])<=unchecked(candidateVals[i]))break;heapSwap(p,i);i=p;}}
function heapDown(i:i32,n:i32):void {while(true){let l=i*2+1;if(l>=n)break;let r=l+1,m=l;if(r<n&&unchecked(candidateVals[r])<unchecked(candidateVals[l]))m=r;if(unchecked(candidateVals[i])<=unchecked(candidateVals[m]))break;heapSwap(i,m);i=m;}}
function sampleNext():i32 {
  if(temperature<=0.05&&repPenalty<=1.0&&headGreedyValid){let id=headGreedyToken;headGreedyValid=false;return id;}
  applyPenalty();if(temperature<=0.05)return argmax();let kN=clampI(topK,1,128);if(kN>cfg.vocabSize)kN=cfg.vocabSize;
  let hn:i32=0;
  for(let i:i32=0;i<cfg.vocabSize;i++){let val=unchecked(logits[i]);if(hn<kN){unchecked(candidateVals[hn]=val);unchecked(candidateIds[hn]=i);heapUp(hn);hn++;}else if(val>unchecked(candidateVals[0])){unchecked(candidateVals[0]=val);unchecked(candidateIds[0]=i);heapDown(0,hn);}}
  // Sort only the <=128 selected candidates descending.
  for(let i:i32=1;i<hn;i++){let vv=unchecked(candidateVals[i]),ii=unchecked(candidateIds[i]),j=i-1;while(j>=0&&unchecked(candidateVals[j])<vv){unchecked(candidateVals[j+1]=unchecked(candidateVals[j]));unchecked(candidateIds[j+1]=unchecked(candidateIds[j]));j--;}unchecked(candidateVals[j+1]=vv);unchecked(candidateIds[j+1]=ii);}
  let mx=unchecked(candidateVals[0])/temperature,sum:f64=0.0;for(let i:i32=0;i<hn;i++){let e=<f32>Math.exp(<f64>(unchecked(candidateVals[i])/temperature-mx));unchecked(candidateProb[i]=e);sum+=e;}let inv=<f32>(1.0/sum);for(let i:i32=0;i<hn;i++)unchecked(candidateProb[i]=unchecked(candidateProb[i])*inv);
  for(let i:i32=0;i<5;i++){if(i<hn){unchecked(topIds[i]=unchecked(candidateIds[i]));unchecked(topProbs[i]=unchecked(candidateProb[i]));}}
  let nucleus:f32=clampF(topP,0.01,1.0),cum:f32=0.0,limit:i32=hn;for(let i:i32=0;i<hn;i++){cum+=unchecked(candidateProb[i]);if(cum>=nucleus){limit=i+1;break;}}
  let normP:f32=0.0;for(let i:i32=0;i<limit;i++)normP+=unchecked(candidateProb[i]);let r=<f32>random_f64()*normP,c:f32=0.0;for(let i:i32=0;i<limit;i++){c+=unchecked(candidateProb[i]);if(r<=c)return unchecked(candidateIds[i]);}return unchecked(candidateIds[0]);
}

// =============================================================================
// GENERATION / CONVERSATION STATE
// =============================================================================
const ENGINE_NO_MODEL:i32=0,ENGINE_READY:i32=1,ENGINE_PREFILL:i32=2,ENGINE_GENERATING:i32=3,ENGINE_COMPLETE:i32=4,ENGINE_ERROR:i32=-1;
let engineState:i32=ENGINE_NO_MODEL;
let absolutePos:i32=0,pendingToken:i32=-1,generated:i32=0;
let promptText:string="Explain why WebAssembly can execute numerical kernels efficiently.";
let responseText:string="";
let currentAnswer:string="";
let statusText:string="AWAITING GGUF MODEL";
let inputFocused:bool=true,inputCursor:i32=promptText.length,inputScroll:i32=0;
let totalGenMs:f64=0.0,ttftMs:f64=0.0,prefillTps:f64=0.0,tps:f64=0.0;
let generationOwnerRequest:i32=-1;
let stopRequested:bool=false;

function autoTemplate(user:string,first:bool):string {
  if(cfg.architecture=="qwen2"||tokenToId.has("<|im_start|>")){
    let sys=first?"<|im_start|>system\nYou are a helpful AI assistant.<|im_end|>\n":"";
    return sys+"<|im_start|>user\n"+user+"<|im_end|>\n<|im_start|>assistant\n";
  }
  if(tokenToId.has("<|start_header_id|>")){
    let bos=first&&tokenToId.has("<|begin_of_text|>")?"<|begin_of_text|>":"";
    return bos+"<|start_header_id|>user<|end_header_id|>\n\n"+user+"<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n";
  }
  return first?user:("\nUser: "+user+"\nAssistant: ");
}
function resetConversation():void {absolutePos=0;pendingToken=-1;generated=0;recentN=0;responseText="";currentAnswer="";totalGenMs=0;ttftMs=0;prefillTps=0;tps=0;utf8PendingCount=0;generationOwnerRequest=-1;stopRequested=false;if(model.loaded)engineState=ENGINE_READY;}
let generationJsonMode:bool=false,generationPromptTokens:i32=0;
function beginGeneration(prompt:string,requestId:i32=-1,preformatted:bool=false,jsonMode:bool=false):bool {
  if(!model.loaded||loadState!=LOAD_READY||engineState==ENGINE_GENERATING||engineState==ENGINE_PREFILL)return false;
  stopRequested=false;generated=0;currentAnswer="";totalGenMs=0;generationJsonMode=jsonMode;let first=absolutePos==0;let formatted=preformatted?prompt:autoTemplate(prompt,first),explicitBos=formatted.startsWith("<|begin_of_text|>")||formatted.startsWith("<s>");let ids=tokenize(formatted,first&&cfg.addBos&&!explicitBos);generationPromptTokens=ids.length;
  if(ids.length==0){statusText="TOKENIZER PRODUCED NO TOKENS";return false;}
  let idPreview="",previewN=minI(32,ids.length);for(let pi:i32=0;pi<previewN;pi++){if(pi>0)idPreview+=",";idPreview+=unchecked(ids[pi]).toString();}
  let t0=now_ms();engineState=ENGINE_PREFILL;statusText="PREFILL "+ids.length.toString()+" TOKENS";prefillReusedTokens=0;prefillComputedTokens=0;prefillBatchedTokens=0;
  let effectiveBatch=prefillAutoMode?1:prefillBatchSize;logSerial("PREFILL begin tokens="+ids.length.toString()+" pos="+absolutePos.toString()+" owner="+requestId.toString()+" policy="+(prefillAutoMode?"AUTO/B1":"MANUAL/B"+effectiveBatch.toString())+" ids=["+idPreview+"]");
  responseText+=(responseText.length?"\n\n":"")+(preformatted?"[SERVICE CHAT]\n[ASSISTANT]: ":"[USER]: "+prompt+"\n[ASSISTANT]: ");
  let startToken:i32=0;
  let typedIds=new Int32Array(ids.length);for(let i:i32=0;i<ids.length;i++)typedIds[i]=ids[i];if(first&&prefixCacheValid&&cachedPromptIds.length>0){let lcp=commonPrefix(typedIds,cachedPromptIds);if(lcp>=ids.length&&cachedPromptNextToken>=0){if(cachedPromptHasLogits&&cachedPromptLogits.length==logits.length)for(let i:i32=0;i<logits.length;i++)unchecked(logits[i]=unchecked(cachedPromptLogits[i]));absolutePos=ids.length;prefillReusedTokens=ids.length;for(let i:i32=0;i<ids.length;i++)pushRecent(unchecked(ids[i]));logSerial("PREFIX CACHE full hit reused="+ids.length.toString()+" tokens; transformer+LM-head skipped.");let elapsed=now_ms()-t0;ttftMs=elapsed;prefillTps=<f64>ids.length*1000.0/Math.max(1.0,elapsed);pendingToken=cachedPromptNextToken;engineState=ENGINE_GENERATING;generationOwnerRequest=requestId;statusText="GENERATING";return true;}if(lcp>0){startToken=lcp;absolutePos=lcp;prefillReusedTokens=lcp;for(let i:i32=0;i<lcp;i++)pushRecent(unchecked(ids[i]));logSerial("PREFIX CACHE partial hit reused="+lcp.toString()+" / "+ids.length.toString()+" tokens.");}}
  logSerial("PREFILL optimization: LM-head only final token; AUTO selects proven B1 on this CPU (B4 hardware benchmark regressed); prefix reuse="+prefillReusedTokens.toString()+".");
  let remaining=ids.length-startToken,lastIndex=ids.length-1,idx=startToken;
  // All tokens before the final token can be executed in exact causal micro-batches.
  while(idx<lastIndex){let count=minI(effectiveBatch,lastIndex-idx);if(count<=1){let id=unchecked(ids[idx]);if(!forward(id,absolutePos,false)){engineState=ENGINE_ERROR;statusText="FORWARD FAILED DURING PREFILL";return false;}pushRecent(id);absolutePos++;idx++;prefillComputedTokens++;}else{if(!forwardPrefillBatch(typedIds,idx,count,absolutePos)){engineState=ENGINE_ERROR;statusText="BATCH PREFILL FAILED";return false;}for(let j:i32=0;j<count;j++)pushRecent(unchecked(ids[idx+j]));absolutePos+=count;idx+=count;prefillComputedTokens+=count;}}
  // Final prompt token needs logits. It runs the proven single-token path so the
  // decode math and validation path remain identical to V2.3.
  if(idx<ids.length){let id=unchecked(ids[idx]);if(!forward(id,absolutePos,true)){engineState=ENGINE_ERROR;statusText="FINAL PREFILL FORWARD FAILED";return false;}pushRecent(id);absolutePos++;prefillComputedTokens++;}
  let elapsed=now_ms()-t0;ttftMs=elapsed;prefillTps=<f64>ids.length*1000.0/Math.max(1.0,elapsed);if(!logLogitDiagnostics("PREFILL")){engineState=ENGINE_ERROR;statusText="NON-FINITE LOGITS";return false;}pendingToken=sampleNext();if(first)cachePrompt(typedIds,pendingToken);engineState=ENGINE_GENERATING;generationOwnerRequest=requestId;statusText="GENERATING";logSerial("PREFILL done ms="+formatF(elapsed)+" tps="+formatF(prefillTps)+" reused="+prefillReusedTokens.toString()+" computed="+prefillComputedTokens.toString()+" batched="+prefillBatchedTokens.toString()+" firstNextToken="+pendingToken.toString());return true;
}

function isStopToken(id:i32):bool {if(id==cfg.eos)return true;if(id<0||id>=vocabTokens.length)return false;let t=unchecked(vocabTokens[id]);return t=="<|im_end|>"||t=="<|eot_id|>"||t=="</s>"||t=="<|endoftext|>";}
function finishGeneration(reason:string,status:i32=200):void {
  engineState=ENGINE_COMPLETE;statusText=reason;logSerial("GENERATION complete reason="+reason+" tokens="+generated.toString()+" avg="+formatF(generated>0?totalGenMs/<f64>generated:0)+"ms/token");
  if(generationOwnerRequest>=0){let finalText=generationJsonMode?("{\"ok\":true,\"type\":\"complete\",\"text\":\""+jsonEscape(currentAnswer)+"\",\"usage\":{\"prompt_tokens\":"+generationPromptTokens.toString()+",\"completion_tokens\":"+generated.toString()+"},\"timing\":{\"ttft_ms\":"+formatF(ttftMs,10)+",\"avg_token_ms\":"+formatF(generated>0?totalGenMs/<f64>generated:0,10)+",\"tps\":"+formatF(tps,10)+"}}") : currentAnswer;let b=String.UTF8.encode(finalText);host_svc_respond(generationOwnerRequest,status,changetype<usize>(b),b.byteLength);generationOwnerRequest=-1;}
  serviceCompleted++;publishServiceLoad();emitRuntimeState("generation.complete");processServiceQueue();
}
function stepGeneration():void {
  if(engineState!=ENGINE_GENERATING)return;
  if(stopRequested){finishGeneration("STOPPED",499);return;}if(generated>=maxNewTokens){finishGeneration("MAX TOKENS");return;}let id=pendingToken;
  if(isStopToken(id)){finishGeneration("EOS / STOP TOKEN");return;}
  let piece=decodeToken(id);responseText+=piece;currentAnswer+=piece;generated++;pushRecent(id);
  if(verboseTokenLog)logSerial("TOKEN #"+generated.toString()+" id="+id.toString()+" text='"+piece+"'");
  if(generationOwnerRequest>=0&&piece.length>0){let chunk=generationJsonMode?jsonTokenChunk(generated,id,piece):piece;let b=String.UTF8.encode(chunk);host_svc_respond_chunk(generationOwnerRequest,0,changetype<usize>(b),b.byteLength);}
  let t0=now_ms();if(!forward(id,absolutePos)){engineState=ENGINE_ERROR;finishGeneration("FORWARD ERROR",500);return;}absolutePos++;if(prefixCacheValid&&absolutePos>=cfg.activeContext){prefixCacheValid=false;cachedPromptIds=new Int32Array(0);logSerial("PREFIX CACHE invalidated: KV ring wrapped active context.");}pendingToken=sampleNext();let dt=now_ms()-t0;totalGenMs+=dt;tps=1000.0/Math.max(0.001,dt);
  if(generated==1||verboseTokenLog)logSerial("PERF forward="+formatF(lastForwardMs,7)+"ms embed="+formatF(perfEmbedMs,6)+" qkv="+formatF(perfQkvMs,6)+" attn+o="+formatF(perfAttnMs,6)+" ffn="+formatF(perfFfnMs,6)+" lmhead="+formatF(perfLmHeadMs,6)+" q8quant="+formatF(perfQ8QuantMs,6));
}

// =============================================================================
// DEVELOPER JSON / NDJSON SERVICE PROTOCOL
// =============================================================================
function jsonEscape(v:string):string {let o="";for(let i:i32=0;i<v.length;i++){let c=v.charCodeAt(i);if(c==34)o+="\\\"";else if(c==92)o+="\\\\";else if(c==10)o+="\\n";else if(c==13)o+="\\r";else if(c==9)o+="\\t";else if(c<32)o+=" ";else o+=v.substr(i,1);}return o;}
function skipWs(s0:string,i:i32):i32 {while(i<s0.length){let c=s0.charCodeAt(i);if(c!=32&&c!=9&&c!=10&&c!=13)break;i++;}return i;}
function findJsonKey(s0:string,key:string):i32 {let pat="\""+key+"\"",p=s0.indexOf(pat);if(p<0)return-1;p=skipWs(s0,p+pat.length);if(p>=s0.length||s0.charCodeAt(p)!=58)return-1;return skipWs(s0,p+1);}
@inline function jsonHexNibble(c:i32):i32 {if(c>=48&&c<=57)return c-48;if(c>=65&&c<=70)return c-55;if(c>=97&&c<=102)return c-87;return-1;}
function jsonReadHex4(s0:string,p:i32):i32 {if(p+4>s0.length)return-1;let v:i32=0;for(let i:i32=0;i<4;i++){let h=jsonHexNibble(s0.charCodeAt(p+i));if(h<0)return-1;v=(v<<4)|h;}return v;}
function jsonStringField(s0:string,key:string,def:string=""):string {
  let p=findJsonKey(s0,key);if(p<0||p>=s0.length||s0.charCodeAt(p)!=34)return def;p++;let out="";
  while(p<s0.length){let c=s0.charCodeAt(p++);if(c==34)break;if(c!=92){out+=String.fromCharCode(c);continue;}if(p>=s0.length)break;let e=s0.charCodeAt(p++);
    if(e==110)out+="\n";else if(e==114)out+="\r";else if(e==116)out+="\t";else if(e==98)out+=String.fromCharCode(8);else if(e==102)out+=String.fromCharCode(12);else if(e==34)out+='"';else if(e==92)out+="\\";else if(e==47)out+="/";
    else if(e==117){let hi=jsonReadHex4(s0,p);if(hi<0)continue;p+=4;if(hi>=0xD800&&hi<=0xDBFF&&p+6<=s0.length&&s0.charCodeAt(p)==92&&s0.charCodeAt(p+1)==117){let lo=jsonReadHex4(s0,p+2);if(lo>=0xDC00&&lo<=0xDFFF){p+=6;out+=codePointString(0x10000+((hi-0xD800)<<10)+(lo-0xDC00));}else out+=String.fromCharCode(hi);}else out+=String.fromCharCode(hi);}
    else out+=String.fromCharCode(e);
  }return out;
}
function jsonNumberField(s0:string,key:string,def:f64):f64 {let p=findJsonKey(s0,key);if(p<0)return def;let e=p;while(e<s0.length){let c=s0.charCodeAt(e);if((c>=48&&c<=57)||c==45||c==43||c==46||c==101||c==69)e++;else break;}if(e<=p)return def;return F64.parseFloat(s0.substr(p,e-p));}
function jsonBoolField(s0:string,key:string,def:bool):bool {let p=findJsonKey(s0,key);if(p<0)return def;if(s0.substr(p,4)=="true")return true;if(s0.substr(p,5)=="false")return false;return def;}
function buildChatFromJson(payload:string):string {
  // Scans the messages array in-order. The payload contract requires role/content string fields.
  let mp=findJsonKey(payload,"messages");if(mp<0)return jsonStringField(payload,"prompt","");let out="",p=mp,first=true;
  while(p<payload.length){let rp=payload.indexOf("\"role\"",p),cp=payload.indexOf("\"content\"",p);if(rp<0||cp<0)break;let nextObj=payload.indexOf("}",cp);let role=jsonStringField(payload.substr(rp,nextObj>rp?nextObj-rp+1:payload.length-rp),"role","user"),content=jsonStringField(payload.substr(cp,nextObj>cp?nextObj-cp+1:payload.length-cp),"content","");if(content.length==0){p=cp+9;continue;}
    if(cfg.architecture=="qwen2"||tokenToId.has("<|im_start|>"))out+="<|im_start|>"+role+"\n"+content+"<|im_end|>\n";
    else if(tokenToId.has("<|start_header_id|>")){if(first&&tokenToId.has("<|begin_of_text|>"))out+="<|begin_of_text|>";out+="<|start_header_id|>"+role+"<|end_header_id|>\n\n"+content+"<|eot_id|>";}
    else out+=role+": "+content+"\n";first=false;p=nextObj>cp?nextObj+1:cp+9;
  }
  if(cfg.architecture=="qwen2"||tokenToId.has("<|im_start|>"))out+="<|im_start|>assistant\n";else if(tokenToId.has("<|start_header_id|>"))out+="<|start_header_id|>assistant<|end_header_id|>\n\n";else out+="assistant: ";return out;
}
function jsonTokenChunk(index:i32,id:i32,text:string):string {return "{\"type\":\"token\",\"index\":"+index.toString()+",\"token_id\":"+id.toString()+",\"text\":\""+jsonEscape(text)+"\"}\n";}
function jsonError(code:string,message:string):string {return "{\"ok\":false,\"error\":{\"code\":\""+jsonEscape(code)+"\",\"message\":\""+jsonEscape(message)+"\"}}";}
function runtimeJson():string {let eb=prefillAutoMode?1:prefillBatchSize;return "{\"ok\":true,\"api_version\":\"2.5.0\",\"engine_state\":"+engineState.toString()+",\"model\":{\"loaded\":"+(model.loaded?"true":"false")+",\"name\":\""+jsonEscape(cfg.modelName)+"\",\"architecture\":\""+jsonEscape(cfg.architecture)+"\",\"vocab\":"+cfg.vocabSize.toString()+",\"context\":"+cfg.activeContext.toString()+"},\"performance\":{\"tps\":"+formatF(tps,10)+",\"ttft_ms\":"+formatF(ttftMs,10)+",\"prefill_tps\":"+formatF(prefillTps,10)+",\"prefill_policy\":\""+(prefillAutoMode?"AUTO_B1":"MANUAL")+"\",\"prefill_batch\":"+eb.toString()+",\"prefix_reused\":"+prefillReusedTokens.toString()+",\"prefill_computed\":"+prefillComputedTokens.toString()+",\"forward_ms\":"+formatF(lastForwardMs,10)+",\"qkv_ms\":"+formatF(perfQkvMs,10)+",\"attention_ms\":"+formatF(perfAttnMs,10)+",\"ffn_ms\":"+formatF(perfFfnMs,10)+",\"lm_head_ms\":"+formatF(perfLmHeadMs,10)+",\"q8_quant_ms\":"+formatF(perfQ8QuantMs,10)+",\"greedy_fused_head\":"+(temperature<=0.05&&repPenalty<=1.0?"true":"false")+"},\"scheduler\":{\"queued\":"+serviceQueue.length.toString()+",\"capacity\":"+SERVICE_QUEUE_MAX.toString()+",\"active_request\":"+generationOwnerRequest.toString()+"}}";}

function compatibilityJson():string {return "{\"ok\":true,\"engine\":\"Inference V2.5\",\"architectures\":[\"llama\",\"qwen2\",\"mistral\"],\"quant_types\":[\"F32\",\"F16\",\"BF16\",\"Q4_0\",\"Q4_1\",\"Q5_0\",\"Q5_1\",\"Q8_0\",\"Q2_K\",\"Q3_K\",\"Q4_K\",\"Q5_K\",\"Q6_K\",\"Q8_K\"],\"strict\":true}";}
function queueJson():string {return "{\"ok\":true,\"queued\":"+serviceQueue.length.toString()+",\"capacity\":"+SERVICE_QUEUE_MAX.toString()+",\"active_request\":"+generationOwnerRequest.toString()+",\"ewma_ms\":"+formatF(serviceEwmaMs,10)+"}";}

// =============================================================================
// SERVICE FABRIC PROVIDER // ai.inference.generate
// =============================================================================
let inferenceServiceId:i32=-1,runtimeServiceId:i32=-1;
class ServiceJob {requestId:i32=-1;prompt:string="";preformatted:bool=false;jsonMode:bool=false;stateless:bool=true;priority:i32=50;enqueued:f64=0;maxTokens:i32=128;temp:f32=0.0;tp:f32=0.9;tk:i32=40;rep:f32=1.0;}
const serviceQueue:ServiceJob[]=new Array<ServiceJob>(0);const SERVICE_QUEUE_MAX:i32=64;let serviceEwmaMs:f64=0.0,serviceCompleted:i32=0;
function publishServiceLoad():void {let active=(engineState==ENGINE_GENERATING||engineState==ENGINE_PREFILL)?1:0;if(inferenceServiceId>=0)host_svc_set_load(inferenceServiceId,active,serviceQueue.length,1,serviceEwmaMs);if(runtimeServiceId>=0)host_svc_set_load(runtimeServiceId,0,0,32,1.0);}
function registerServices():void {
  let n=String.UTF8.encode("ai.inference.generate"),v=String.UTF8.encode("2.5.0");inferenceServiceId=host_svc_register(changetype<usize>(n),n.byteLength,changetype<usize>(v),v.byteLength,1);let n2=String.UTF8.encode("ai.inference.runtime");runtimeServiceId=host_svc_register(changetype<usize>(n2),n2.byteLength,changetype<usize>(v),v.byteLength,0);
  let manifest="{\"protocol\":\"wasm-ai-service/1\",\"version\":\"2.5.0\",\"content_types\":[\"application/json\",\"application/x-ndjson\",\"text/plain; charset=utf-8\"],\"methods\":{\"generate\":{\"input\":{\"prompt\":\"string\",\"max_tokens\":\"int\",\"temperature\":\"number\",\"top_p\":\"number\",\"top_k\":\"int\",\"repetition_penalty\":\"number\",\"priority\":\"0..100\",\"stateless\":\"bool\"},\"stream\":\"NDJSON TokenEvent\",\"final\":\"JSON Completion\"},\"chat\":{\"input\":\"messages[{role,content}] + generation options\",\"stream\":\"NDJSON TokenEvent\"},\"v1.completions\":{\"alias\":\"generate\"},\"v1.chat.completions\":{\"alias\":\"chat\"},\"tokenize\":{\"input\":\"text\",\"output\":\"token_ids[]\"},\"model.info\":{},\"models.list\":{},\"compatibility\":{},\"queue.status\":{},\"capabilities\":{},\"metrics\":{},\"health\":{},\"cancel\":{}},\"scheduler\":{\"priority\":true,\"aging\":true,\"cancellation\":true,\"bounded_queue\":64,\"provider_capacity\":1,\"least_loaded_host_routing\":true},\"execution\":{\"simd128\":true,\"q8_activation_turbo\":true,\"greedy_fused_lm_head\":true,\"branch_hoisted_gemv\":true,\"simd_rms_residual_attention\":true,\"prefill_auto\":\"B1 known-good; B2/B4 experimental\",\"prefill_microbatch_max\":4,\"exact_prefix_kv_cache\":true},\"gguf\":{\"architectures\":[\"llama\",\"qwen2\",\"mistral\"],\"quant_types\":[\"F32\",\"F16\",\"BF16\",\"Q4_0\",\"Q4_1\",\"Q5_0\",\"Q5_1\",\"Q8_0\",\"Q2_K\",\"Q3_K\",\"Q4_K\",\"Q5_K\",\"Q6_K\",\"Q8_K\"],\"policy\":\"fail-closed for unsupported graph/rope/tensor\"}}";let mb=String.UTF8.encode(manifest);host_svc_set_manifest(inferenceServiceId,changetype<usize>(mb),mb.byteLength);host_svc_set_manifest(runtimeServiceId,changetype<usize>(mb),mb.byteLength);publishServiceLoad();logSerial("Service Fabric 3.5 / Inference API 2.5 published generate#"+inferenceServiceId.toString()+" runtime#"+runtimeServiceId.toString()+" JSON/NDJSON queue=64");
}
function emitRuntimeState(topic:string):void {if(runtimeServiceId<0)return;let t=String.UTF8.encode(topic),payload=String.UTF8.encode(runtimeJson());host_svc_emit(runtimeServiceId,changetype<usize>(t),t.byteLength,changetype<usize>(payload),payload.byteLength);}
function respondText(id:i32,status:i32,text:string):void {let b=String.UTF8.encode(text);host_svc_respond(id,status,changetype<usize>(b),b.byteLength);}
function tokenIdsJson(ids:Int32Array):string {let o="{\"ok\":true,\"count\":"+ids.length.toString()+",\"token_ids\":[";for(let i:i32=0;i<ids.length;i++){if(i>0)o+=",";o+=unchecked(ids[i]).toString();}return o+"]}";}
export function serviceRequest(requestId:i32,serviceId:i32,methodBytes:i32,payloadBytes:i32):void {
  let mb=new Uint8Array(maxI(0,methodBytes)),pb=new Uint8Array(maxI(0,payloadBytes));if(methodBytes>0)host_svc_request_read_method(requestId,mb.dataStart,mb.byteLength);if(payloadBytes>0)host_svc_request_read_payload(requestId,pb.dataStart,pb.byteLength);let method=methodBytes>0?String.UTF8.decode(mb.buffer):"",payload=payloadBytes>0?String.UTF8.decode(pb.buffer):"",isJson=payload.length>0&&payload.charCodeAt(skipWs(payload,0))==123;
  logSerial("SERVICE request id="+requestId.toString()+" method="+method+" bytes="+payloadBytes.toString()+" priority="+host_svc_request_priority(requestId).toString());
  if(method=="status"||method=="model.info"||method=="metrics"||method=="health"||method=="capabilities"||method=="models.list"){respondText(requestId,200,runtimeJson());return;}
  if(method=="compatibility"){respondText(requestId,200,compatibilityJson());return;}
  if(method=="queue.status"){respondText(requestId,200,queueJson());return;}
  if(method=="v1.completions")method="generate";else if(method=="v1.chat.completions")method="chat";
  if(method=="tokenize"){let text=isJson?jsonStringField(payload,"text",jsonStringField(payload,"prompt","")):payload;let arr=tokenize(text,false);let ids=new Int32Array(arr.length);for(let i:i32=0;i<arr.length;i++)ids[i]=arr[i];respondText(requestId,200,tokenIdsJson(ids));return;}
  if(method=="cancel"){stopRequested=true;respondText(requestId,202,"{\"ok\":true,\"cancel_requested\":true}");return;}
  if(method!="generate"&&method!="chat"){respondText(requestId,404,jsonError("UNSUPPORTED_METHOD",method));return;}if(!model.loaded){respondText(requestId,503,jsonError("MODEL_NOT_READY","Load a compatible GGUF model first"));return;}if(serviceQueue.length>=SERVICE_QUEUE_MAX){respondText(requestId,429,jsonError("QUEUE_FULL","Inference queue capacity reached"));return;}
  let j=new ServiceJob();j.requestId=requestId;j.jsonMode=isJson;j.stateless=isJson?jsonBoolField(payload,"stateless",true):method=="generate";j.priority=clampI(isJson?<i32>jsonNumberField(payload,"priority",<f64>host_svc_request_priority(requestId)):host_svc_request_priority(requestId),0,100);j.enqueued=now_ms();j.maxTokens=clampI(isJson?<i32>jsonNumberField(payload,"max_tokens",128):128,1,4096);j.temp=<f32>(isJson?jsonNumberField(payload,"temperature",0.0):0.0);j.tp=<f32>(isJson?jsonNumberField(payload,"top_p",0.9):0.9);j.tk=clampI(isJson?<i32>jsonNumberField(payload,"top_k",40):40,1,128);j.rep=<f32>(isJson?jsonNumberField(payload,"repetition_penalty",1.0):1.0);
  if(method=="chat"&&isJson){j.prompt=buildChatFromJson(payload);j.preformatted=true;}else j.prompt=isJson?jsonStringField(payload,"prompt",""):payload;if(j.prompt.length==0){respondText(requestId,400,jsonError("EMPTY_PROMPT","No prompt/messages content"));return;}serviceQueue.push(j);publishServiceLoad();processServiceQueue();
}
export function serviceCancelled(requestId:i32,reason:i32):void {if(generationOwnerRequest==requestId)stopRequested=true;for(let i:i32=0;i<serviceQueue.length;i++)if(unchecked(serviceQueue[i]).requestId==requestId)unchecked(serviceQueue[i]).requestId=-1;publishServiceLoad();logSerial("SERVICE cancelled id="+requestId.toString()+" reason="+reason.toString());}
function processServiceQueue():void {
  if(engineState==ENGINE_GENERATING||engineState==ENGINE_PREFILL||serviceQueue.length==0){publishServiceLoad();return;}let idx:i32=-1,best:f64=-1e30,now=now_ms();for(let i:i32=0;i<serviceQueue.length;i++){let j=unchecked(serviceQueue[i]);if(j.requestId<0)continue;let score=<f64>j.priority+(now-j.enqueued)/5000.0;if(score>best){best=score;idx=i;}}if(idx<0){serviceQueue.length=0;publishServiceLoad();return;}let j=unchecked(serviceQueue[idx]),next:ServiceJob[]=new Array<ServiceJob>(0);for(let i:i32=0;i<serviceQueue.length;i++)if(i!=idx&&unchecked(serviceQueue[i]).requestId>=0)next.push(unchecked(serviceQueue[i]));serviceQueue.length=0;for(let i:i32=0;i<next.length;i++)serviceQueue.push(unchecked(next[i]));if(j.stateless)resetConversation();maxNewTokens=j.maxTokens;temperature=j.temp;topP=j.tp;topK=j.tk;repPenalty=j.rep;publishServiceLoad();let st=now_ms();if(!beginGeneration(j.prompt,j.requestId,j.preformatted,j.jsonMode)){respondText(j.requestId,503,jsonError("RUNTIME_BUSY","Unable to start generation"));}else{let dt=now_ms()-st;if(serviceEwmaMs==0)serviceEwmaMs=dt;else serviceEwmaMs=serviceEwmaMs*0.85+dt*0.15;}publishServiceLoad();
}

// =============================================================================
// UI / TELEMETRY
// =============================================================================
const VIEW_CHAT:i32=0,VIEW_MODEL:i32=1,VIEW_TENSORS:i32=2,VIEW_LOGS:i32=3,VIEW_SERVICE:i32=4;
let view:i32=VIEW_CHAT,mouseX:i32=0,mouseY:i32=0,scrollY:i32=0;
function button(x0:i32,y0:i32,w:i32,h:i32,label:string,color:u32):void {let hov=mouseX>=x0&&mouseX<x0+w&&mouseY>=y0&&mouseY<y0+h;drawRect(x0,y0,w,h,hov?C_PANEL2:C_PANEL);drawFrame(x0,y0,w,h,hov?color:C_BORDER);drawRect(x0,y0,w,2,color);drawText(label,x0+8,y0+(h-8)/2,C_WHITE,1);}
function textSafe(s:string,x0:i32,y0:i32,color:u32,maxChars:i32=90):void {let out="";let n=minI(s.length,maxChars);for(let i:i32=0;i<n;i++){let c=s.charCodeAt(i);out+=c>=32&&c<=126?s.substr(i,1):"?";}drawText(out,x0,y0,color,1);}
function wrapAscii(s:string,x0:i32,y0:i32,w:i32,maxLines:i32,color:u32):void {
  let per=maxI(8,w/8),line:i32=0,pos:i32=0;
  while(pos<s.length&&line<maxLines){
    if(s.charCodeAt(pos)==10||s.charCodeAt(pos)==13){pos++;if(pos<s.length&&s.charCodeAt(pos-1)==13&&s.charCodeAt(pos)==10)pos++;line++;continue;}
    let end=minI(s.length,pos+per),nl:i32=-1;for(let j:i32=pos;j<end;j++){let c=s.charCodeAt(j);if(c==10||c==13){nl=j;break;}}if(nl>=0)end=nl;
    if(end<s.length&&nl<0){let sp:i32=-1;for(let j:i32=end-1;j>pos;j--)if(s.charCodeAt(j)==32){sp=j;break;}if(sp>pos+per/3)end=sp;}
    if(end<=pos){pos++;continue;}textSafe(s.substr(pos,end-pos),x0,y0+line*14,color,per);pos=end;while(pos<s.length&&s.charCodeAt(pos)==32)pos++;line++;
  }
}
function engineStateName():string {if(engineState==ENGINE_NO_MODEL)return"NO MODEL";if(engineState==ENGINE_READY)return"READY";if(engineState==ENGINE_PREFILL)return"PREFILL";if(engineState==ENGINE_GENERATING)return"GENERATING";if(engineState==ENGINE_COMPLETE)return"COMPLETE";return"ERROR";}
function renderHeader():void {
  drawRect(14,10,772,48,C_PANEL);drawFrame(14,10,772,48,C_BORDER);drawRect(14,10,772,2,C_CYAN);drawText("INFERENCE V2.5 // EXTREME GGUF SERVICE RUNTIME",28,19,C_CYAN,2);textSafe("ABI 3.5 | ADAPTIVE PREFILL | FUSED GREEDY HEAD | SERVICE FABRIC",28,42,C_MUTED,80);
  let col=engineState==ENGINE_GENERATING?C_GREEN:(engineState==ENGINE_ERROR?C_ROSE:(model.loaded?C_CYAN:C_AMBER));drawRect(656,19,118,24,C_PANEL2);drawFrame(656,19,118,24,col);drawText(engineStateName(),665,27,col,1);
}
function renderTopTelemetry():void {
  drawRect(14,64,772,44,C_PANEL);drawFrame(14,64,772,44,C_BORDER);textSafe("MODEL: "+(model.loaded?(cfg.modelName.length?cfg.modelName:cfg.architecture):loadMessage),26,72,model.loaded?C_GREEN:C_AMBER,92);
  let p=modelResourceSize>0?<f64>modelLoadedBytes/<f64>modelResourceSize:0.0;textSafe("LOAD "+formatF(p*100.0,5)+"% | TPS "+formatF(tps,6)+" | FWD "+formatF(lastForwardMs,6)+"ms | POS "+absolutePos.toString()+" | Q "+serviceQueue.length.toString(),26,90,C_WHITE,94);
}
function renderPrompt():void {
  drawRect(14,114,586,62,C_PANEL);drawFrame(14,114,586,62,inputFocused?C_CYAN:C_BORDER);drawText("PROMPT (UNICODE PRESERVED; BITMAP PREVIEW IS ASCII-SAFE)",26,122,C_MUTED,1);let max=68;if(inputCursor>inputScroll+max-3)inputScroll=inputCursor-max+3;if(inputCursor<inputScroll)inputScroll=inputCursor;if(inputScroll<0)inputScroll=0;let shownPrompt=promptText.substr(inputScroll,max);if(hasNonAscii(shownPrompt))drawUnicode(shownPrompt,26,142,550,14,C_WHITE,16);else textSafe(shownPrompt,26,146,C_WHITE,max);if(inputFocused&&(<i64>now_ms()%1000)<500){let cx=26+(inputCursor-inputScroll)*8;if(cx<590)drawRect(cx,143,2,16,C_CYAN);}button(610,114,176,62,engineState==ENGINE_GENERATING?"STOP":"RUN PROMPT",engineState==ENGINE_GENERATING?C_ROSE:C_GREEN);
}
function renderTabs():void {button(14,184,90,24,"CHAT",view==VIEW_CHAT?C_CYAN:C_BORDER);button(110,184,130,24,"MODEL / LOAD",view==VIEW_MODEL?C_AMBER:C_BORDER);button(246,184,100,24,"TENSORS",view==VIEW_TENSORS?C_BLUE:C_BORDER);button(352,184,95,24,"LOGS",view==VIEW_LOGS?C_GREEN:C_BORDER);button(453,184,130,24,"SERVICE FABRIC",view==VIEW_SERVICE?C_CYAN:C_BORDER);button(590,184,196,24,"EXPORT FULL LOG",C_GREEN);}
function renderChat():void {drawRect(14,216,772,326,C_PANEL);drawFrame(14,216,772,326,C_BORDER);if(responseText.length==0){drawText("READY. LOAD A GGUF MODEL, THEN RUN A PROMPT.",28,234,C_MUTED,1);drawText("THE RUNTIME WILL REJECT UNSUPPORTED MATH INSTEAD OF FABRICATING OUTPUT.",28,254,C_CYAN,1);}else{let start=responseText.length>3000?responseText.length-3000:0;let shown=responseText.substr(start);if(hasNonAscii(shown)){drawUnicode(shown,28,230,742,13,C_WHITE,18);}else wrapAscii(shown,28,230,742,21,C_WHITE);}drawText("TOP TOKENS:",28,516,C_MUTED,1);for(let i:i32=0;i<5;i++){let id=unchecked(topIds[i]);let nm=id>=0&&id<vocabTokens.length?unchecked(vocabTokens[id]):"#"+id.toString();textSafe((i+1).toString()+":"+nm+" "+formatF(<f64>unchecked(topProbs[i])*100.0,5)+"%",118+i*130,516,C_CYAN,15);}}
function renderModel():void {
  drawRect(14,216,772,326,C_PANEL);drawFrame(14,216,772,326,C_BORDER);drawText("MODEL INGESTION / VALIDATION",28,230,C_AMBER,1);button(28,250,220,38,"PICK LOCAL .GGUF",C_CYAN);button(258,250,220,38,"LOCALHOST:8080",C_GREEN);button(488,250,270,38,"QWEN2.5 0.5B PRESET URL",C_AMBER);
  let y=306;textSafe("ARCH "+cfg.architecture+" | TOKENIZER "+cfg.tokenizerModel+" / "+cfg.tokenizerPre,28,y,C_WHITE,90);y+=18;textSafe("DIM "+cfg.dim.toString()+" | FFN "+cfg.hiddenDim.toString()+" | LAYERS "+cfg.nLayers.toString()+" | HEADS "+cfg.nHeads.toString()+" | KV "+cfg.nKvHeads.toString(),28,y,C_WHITE,90);y+=18;textSafe("VOCAB "+cfg.vocabSize.toString()+" | MODEL CTX "+cfg.modelContext.toString()+" | ACTIVE CTX "+cfg.activeContext.toString()+" | ROPE "+formatF(cfg.ropeTheta,8)+" FACTORS "+(ropeFreqTensor!=null?"YES":"NO"),28,y,C_WHITE,90);y+=18;textSafe("GGUF v"+model.version.toString()+" | TENSORS "+tensors.length.toString()+" | MODEL MEMORY "+formatBytes(<f64>modelBytes.byteLength),28,y,C_MUTED,90);y+=18;textSafe("KV "+formatBytes(<f64>(kvK.byteLength+kvV.byteLength))+" | LOGITS "+formatBytes(<f64>logits.byteLength)+" | LOAD "+formatBytes(<f64>modelLoadedBytes)+"/"+formatBytes(<f64>modelResourceSize),28,y,C_MUTED,90);y+=28;
  button(28,y,155,34,"TEMP "+formatF(temperature,3),C_AMBER);button(193,y,155,34,"TOP-P "+formatF(topP,3),C_CYAN);button(358,y,155,34,"TOP-K "+topK.toString(),C_BLUE);button(523,y,155,34,"REP "+formatF(repPenalty,4),C_GREEN);y+=48;button(28,y,180,34,"MAX TOKENS "+maxNewTokens.toString(),C_MUTED);button(218,y,180,34,"RESET CONVERSATION",C_ROSE);button(408,y,105,34,verboseTokenLog?"LOG: ON":"LOG: OFF",C_GREEN);button(523,y,105,34,q8TurboEnabled?"Q8 TURBO":"Q8 F32",q8TurboEnabled?C_CYAN:C_AMBER);button(638,y,120,34,prefillAutoMode?"PF AUTO/B1":"PF BATCH "+prefillBatchSize.toString(),C_BLUE);
}
function renderTensors():void {drawRect(14,216,772,326,C_PANEL);drawFrame(14,216,772,326,C_BORDER);drawText("GGUF TENSOR REGISTRY",28,230,C_BLUE,1);let count=minI(14,tensors.length);for(let i:i32=0;i<count;i++){let t=unchecked(tensors[i]);let y=252+i*19;textSafe(t.name,28,y,C_WHITE,48);textSafe(typeName(t.type)+" ["+t.ne0.toString()+"x"+t.ne1.toString()+"] "+formatBytes(<f64>t.bytes),430,y,typeSupported(t.type)?C_GREEN:C_ROSE,40);}}
function renderLogs():void {drawRect(14,216,772,326,C_PANEL);drawFrame(14,216,772,326,C_BORDER);drawText("FULL SERIAL LOG // "+logLines.length.toString()+" ENTRIES // ~"+formatBytes(<f64>logByteEstimate),28,230,C_GREEN,1);let start=maxI(0,logLines.length-19-scrollY);for(let row:i32=0;row<19;row++){let idx=start+row;if(idx>=logLines.length)break;let line=unchecked(logLines[idx]);drawUnicode(line,28,250+row*14,742,12,C_WHITE,16);}}
function renderService():void {
  drawRect(14,216,772,326,C_PANEL);drawFrame(14,216,772,326,C_BORDER);drawText("GLOBAL AI SERVICE FABRIC // PROVIDER 2.5",28,230,C_CYAN,1);
  textSafe("ai.inference.generate@2.5.0 #"+inferenceServiceId.toString()+" | ai.inference.runtime@2.5.0 #"+runtimeServiceId.toString(),28,252,C_GREEN,92);
  textSafe("JSON RPC: generate / chat / tokenize / model.info / metrics / health / capabilities / cancel",28,274,C_WHITE,92);
  textSafe("STREAM: NDJSON TokenEvent chunks + JSON final | UTF-8 / Unicode safe",28,296,C_WHITE,92);
  textSafe("QUEUE "+serviceQueue.length.toString()+"/"+SERVICE_QUEUE_MAX.toString()+" | ACTIVE "+generationOwnerRequest.toString()+" | PRIORITY + AGING | CANCEL=YES",28,322,C_AMBER,92);
  textSafe("ROUTING: HOST LEAST-LOADED PROVIDER | MANIFEST DISCOVERY | EWMA "+formatF(serviceEwmaMs,7)+"ms",28,344,C_CYAN,92);
  textSafe("PREFILL "+(prefillAutoMode?"AUTO/B1":"B"+prefillBatchSize.toString())+" | PREFIX REUSE "+prefillReusedTokens.toString()+" | COMPUTED "+prefillComputedTokens.toString()+" | BATCHED "+prefillBatchedTokens.toString(),28,366,C_GREEN,92);
  textSafe("GGUF: LLAMA / QWEN2 / MISTRAL + 14 EXACT QUANT TYPES; UNSUPPORTED MATH FAILS CLOSED.",28,388,C_MUTED,92);
  textSafe("CORRELATION, TIMEOUTS, BACKPRESSURE AND PROVIDER LIFECYCLE ARE HOST-MANAGED.",28,410,C_MUTED,92);
}
function renderFooter():void {drawRect(14,548,772,40,C_PANEL);drawFrame(14,548,772,40,C_BORDER);let avg=generated>0?totalGenMs/<f64>generated:0.0;textSafe("TTFT "+formatF(ttftMs,6)+"ms | PREFILL "+formatF(prefillTps,6)+" t/s | TPOT "+formatF(avg,6)+"ms | OUT "+generated.toString()+" | STATE "+statusText,26,559,C_WHITE,92);textSafe("PERF QKV "+formatF(perfQkvMs,5)+" A/O "+formatF(perfAttnMs,5)+" FFN "+formatF(perfFfnMs,5)+" LM "+formatF(perfLmHeadMs,5)+" Q8Q "+formatF(perfQ8QuantMs,5)+"ms | PF "+(prefillAutoMode?"AUTO/B1":"B"+prefillBatchSize.toString())+" R"+prefillReusedTokens.toString()+" C"+prefillComputedTokens.toString()+" | "+(q8TurboEnabled?"Q8 INT SIMD":"F32 REF"),26,575,C_MUTED,92);}

export function renderFrame():i32 {
  pixels.fill(C_BG);renderHeader();renderTopTelemetry();renderPrompt();renderTabs();if(view==VIEW_CHAT)renderChat();else if(view==VIEW_MODEL)renderModel();else if(view==VIEW_TENSORS)renderTensors();else if(view==VIEW_LOGS)renderLogs();else renderService();renderFooter();
  if(engineState==ENGINE_GENERATING)stepGeneration();else processServiceQueue();return <i32>pixels.dataStart;
}

// =============================================================================
// INPUT / LIFECYCLE
// =============================================================================
// WASM OS semantic workspace state. Large GGUF weights are intentionally not
// duplicated into JSON; model-independent user/runtime settings are restored.
const osStateBuffer:Uint8Array=new Uint8Array(32768);let osStateLen:i32=0;
function buildOsState():void {let j="{\"prompt\":\""+jsonEscape(promptText)+"\",\"temperature\":"+temperature.toString()+",\"top_p\":"+topP.toString()+",\"top_k\":"+topK.toString()+",\"rep\":"+repPenalty.toString()+",\"max_new_tokens\":"+maxNewTokens.toString()+",\"q8_turbo\":"+(q8TurboEnabled?"true":"false")+",\"prefill_auto\":"+(prefillAutoMode?"true":"false")+",\"prefill_batch\":"+prefillBatchSize.toString()+"}";let b=String.UTF8.encode(j);osStateLen=minI(b.byteLength,osStateBuffer.byteLength);memory.copy(osStateBuffer.dataStart,changetype<usize>(b),<usize>osStateLen);}
export function osWorkspaceStateSize():i32 {buildOsState();return osStateLen;}
export function osWorkspaceStatePtr():i32 {return <i32>osStateBuffer.dataStart;}
export function osWorkspaceRestorePtr():i32 {return <i32>osStateBuffer.dataStart;}
export function osWorkspaceRestoreCapacity():i32 {return osStateBuffer.byteLength;}
export function osWorkspaceRestore(len:i32):i32 {if(len<=0||len>osStateBuffer.byteLength)return 0;let ab=new ArrayBuffer(len);memory.copy(changetype<usize>(ab),osStateBuffer.dataStart,<usize>len);let j=String.UTF8.decode(ab);promptText=jsonStringField(j,"prompt",promptText);temperature=<f32>jsonNumberField(j,"temperature",temperature);topP=<f32>jsonNumberField(j,"top_p",topP);topK=clampI(<i32>jsonNumberField(j,"top_k",topK),1,128);repPenalty=<f32>jsonNumberField(j,"rep",repPenalty);maxNewTokens=clampI(<i32>jsonNumberField(j,"max_new_tokens",maxNewTokens),1,4096);q8TurboEnabled=jsonBoolField(j,"q8_turbo",q8TurboEnabled);prefillAutoMode=jsonBoolField(j,"prefill_auto",prefillAutoMode);prefillBatchSize=clampI(<i32>jsonNumberField(j,"prefill_batch",prefillBatchSize),1,PREFILL_BATCH_MAX);inputCursor=promptText.length;return 1;}

export function appInit(w:i32,h:i32,dpr:f64):void {logSerial("Inference V2 appInit hostViewport="+w.toString()+"x"+h.toString()+" dpr="+formatF(dpr,4));registerServices();runMathSelfTest();}
export function appStart():void {logSerial("Inference V2.5 EXTREME SERVICE runtime started (SIMD128 required/enabled, deterministic greedy validation mode; branch-hoisted GEMV + SIMD attention + fused greedy head).");}
export function appStop():void {if(inferenceServiceId>=0)host_svc_unregister(inferenceServiceId);if(runtimeServiceId>=0)host_svc_unregister(runtimeServiceId);if(modelResource>=0)host_resource_close(modelResource);logSerial("Inference V2 runtime stopping.");}
function runMathSelfTest():void {let a=new Float32Array(4);a[0]=1;a[1]=2;a[2]=3;a[3]=4;let w=new Float32Array(4);w.fill(1);let o=new Float32Array(4);rmsNorm(o,a,w,4,0.0);let ss:f64=0;for(let i:i32=0;i<4;i++)ss+=<f64>unchecked(o[i])*<f64>unchecked(o[i]);let mean=ss/4.0;if(absF(<f32>(mean-1.0))<0.0005)logSerial("SELFTEST RMSNorm PASS mean-square="+formatF(mean));else logSerial("SELFTEST RMSNorm FAIL mean-square="+formatF(mean));}
export function mouseMove(xp:i32,yp:i32,buttons:i32,mods:i32):void {mouseX=xp;mouseY=yp;}
export function mouseDown(buttonId:i32,xp:i32,yp:i32,mods:i32):void {
  inputFocused=xp>=14&&xp<600&&yp>=114&&yp<176;
  if(xp>=610&&xp<786&&yp>=114&&yp<176){if(engineState==ENGINE_GENERATING)stopRequested=true;else beginGeneration(promptText,-1);return;}
  if(yp>=184&&yp<208){if(xp<104)view=VIEW_CHAT;else if(xp<240)view=VIEW_MODEL;else if(xp<346)view=VIEW_TENSORS;else if(xp<447)view=VIEW_LOGS;else if(xp<583)view=VIEW_SERVICE;else exportLogFile();return;}
  if(view==VIEW_MODEL){
    if(yp>=250&&yp<288){if(xp>=28&&xp<248)beginPickModel();else if(xp>=258&&xp<478)beginUrlModel("http://localhost:8080/model.gguf");else if(xp>=488&&xp<758)beginUrlModel(DEFAULT_QWEN_URL);return;}
    if(yp>=404&&yp<438){if(xp>=28&&xp<183){temperature=temperature<0.1?0.7:(temperature<0.8?1.0:0.0);}else if(xp>=193&&xp<348){topP=topP<0.85?0.9:(topP<0.95?0.98:0.8);}else if(xp>=358&&xp<513){topK=topK==20?40:(topK==40?80:20);}else if(xp>=523&&xp<678){repPenalty=repPenalty<1.05?1.1:(repPenalty<1.15?1.2:1.0);}return;}
    if(yp>=452&&yp<486){if(xp>=28&&xp<208){maxNewTokens=maxNewTokens==64?128:(maxNewTokens==128?256:(maxNewTokens==256?512:64));}else if(xp>=218&&xp<398)resetConversation();else if(xp>=408&&xp<513)verboseTokenLog=!verboseTokenLog;else if(xp>=523&&xp<628){q8TurboEnabled=!q8TurboEnabled;logSerial("Q8_K integer turbo "+(q8TurboEnabled?"ENABLED":"DISABLED; F32 activation reference path active"));}else if(xp>=638){if(prefillAutoMode){prefillAutoMode=false;prefillBatchSize=1;}else if(prefillBatchSize==1)prefillBatchSize=2;else if(prefillBatchSize==2)prefillBatchSize=4;else{prefillAutoMode=true;prefillBatchSize=1;}logSerial("Prefill policy "+(prefillAutoMode?"AUTO/B1 (hardware-proven fastest)":"MANUAL/B"+prefillBatchSize.toString()));}return;}
  }
}
export function mouseWheel(dx:i32,dy:i32,mods:i32):void {if(view==VIEW_LOGS){scrollY+=dy>0?5:-5;if(scrollY<0)scrollY=0;if(scrollY>logLines.length)scrollY=logLines.length;}}
function insertAtCursor(s:string):void {let left=promptText.substr(0,inputCursor),right=promptText.substr(inputCursor);promptText=left+s+right;inputCursor+=s.length;}
export function keyDown(key:i32,mods:i32,repeat:i32):void {if(!inputFocused)return;if(key==8){if(inputCursor>0){promptText=promptText.substr(0,inputCursor-1)+promptText.substr(inputCursor);inputCursor--;}}else if(key==46){if(inputCursor<promptText.length)promptText=promptText.substr(0,inputCursor)+promptText.substr(inputCursor+1);}else if(key==37){if(inputCursor>0)inputCursor--;}else if(key==39){if(inputCursor<promptText.length)inputCursor++;}else if(key==36)inputCursor=0;else if(key==35)inputCursor=promptText.length;else if(key==13&&engineState!=ENGINE_GENERATING)beginGeneration(promptText,-1);}
export function textInput(codepoint:i32):void {if(!inputFocused)return;if(codepoint>=32&&codepoint<=0x10FFFF)insertAtCursor(codePointString(codepoint));}