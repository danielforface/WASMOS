// Test-only harness for the unchanged browser-targeted worker entry point.
import {parentPort,Worker} from 'node:worker_threads';
if(parentPort){
  globalThis.self=globalThis;globalThis.postMessage=(...args)=>parentPort.postMessage(...args);
  await import('../dist/packet-worker/worker.mjs');
  parentPort.on('message',data=>self.onmessage({data}));
}
export function nodeWorker(){
  const w=new Worker(new URL(import.meta.url)),out={postMessage:(...args)=>w.postMessage(...args),terminate:()=>w.terminate()};
  w.on('message',data=>out.onmessage?.({data}));w.on('error',e=>out.onerror?.(e));return out;
}
