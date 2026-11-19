// Trusted caller owns the peer, origin, lifetime and raw packet delivery.
// At most one request in flight. Never expose the port, config, or this class to a page.
import {workerConfig,workerCommand} from './worker-protocol.mjs';
export class PacketWorkerSession{
  static async open(module,config,{makeWorker=()=>new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'}),signal,deadlineMs=15000}={}){
    if(signal?.aborted)throw Error('Session revoked');
    const canonical=workerConfig(config),w=makeWorker(),s=new PacketWorkerSession(w,signal,deadlineMs);s.kind=canonical.op;
    try{await s.request({type:'init',module,config:canonical});return s;}catch(e){s.close();throw e;}
  }
  constructor(w,signal,deadlineMs){
    this.worker=w;this.signal=signal;this.deadlineMs=deadlineMs;this.seq=0;this.closed=false;this.pending=null;
    this.abort=()=>this.close('Session revoked');signal?.addEventListener('abort',this.abort,{once:true});
    w.onmessage=({data})=>{const p=this.pending;if(!p||data?.id!==p.id)return;this.pending=null;clearTimeout(p.timer);
      if(data.error){p.reject(Error(data.error));this.close();}else p.resolve(data);};
    w.onerror=e=>this.close(e?.message||'Worker failed');
  }
  request(msg){
    if(this.closed||this.signal?.aborted)return Promise.reject(Error('Session revoked'));
    if(this.pending)return Promise.reject(Error('Worker backpressure: one batch in flight'));
    return new Promise((resolve,reject)=>{const id=++this.seq,timer=setTimeout(()=>this.close('Worker deadline exceeded'),this.deadlineMs);
      this.pending={id,timer,resolve,reject};try{this.worker.postMessage({id,...msg});}catch(e){this.close(e.message);}});
  }
  pump(packets=[],commands=[]){
    if(!Array.isArray(packets)||packets.length>64||!Array.isArray(commands)||commands.length>16||packets.some(p=>!(p instanceof Uint8Array)||!p.length||p.length>2048))return Promise.reject(Error('Invalid batch'));
    try{return this.request({type:'pump',packets,commands:commands.map(c=>workerCommand(this.kind,c))});}catch(e){return Promise.reject(e);}
  }
  close(reason='Session closed'){
    if(this.closed)return;this.closed=true;this.signal?.removeEventListener('abort',this.abort);const p=this.pending;this.pending=null;
    if(p){clearTimeout(p.timer);p.reject(Error(reason));}this.worker.onmessage=this.worker.onerror=null;this.worker.terminate();
  }
}
