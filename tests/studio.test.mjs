import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {X509Certificate,createHash} from 'node:crypto';
import {stripAutoSdk,withSdk} from '../sdk/source.mjs';
const text=p=>readFile(p,'utf8');
const old='// --- WASM ARCHITECT STUDIO AUTO-INJECTED STDLIB START ---\r\nclass Stale {}\r\n// --- WASM ARCHITECT STUDIO AUTO-INJECTED STDLIB END ---\r\n';
test('only a complete generated prelude at the start is replaced',()=>{
 const app='// a comment mentioning AUTO-INJECTED STDLIB must survive\nexport function appStart():void {}';
 assert.equal(stripAutoSdk('\uFEFF\r\n'+old+old+app),app);
 assert.equal(stripAutoSdk(app+'\n'+old),app+'\n'+old);
 assert.throws(()=>stripAutoSdk(old.split('\r\n')[0]+'\n'+app),/Malformed/);
 assert.throws(()=>stripAutoSdk(old.split('\r\n')[0]+'\n'+old+app),/Malformed/);
 assert.equal(withSdk(old+app,'fresh'),'fresh\n'+app);
});
const html=await text('dist/index.html'),raw=await text('apps/browser/main.ts'),exp=await text('dist/apps/browser.ts');
test('Host, CLI and browser launcher use the identical SDK and application',()=>{
 const literal=html.match(/^const WASM_ARCHITECT_STDLIB = (".*");$/m);assert.ok(literal);
 const sdk=JSON.parse(literal[1]);
 assert.equal(withSdk(raw,sdk),exp);assert.equal(stripAutoSdk(exp).trimStart(),raw);
 assert.equal(Buffer.from(html.match(/OS_SYSTEM_BROWSER_SOURCE_B64 = '([^']+)'/)[1],'base64').toString(),raw);
 assert.match(html,/source = withSdk\(source, WASM_ARCHITECT_STDLIB\)/);
 assert.match(html,/const exportCode = withSdk\(tab.content, WASM_ARCHITECT_STDLIB\)/);
 assert.match(html,/text = stripAutoSdk\(text\)/);
});
test('all catalog apps are valid Wasm with only declared host calls',async()=>{
 const abi=JSON.parse(await text('sdk/host-abi.json')),names=new Set(abi.map(x=>x.name));assert.equal(names.size,abi.length);
 for(const {id} of JSON.parse(await text('apps/catalog.json'))){
  const binary=await readFile('dist/apps/'+id+'.wasm');assert.ok(WebAssembly.validate(binary),id);
  for(const imp of WebAssembly.Module.imports(new WebAssembly.Module(binary)))assert.ok(imp.module==='host'?names.has(imp.name):imp.module==='env'&&imp.name==='abort',id+': '+imp.module+'.'+imp.name);
 }
});
test('the conservative trust snapshot is internally consistent',async()=>{
 const roots=JSON.parse(await text('trust/roots.json')),blocked=JSON.parse(await text('trust/blocked-spki.json'));
 const legacy=JSON.parse(await text('trust/legacy-fingerprints.json'));
 assert.equal(legacy.length,121);assert.equal(roots.length,113);assert.equal(new Set(roots).size,roots.length);
 assert.deepEqual(JSON.parse(raw.match(/^const BLOCKED_SPKI_HEX:string\[\]=(.*);$/m)[1]),blocked);
 for(const s of roots){const x=new X509Certificate(Buffer.from(s,'base64'));assert.ok(legacy.some(l=>l.sha256===x.fingerprint256.replaceAll(':','')));assert.ok(!blocked.includes(createHash('sha256').update(x.publicKey.export({type:'spki',format:'der'})).digest('hex').toUpperCase()));}
});
test('regression tests run inside the actual compiled guest, including UTF-8 ABI forwarding',async()=>{
 const extra=`
 export function sdkProbe():i32 {return OsService.emitJson(17,"שלום","✓");}
 export function loadProbe():i32 {return OsService.load(9,2,3,32,1.25);}
 export function noRoots():i32 {let c=new TlsConnection();c.phase=TLS_PHASE_CHAIN_VERIFY;c.certs.push(new CertificateInfo());tlsContinueChain(c);return !c.chainTrusted && c.phase==TLS_PHASE_FAILED ? 1:0;}
 export function finishPolicy(flags:i32):bool {let c=new TlsConnection();c.phase=TLS_PHASE_SERVER_FLIGHT;c.eeSeen=(flags&1)!=0;c.chainTrusted=(flags&2)!=0;c.signatureChecked=(flags&4)!=0;c.resumed=(flags&8)!=0;c.policyUntil=(flags&16)!=0?101:99;return tlsMayFinish(c);}
 `;
 const dir=await mkdtemp(join(tmpdir(),'wasmos-test-')),src=join(dir,'probe.ts'),out=join(dir,'probe.wasm');await writeFile(src,exp+'\n'+extra);
 const r=spawnSync(process.execPath,['node_modules/assemblyscript/bin/asc.js',src,'-o',out,'--runtime','incremental'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const mod=await WebAssembly.compile(await readFile(out));let instance,seen=0;
 const imports={env:{abort(){throw Error('WASM abort')}},host:{}};
 for(const imp of WebAssembly.Module.imports(mod))if(imp.module==='host')imports.host[imp.name]=()=>0;
 imports.host.epoch_ms=()=>100;
 imports.host.svc_emit=(id,t,n,p,m)=>{let b=new Uint8Array(instance.exports.memory.buffer),d=new TextDecoder();assert.deepEqual([id,n,m,d.decode(b.slice(t,t+n)),d.decode(b.slice(p,p+m))],[17,8,3,'שלום','✓']);seen++;return -7};
 imports.host.svc_set_load=(...v)=>{assert.deepEqual(v,[9,2,3,32,1.25]);seen++;return 12};
 instance=await WebAssembly.instantiate(mod,imports);const e=instance.exports;
 assert.equal(e.sdkProbe(),-7);assert.equal(e.loadProbe(),12);assert.equal(seen,2);assert.equal(e.noRoots(),1);
 for(let i=0;i<32;i++)assert.equal(!!e.finishPolicy(i),!!(i&1)&&!!(i&16)&&(!!(i&8)||(i&6)===6),'flags '+i);
});
