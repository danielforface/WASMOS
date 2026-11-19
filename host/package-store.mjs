/* Generic official-repository protocol. No app IDs, assets or manifests in the OS. */
const PACKAGE_REF = 'https://api.github.com/repos/danielforface/WASMOS/git/ref/heads/main';
const PACKAGE_RAW = 'https://raw.githubusercontent.com/danielforface/WASMOS/';
const PACKAGE_FORMATS = Object.freeze({assemblyscript:'ts',panel:'html',wasm:'wasm'});
const PACKAGE_CAPS = new Set(['service','graph','files','camera','microphone','wasm','manage']);
const packageHex = b => Array.from(new Uint8Array(b),n=>n.toString(16).padStart(2,'0')).join('');
const packageSha = async b=>packageHex(await crypto.subtle.digest('SHA-256',b));
const pkgVersion = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const pkgId = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const pkgRef = /^[0-9a-f]{40}$/;
function pkgAssert(ok,hint){if(!ok)throw Error('Package installation: '+hint);}
export function validatePackage(p) {
  pkgAssert(p && typeof p==='object' && typeof p.id==='string' && p.id.length<=100 && pkgId.test(p.id),'invalid ID');
  pkgAssert(typeof p.name==='string' && p.name.trim().length && p.name.length<=100 && !/[\u0000-\u001f<>]/.test(p.name),'invalid display name');
  pkgAssert(typeof p.version==='string' && pkgVersion.test(p.version) && Object.hasOwn(PACKAGE_FORMATS,p.format),'unknown version or format');
  pkgAssert(['base','extra'].includes(p.group) && typeof p.slug==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(p.slug),'invalid package directory');
  pkgAssert(p.path==='packages/'+p.group+'/'+p.slug+'/main.'+PACKAGE_FORMATS[p.format],'unexpected payload path');
  pkgAssert(typeof p.sha256==='string' && /^[0-9a-f]{64}$/.test(p.sha256) && Number.isSafeInteger(p.bytes) && p.bytes>0 && p.bytes<=4*1024*1024,'invalid digest or size');
  pkgAssert(Array.isArray(p.capabilities) && p.capabilities.length<=PACKAGE_CAPS.size && new Set(p.capabilities).size===p.capabilities.length && p.capabilities.every(c=>PACKAGE_CAPS.has(c)),'unknown or duplicate capability');
  pkgAssert(Array.isArray(p.services) && p.services.length<=16 && (!p.services.length || (p.format==='panel' && p.capabilities.includes('service'))),'invalid service list');
  for(const v of p.services)pkgAssert(v && typeof v.name==='string' && v.name.length<=100 && pkgId.test(v.name) && pkgVersion.test(v.version) && Array.isArray(v.methods) && v.methods.length>0 && v.methods.length<=32 && v.methods.every(m=>typeof m==='string' && /^[a-zA-Z][a-zA-Z0-9.-]{0,63}$/.test(m)), 'invalid service declaration');
  return {id:p.id,name:p.name,version:p.version,format:p.format,group:p.group,slug:p.slug,path:p.path,bytes:p.bytes,sha256:p.sha256,capabilities:[...p.capabilities],services:p.services.map(s=>({name:s.name,version:s.version,methods:[...s.methods]}))};
}
export function validatePackageCatalog(doc) {
  pkgAssert(doc?.schema==='wasmos.packages/1' && Array.isArray(doc.packages) && doc.packages.length>0 && doc.packages.length<=512,'unsupported or empty catalog');
  const rows=doc.packages.map(validatePackage);
  for(const key of ['id','path'])pkgAssert(new Set(rows.map(p=>p[key])).size===rows.length,'duplicate '+key);
  pkgAssert(rows.some(p=>p.group==='base'),'catalog has no base group');
  return rows;
}
async function packageBytes(fetcher,url,limit){
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),25000);
  try{
    const r=await fetcher(url,{signal:abort.signal,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'});
    if(!r.ok)throw Error('Official repository returned HTTP '+r.status);
    pkgAssert(Number(r.headers.get('content-length')||0)<=limit,'response too large');
    const reader=r.body.getReader(),parts=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('Package exceeds declared size');}parts.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return bytes;
  }finally{clearTimeout(timer);}
}
const packageText=b=>new TextDecoder('utf-8',{fatal:true}).decode(b);
export async function verifyPackageBytes(meta,bytes){
  pkgAssert(bytes instanceof Uint8Array && bytes.length===meta.bytes && await packageSha(bytes)===meta.sha256,'integrity check failed for '+meta.id);
  if(meta.format==='wasm')pkgAssert(WebAssembly.validate(bytes),'invalid WebAssembly');
  else pkgAssert(packageText(bytes).trim().length>0,'invalid UTF-8 or empty source');
}
export class PackageDatabase{
  constructor(idb=globalThis.indexedDB){this.idb=idb;}
  open(){if(!this.conn)this.conn=new Promise((resolve,reject)=>{
    if(!this.idb){reject(Error('IndexedDB unavailable'));return;}
    const r=this.idb.open('wasmos.official-packages.v1',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('installed',{keyPath:'id'});
    r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();this.conn=null;};resolve(r.result);};r.onerror=()=>reject(r.error);
  }).catch(e=>{this.conn=null;throw e});return this.conn;}
  async all(){const db=await this.open();return new Promise((resolve,reject)=>{const r=db.transaction('installed').objectStore('installed').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
  async change(puts=[],drops=[]){const db=await this.open();return new Promise((resolve,reject)=>{
    const tx=db.transaction('installed','readwrite');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('Install transaction aborted'));tx.onerror=()=>{};
    const store=tx.objectStore('installed');try{for(const r of puts)store.put(r);for(const id of drops)store.delete(id);}catch(e){tx.abort();reject(e);}
  });}
}
export class OfficialPackageStore{
  constructor({db=new PackageDatabase(),fetcher=(...args)=>fetch(...args)}={}){this.db=db;this.fetcher=fetcher;this.records=new Map();this.tail=Promise.resolve();}
  list(){return Array.from(this.records.values()).sort((a,b)=>a.name.localeCompare(b.name));}
  serial(fn){const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p;}
  // No fetch on startup. A corrupt local entry is quarantined, not executed or silently deleted.
  restore(){return this.serial(async()=>{const rows=await this.db.all(),keep=new Map(),warnings=[];for(const record of rows){try{const p=validatePackage(record);pkgAssert(pkgRef.test(record.revision),'invalid cached commit');await verifyPackageBytes(p,record.payload);keep.set(p.id,{...p,payload:record.payload,revision:record.revision});}catch(e){warnings.push(String(e.message));}}this.records=keep;return warnings;});}
  async catalog(){
    const json=async(url,max)=>JSON.parse(packageText(await packageBytes(this.fetcher,url,max)));
    const ref=await json(PACKAGE_REF,32768),rev=ref?.object?.sha;
    pkgAssert(ref.ref==='refs/heads/main' && ref.object.type==='commit' && typeof rev==='string' && pkgRef.test(rev),'invalid official branch reference');
    const entries=validatePackageCatalog(await json(PACKAGE_RAW+rev+'/packages/catalog.json',256*1024));
    return {revision:rev,entries};
  }
  installBase(){return this.serial(async()=>{const snapshot=await this.catalog();return this.stage(snapshot,snapshot.entries.filter(x=>x.group==='base'));});}
  installExtras(ids,expectedRevision){return this.serial(async()=>{
    pkgAssert(Array.isArray(ids) && ids.length>0 && ids.length<=128 && new Set(ids).size===ids.length,'select distinct extras');
    const snap=await this.catalog();pkgAssert(snap.revision===expectedRevision,'catalog changed; refresh and review the selection');
    const entries=ids.map(id=>snap.entries.find(x=>x.group==='extra'&&x.id===id));pkgAssert(entries.every(Boolean),'not an optional package');
    return this.stage(snap,entries);
  });}
  async stage(snap,rows){
    pkgAssert(rows.reduce((v,r)=>v+r.bytes,0)<=48*1024*1024,'selection too large');
    const ready=[];let cursor=0;
    const workers=await Promise.allSettled(Array.from({length:Math.min(rows.length,4)},async()=>{
      while(cursor<rows.length){const p=rows[cursor++],old=this.records.get(p.id);
        const payload=old?.sha256===p.sha256?old.payload:await packageBytes(this.fetcher,PACKAGE_RAW+snap.revision+'/'+p.path,p.bytes);
        await verifyPackageBytes(p,payload);ready.push({...p,payload,revision:snap.revision});
      }
    }));const failed=workers.find(r=>r.status==='rejected');if(failed)throw failed.reason;
    await this.db.change(ready);for(const r of ready)this.records.set(r.id,r);return ready.length;
  }
  remove(id){return this.serial(async()=>{await this.db.change([],[id]);this.records.delete(id);});}
}
