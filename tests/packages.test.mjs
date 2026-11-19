import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Script,runInNewContext} from 'node:vm';
import {IDBFactory} from 'fake-indexeddb';
import {OfficialPackageStore,PackageDatabase,validatePackageCatalog,verifyPackageBytes} from '../host/package-store.mjs';
const text=p=>readFile(p,'utf8'), catalog=JSON.parse(await text('packages/catalog.json')),rows=validatePackageCatalog(catalog);
const rev='abcd'.repeat(10),next='ef01'.repeat(10),raw='https://raw.githubusercontent.com/danielforface/WASMOS/';
function fixture(){
 const db=new PackageDatabase(new IDBFactory()),requests=[],state={revision:rev,bad:'',offline:false,bytes:null,manifest:catalog};
 const f=async(url,opt)=>{
   requests.push(url);if(state.offline)throw Error('offline');assert.equal(opt.credentials,'omit');assert.equal(opt.redirect,'error');assert.equal(opt.referrerPolicy,'no-referrer');
   if(url==='https://api.github.com/repos/danielforface/WASMOS/git/ref/heads/main')return Response.json({ref:'refs/heads/main',object:{type:'commit',sha:state.revision}});
   assert.ok(url.startsWith(raw+state.revision+'/'),url);const p=url.slice((raw+state.revision+'/').length);
   if(p==='packages/catalog.json')return Response.json(state.manifest);
   if(state.bad===p)return new Response(state.bytes??'broken');
   return new Response(await readFile(p));
 };
 return {db,state,requests,f,store:new OfficialPackageStore({db,fetcher:f})};
}
test('fresh launch lists zero, performs zero network calls; base is atomic, contains no extra payload',async()=>{
 const {db,store,state,requests,f}=fixture();await store.restore();assert.equal(requests.length,0);assert.deepEqual(store.list(),[]);
 const n=await store.installBase(),base=rows.filter(p=>p.group==='base');assert.equal(n,base.length);
 assert.deepEqual(store.list().map(p=>p.id).sort(),base.map(p=>p.id).sort());assert.deepEqual(requests.slice(2).sort(),base.map(p=>raw+rev+'/'+p.path).sort());
 requests.length=0;await store.installBase();assert.equal(requests.length,2);assert.equal((await db.all()).length,n);
 state.offline=true;requests.length=0;const reopened=new OfficialPackageStore({db,fetcher:f});assert.deepEqual(await reopened.restore(),[]);assert.equal(reopened.list().length,n);assert.equal(requests.length,0);
});
test('refresh lists only metadata; selected extra installs without base or any unselected payload and can be removed offline',async()=>{
 const {db,store,state,requests,f}=fixture();const s=await store.catalog();assert.equal(requests.length,2);const pick=s.entries.find(p=>p.group==='extra'&&p.format==='wasm');
 await store.installExtras([pick.id],rev);assert.deepEqual(store.list().map(p=>p.id),[pick.id]);assert.equal(requests.filter(u=>u.includes('/extra/')).length,1);
 const result=await WebAssembly.instantiate(store.list()[0].payload);assert.equal(result.instance.exports.fibonacci(12),144);
 state.offline=true;await store.remove(pick.id);const again=new OfficialPackageStore({db,fetcher:f});await again.restore();assert.deepEqual(again.list(),[]);
});
test('extra selection cannot smuggle a base ID, stale review, duplicate ID or foreign URL',async()=>{
 const {store,state,requests}=fixture();const base=rows.find(p=>p.group==='base').id,extra=rows.find(p=>p.group==='extra').id;
 for(const sel of [[base],[extra,extra],['https://other.invalid/pkg'],[]])await assert.rejects(store.installExtras(sel,rev));
 state.revision=next;await assert.rejects(store.installExtras([extra],rev),/changed/);assert.ok(requests.every(u=>!u.includes('/base/')&&!u.includes('/extra/')));
});
test('failed download does not leak a partial base or overwrite an already installed release',async()=>{
 const {store,db,state}=fixture(),chosen=rows.find(p=>p.group==='base'&&p.format==='panel');state.bad=chosen.path;
 await assert.rejects(store.installBase(),/integrity/);assert.equal((await db.all()).length,0);
 state.bad='';await store.installBase();const original=Array.from(store.records.keys()),newBytes=new TextEncoder().encode('new official revision');
 state.revision=next;state.manifest=structuredClone(catalog);const update=state.manifest.packages.find(x=>x.id===chosen.id);update.version='2.0.0';update.bytes=newBytes.length;update.sha256=createHash('sha256').update(newBytes).digest('hex');
 state.bad=chosen.path;await assert.rejects(store.installBase());assert.deepEqual(Array.from(store.records.keys()),original);assert.ok((await db.all()).every(p=>p.revision===rev));
 state.bytes=newBytes;await store.installBase();assert.equal(store.records.get(chosen.id).version,'2.0.0');assert.ok((await db.all()).every(p=>p.revision===next));
});
test('transaction failure leaves memory and durable installs unchanged; bad cached bytes never launch',async()=>{
 const {db,store,f}=fixture();const change=db.change.bind(db);db.change=()=>Promise.reject(Error('quota'));
 await assert.rejects(store.installBase(),/quota/);assert.equal(store.list().length,0);db.change=change;await store.installBase();
 const p=store.list()[0];await db.change([{...p,payload:new Uint8Array(p.bytes)}]);const again=new OfficialPackageStore({db,fetcher:f});const warnings=await again.restore();
 assert.equal(warnings.length,1);assert.equal(again.records.has(p.id),false);assert.equal(again.list().length,store.list().length-1);
});
test('schema rejects path traversal, executable URL, unsafe metadata, unknown permissions, duplicate and oversized rows',()=>{
 const p=rows[0];for(const patch of [{path:'../package.json'},{path:'https://other.invalid/file'},{format:'constructor'},{capabilities:['root']},{bytes:1e9},{name:'<script>'},{sha256:'x'.repeat(64)},{group:'boot'}]){
   assert.throws(()=>validatePackageCatalog({schema:catalog.schema,packages:[{...p,...patch}]}));
 }assert.throws(()=>validatePackageCatalog({schema:catalog.schema,packages:[p,p]}),/duplicate/);
});
test('on-disk catalog is valid; packaged shell has no package payload, catalog file, provider ID or compiled app directory',async()=>{
 const shell=await text('dist/shell/index.html');assert.deepEqual((await readdir('dist/shell')).sort(),['index.html','vendor']);
 for(const p of rows){await verifyPackageBytes(p,new Uint8Array(await readFile(p.path)));assert.ok(!shell.includes(p.id),p.id);assert.ok(!shell.includes(p.path),p.path);}
 for(const [,code] of shell.matchAll(/<script>([\s\S]*?)<\/script>/gi))new Script(code);
 const template=await text('host/studio.template.html');assert.doesNotMatch(template,/BROWSER_B64|OS_CORE_SERVICES|OS_BUILTIN_APPS|CODE_SAMPLES/);
 const tauri=JSON.parse(await text('src-tauri/tauri.conf.json'));assert.equal(tauri.build.frontendDist,'../dist/shell');
});
test('real panel service math and clock handlers, and syntax of all standalone panel scripts',async()=>{
 const handlers=new Map(),dummy={};const env={wasmos:{provide:(name,fn)=>handlers.set(name,fn)},document:{querySelector:()=>dummy,getElementById:()=>dummy},performance,setInterval:()=>0,Date,Intl};
 for(const p of rows.filter(x=>x.format==='panel'&&x.slug!=='nebula')){
   const source=await text(p.path);for(const [,js] of source.matchAll(/<script>([\s\S]*?)<\/script>/gi)){new Script(js);if(['clock','calculator'].includes(p.slug))runInNewContext(js,env);}
 }
 const calc=handlers.get('os.math');assert.equal(calc('calculate',{expression:'(12+3)*4 / 2'}).result,30);assert.equal(calc('calculate',{expression:'2^3^2'}).result,512);
 assert.throws(()=>calc('calculate',{expression:'1/0'}));assert.throws(()=>calc('calculate',{expression:'someFunction()'}));
 assert.ok(handlers.get('os.time')().epochMs>0);
 const neb=await text('packages/extra/nebula/main.html'),wasm=Buffer.from(neb.match(/id="vfs-module">([^<]+)</)[1],'base64');assert.ok(WebAssembly.validate(wasm));assert.ok(!/<script[^>]*\bsrc=/i.test(neb));
});
