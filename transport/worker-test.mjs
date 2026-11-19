import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {PacketWorkerSession} from './worker-session.mjs';
import {nodeWorker} from './worker-node-harness.mjs';
const wasm=await WebAssembly.compile(await readFile(new URL('../dist/packet-engine.wasm',import.meta.url)));
const left='192.0.2.10:4040',right='192.0.2.11:4041',mk=(local,remote)=>({op:'rtc',origin:'https://app.example',local,remote});
const control=new AbortController(),opts={makeWorker:nodeWorker,signal:control.signal,deadlineMs:10000};
await assert.rejects(PacketWorkerSession.open(wasm,{...mk(left,right),origin:'null'},opts),/origin/);
const sessions=await Promise.all([PacketWorkerSession.open(wasm,mk(left,right),opts),PacketWorkerSession.open(wasm,mk(right,left),opts)]);
try{
 const [a,b]=sessions;let ap=[],bp=[],ac=[{op:'channel',label:'dedicated-worker'},{op:'offer'}],bc=[],read='',count=0;
 const end=Date.now()+20000;
 while(!read && Date.now()<end){
   const p=a.pump(ap,ac);await assert.rejects(a.pump(),/backpressure/);const [ar,br]=await Promise.all([p,b.pump(bp,bc)]);ap=br.packets;bp=ar.packets;ac=[];bc=[];count+=ap.length+bp.length;
   for(const e of ar.events){if(e.type==='error')throw Error(e.text);if(e.type==='offer')bc.push({op:'answer',sdp:e.text});if(e.type==='channel')ac.push({op:'message',id:e.id,data:Buffer.from('worker packet').toString('base64')});}
   for(const e of br.events){if(e.type==='error')throw Error(e.text);if(e.type==='answer')ac.push({op:'accept-answer',sdp:e.text});if(e.type==='message')read=Buffer.from(e.data,'base64').toString();}
   await delay(1);
 }
 assert.equal(read,'worker packet');assert.ok(count>0);await assert.rejects(a.pump([new Uint8Array(2049)]),/batch/);
 await assert.rejects(a.pump([],[{op:'offer',Op:'rtc'}]),/fields/);await assert.rejects(a.pump([],[mk(right,left)]),/Invalid command/);
 const pending=a.pump();control.abort();await assert.rejects(pending,/revoked/i);await assert.rejects(b.pump(),/revoked/i);
 console.log('RTC data between two dedicated workers using browser WASI; backpressure and session revocation passed ('+count+' datagrams)');
}finally{for(const s of sessions)s.close();}
