// Packaged as dist/packet-worker/worker.mjs. This is a trusted module worker,
// not a webpage API. It accepts a compiled module, never a URL or socket handle.
import {WASI} from './wasi/index.js';
import {PacketEngine} from './driver.mjs';
import {workerConfig,workerCommand} from './worker-protocol.mjs';
let engine,kind,initializing=false,closed=false;
const reply=(id,body,transfers=[])=>self.postMessage({id,...body},transfers);
async function init(m){
  if(engine||initializing||closed)throw Error('Session already initialized');initializing=true;
  if(!(m.module instanceof WebAssembly.Module))throw Error('Invalid reactor');
  const config=workerConfig(m.config);
  if(typeof crypto?.getRandomValues!=='function')throw Error('Secure randomness unavailable');
  // No arguments, environment, files, preopens, network imports or host-provided credentials.
  const wasi=new WASI([],[],[]),imports={...wasi.wasiImport};let instance;
  for(const {module,name} of WebAssembly.Module.imports(m.module)){
    if(module!=='wasi_snapshot_preview1'||typeof imports[name]!=='function'||name.startsWith('sock_'))throw Error('Unsupported ambient import '+name);
  }
  // Never allow a Math.random fallback, including on engines with shared memory.
  imports.random_get=(ptr,len)=>{const b=new Uint8Array(instance.exports.memory.buffer,ptr>>>0,len>>>0);for(let i=0;i<b.length;i+=65536)crypto.getRandomValues(b.subarray(i,i+65536));return 0;};
  instance=await WebAssembly.instantiate(m.module,{wasi_snapshot_preview1:imports});wasi.initialize(instance);
  const e=new PacketEngine(instance.exports);try{e.command(config);}catch(err){e.close();throw err;}
  engine=e;kind=config.op;initializing=false;
}
self.onmessage=async({data:m})=>{
  if(closed||!Number.isSafeInteger(m?.id))return;
  try{
    if(m.type==='init'){await init(m);reply(m.id,{ready:true});return;}
    if(!engine||m.type!=='pump')throw Error('Invalid worker state');
    if(!Array.isArray(m.packets)||m.packets.length>64||!Array.isArray(m.commands)||m.commands.length>16)throw Error('Batch limit');
    for(const x of m.packets){if(!(x instanceof Uint8Array)||!x.length||x.length>2048)throw Error('Invalid datagram');engine.feed(x);}
    for(const c of m.commands)engine.command(workerCommand(kind,c));
    const packets=[],events=[];engine.pump(p=>packets.push(p),e=>events.push(e));reply(m.id,{packets,events},packets.map(p=>p.buffer));
  }catch(e){closed=true;try{engine?.close();}catch{}reply(m.id,{error:String(e?.message||e)});}
};
