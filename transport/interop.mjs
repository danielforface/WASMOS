// Real host <-> TWO independently initialized Wasm guests. No net imports.
import {WASI} from 'node:wasi';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {PacketEngine} from './driver.mjs';
const mod=await WebAssembly.compile(await readFile(new URL('../dist/packet-engine.wasm',import.meta.url)));
async function make(){
 const wasi=new WASI({version:'preview1',env:{},preopens:{},returnOnExit:true}),im=wasi.getImportObject();
 for(const {module,name} of WebAssembly.Module.imports(mod)){assert.equal(module,'wasi_snapshot_preview1');if(name.startsWith('sock_'))im[module][name]=()=>76}
 const ins=await WebAssembly.instantiate(mod,im);wasi.initialize(ins);return new PacketEngine(ins.exports);
}
const a=await make(),b=await make(),left='192.0.2.10:4040',right='192.0.2.11:4041';
try{
 a.command({op:'rtc',local:left,remote:right});b.command({op:'rtc',local:right,remote:left});a.command({op:'channel',label:'proof'});a.command({op:'offer'});
 let result,packets=0;const until=performance.now()+20000;
 while(!result&&performance.now()<until){
   a.pump(p=>{packets++;b.feed(p)},e=>{if(e.type==='error')throw Error(e.text);if(e.type==='offer')b.command({op:'answer',sdp:e.text});if(e.type==='channel')a.command({op:'message',id:e.id,data:Buffer.from('from separate WASM').toString('base64')})});
   b.pump(p=>{packets++;a.feed(p)},e=>{if(e.type==='error')throw Error(e.text);if(e.type==='answer')a.command({op:'accept-answer',sdp:e.text});if(e.type==='message')result=Buffer.from(e.data,'base64').toString()});
   await delay(1);
 }
 assert.equal(result,'from separate WASM');assert.ok(packets>0);console.log('RTC interop between isolated Wasm instances:',result,'('+packets+' UDP packets)');
}finally{a.close();b.close()}
