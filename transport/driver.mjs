// Trusted application-side adapter. Never pass this object, its origin, or its
// peer configuration to an untrusted renderer. No fetch/DNS/socket imports.
const enc=new TextEncoder(),dec=new TextDecoder();
export class PacketEngine{
  constructor(exports){this.x=exports;this.closed=false}
  write(bytes){if(this.closed)throw Error('closed session');if(bytes.length>this.x.capacity())throw RangeError('message limit');new Uint8Array(this.x.memory.buffer,this.x.buffer(),bytes.length).set(bytes)}
  read(n){if(n<0)throw Error('engine terminated or event queue overflow');return new Uint8Array(this.x.memory.buffer,this.x.buffer(),n).slice()}
  command(value){const b=enc.encode(JSON.stringify(value));this.write(b);const code=this.x.command(b.length);if(code<0)throw Error('command rejected: '+code)}
  feed(bytes){this.write(bytes);if(this.x.feed(bytes.length)<0)throw Error('packet rejected')}
  pump(deliver,notify){if(this.closed)return;this.x.step();for(let i=0;i<64;i++){const n=this.x.drain();if(!n)break;deliver(this.read(n))}
    for(let i=0;i<64;i++){const n=this.x.event();if(!n)break;notify(JSON.parse(dec.decode(this.read(n))))}}
  close(){if(!this.closed){this.closed=true;this.x.shutdown()}}
}
