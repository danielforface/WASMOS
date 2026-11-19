import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {JSDOM,VirtualConsole} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

test('assembled OS DOM: click both installers, keep the extra selection optional, close and relaunch offline',async()=>{
 const html=await readFile('dist/shell/index.html','utf8'),cat=JSON.parse(await readFile('packages/catalog.json')),db=new IDBFactory(),calls=[],errors=[];
 let online=true;const rev='c0ffee00'.repeat(5);
 const fetcher=async url=>{assert.ok(online,'unexpected network after restart');calls.push(url);
   if(url==='https://api.github.com/repos/danielforface/WASMOS/git/ref/heads/main')return Response.json({ref:'refs/heads/main',object:{type:'commit',sha:rev}});
   const root='https://raw.githubusercontent.com/danielforface/WASMOS/'+rev+'/';assert.ok(url.startsWith(root));const f=url.slice(root.length);
   assert.ok(f==='packages/catalog.json'||cat.packages.some(p=>p.path===f));return new Response(await readFile(f));
 };
 const boot=async()=>{
   const vc=new VirtualConsole();vc.on('jsdomError',e=>{if(!e.message.startsWith('Not implemented:'))errors.push(e.message);});
   const d=new JSDOM(html,{url:'http://localhost:4173/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){
     for(const [k,v] of Object.entries({indexedDB:db,crypto:webcrypto,fetch:fetcher,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,AbortController,structuredClone,MessageChannel,confirm:()=>true,matchMedia:()=>({matches:false,addEventListener(){}})}))Object.defineProperty(w,k,{value:v,configurable:true});
     // This test exercises the OS and DOM, not the network-loaded Monaco editor or a rendering engine.
     w.require=()=>{};w.require.config=()=>{};
   }});
   if(d.window.document.readyState!=='complete')await new Promise(r=>d.window.addEventListener('load',r,{once:true}));return d;
 };
 async function wait(check){for(let i=0;i<150;i++){if(check())return;await delay(20);}assert.fail('UI condition timed out: '+errors.join('; '));}
 let d=await boot();try{
   let doc=d.window.document;const base=cat.packages.filter(x=>x.group==='base').length;
   assert.equal(doc.querySelectorAll('[data-package-id]').length,0);assert.equal(calls.length,0);assert.deepEqual(Array.from(d.window.WASM_OS_V31.graph().services),[]);
   doc.querySelector('#package-desktop-bar [data-install-base]').click();await wait(()=>doc.querySelectorAll('[data-package-id]').length===base);
   assert.equal(calls.filter(p=>p.includes('/extra/')).length,0);assert.equal(d.window.WASM_OS_V31.graph().services.length,0);
   doc.querySelector('#package-desktop-bar [data-browse-extras]').click();await wait(()=>doc.querySelector('[data-catalog-list] input'));
   const list=doc.querySelector('[data-catalog-list]');list.querySelector('input[value="wasmos.extra.fibonacci"]').click();list.querySelector('button').click();
   await wait(()=>doc.querySelector('[data-package-id="wasmos.extra.fibonacci"]'));assert.equal(calls.filter(p=>p.includes('/extra/')).length,1);
   d.window.close();online=false;calls.length=0;d=await boot();doc=d.window.document;await wait(()=>doc.querySelectorAll('[data-package-id]').length===base+1);
   doc.querySelector('[data-package-id="wasmos.extra.fibonacci"] button').click();await wait(()=>d.window.WASM_OS_V31.graph().apps.some(a=>a.appId==='wasmos.extra.fibonacci'&&a.running));
   doc.querySelector('[aria-label="הסרה: Fibonacci benchmark"]').click();await wait(()=>doc.querySelectorAll('[data-package-id]').length===base);
   assert.equal(d.window.WASM_OS_V31.graph().apps.some(a=>a.appId==='wasmos.extra.fibonacci'),false);assert.deepEqual(calls,[]);assert.deepEqual(errors,[]);
 }finally{d.window.close();}
});
