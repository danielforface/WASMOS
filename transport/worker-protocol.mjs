const methods=Object.freeze({rtc:{channel:['label'],offer:[],answer:['sdp'],'accept-answer':['sdp'],message:['id','data']},webtransport:{datagram:['data'],stream:[],write:['id','data'],finish:['id'],release:['id']}});
function exact(o,keys){if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).length!==keys.length||keys.some(k=>!Object.hasOwn(o,k)))throw Error('Unexpected protocol fields');}
export function workerConfig(value){
 if(!value||!Object.hasOwn(methods,value.op))throw Error('Unsupported transport');
 const keys=['op','local','remote','origin',...(value.op==='webtransport'?['url']:[])];exact(value,keys);
 if(typeof value.origin!=='string'||value.origin.length>512||!value.origin.startsWith('https://')||new URL(value.origin).origin!==value.origin)throw Error('Expected normalized initiating HTTPS origin');
 for(const ep of [value.local,value.remote])if(typeof ep!=='string'||ep.length>100||!/^(\[[0-9a-fA-F:.]+\]|[0-9.]+):[0-9]{1,5}$/.test(ep))throw Error('Expected a numeric IP endpoint');
 if(value.op==='webtransport'){const u=new URL(value.url);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.href.length>2048||Number(u.port||443)!==Number(value.remote.split(':').pop()))throw Error('Unexpected WebTransport endpoint');}
 return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
export function workerCommand(kind,c){
 if(!c||!Object.hasOwn(methods,kind)||!Object.hasOwn(methods[kind],c.op))throw Error('Invalid command for this session');
 const fields=methods[kind][c.op];exact(c,['op',...fields]);
 for(const f of fields){
   const v=c[f];if(f==='id'){if(!Number.isSafeInteger(v)||v<=0||v>0x7fffffff)throw Error('Invalid handle');}
   else if(typeof v!=='string'||v.length>(f==='label'?256:65536))throw Error('Invalid '+f);
   else if(f==='data'&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))throw Error('Invalid data encoding');
 }return Object.fromEntries(['op',...fields].map(k=>[k,c[k]]));
}
