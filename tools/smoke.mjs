import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
const url='http://127.0.0.1:4173',ref='1234567890abcdef1234567890abcdef12345678';
const catalog=JSON.parse(await readFile('packages/catalog.json','utf8')),base=catalog.packages.filter(p=>p.group==='base');
const server=spawn(process.execPath,['tools/serve.mjs']);server.on('error',e=>console.error(e.message));
let browser;
try{
 for(let i=0;i<50;i++){try{if((await fetch(url)).ok)break}catch{}await delay(100);}
 const executablePath=process.env.CHROME_PATH||['/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);
 browser=await chromium.launch({executablePath,headless:true,args:['--disable-dev-shm-usage']});
 const ctx=await browser.newContext({serviceWorkers:'block'}),page=await ctx.newPage(),errors=[],external=[],packageRequests=[];
 let offline=false;
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await ctx.route(/^https?:/,async route=>{const path=route.request().url();if(new URL(path).origin===url)return route.continue();
   const raw='https://raw.githubusercontent.com/danielforface/WASMOS/'+ref+'/';
   const headers={'access-control-allow-origin':'*','content-type':'application/octet-stream'};
   if(path==='https://api.github.com/repos/danielforface/WASMOS/git/ref/heads/main'){packageRequests.push(path);if(offline)return route.abort();
     return route.fulfill({headers,body:JSON.stringify({ref:'refs/heads/main',object:{type:'commit',sha:ref}})});}
   if(path.startsWith(raw)){const f=path.slice(raw.length);packageRequests.push(f);if(offline)return route.abort();
     if(f==='packages/catalog.json'||catalog.packages.some(p=>p.path===f))return route.fulfill({headers,body:await readFile(f)});}
   external.push(path);return route.abort();
 });
 await page.goto(url);await page.locator('#package-desktop-bar [data-install-base]').waitFor({state:'visible'});
 assert.equal(await page.locator('[data-package-id]').count(),0);assert.deepEqual(packageRequests,[]);
 await page.locator('#package-desktop-bar [data-install-base]').click();
 await page.waitForFunction(n=>document.querySelectorAll('[data-package-id]').length===n,base.length);
 assert.ok(!packageRequests.some(x=>x.includes('/extra/')));
 assert.equal(await page.evaluate(()=>WASM_OS_V31.graph().services.length),0);
 await page.locator('[data-package-id="wasmos.system.clock"] button').first().click();
 await page.waitForFunction(()=>WASM_OS_V31.graph().services.some(s=>s.name==='os.time'));
 const clock=page.frameLocator('iframe[title="Clock"]');assert.ok(await clock.locator('time').textContent());
 assert.equal(await clock.locator('html').evaluate(()=>location.origin),'null'); // srcdoc URL itself has opaque origin
 await page.locator('#package-desktop-bar [data-browse-extras]').click();
 const list=page.locator('[data-catalog-list]');await list.locator('input[value="wasmos.extra.fibonacci"]').check();await list.getByRole('button',{name:'התקנת הבחירה'}).click();
 await page.locator('[data-package-id="wasmos.extra.fibonacci"]').waitFor();assert.deepEqual(packageRequests.filter(p=>p.startsWith('packages/extra/')),['packages/extra/fibonacci/main.wasm']);
 packageRequests.length=0;offline=true;await page.reload();await page.locator('[data-package-id="wasmos.extra.fibonacci"]').waitFor();assert.deepEqual(packageRequests,[]);
 assert.equal(await page.evaluate(()=>WASM_OS_V31.graph().services.length),0);
 await page.locator('[data-package-id="wasmos.extra.fibonacci"] button').first().click();await page.waitForFunction(()=>WASM_OS_V31.graph().apps.some(x=>x.appId==='wasmos.extra.fibonacci'&&x.running));
 await page.locator('[data-package-id="wasmos.extra.fibonacci"]').getByRole('button',{name:'הסרה: Fibonacci benchmark'}).click();
 await page.locator('[data-package-id="wasmos.extra.fibonacci"]').waitFor({state:'detached'});
 await page.waitForFunction(()=>!!window.__WASM_ARCHITECT_ASC__,undefined,{timeout:60000});
 const source=(await readFile('build/apps/browser.ts','utf8')).replace(/^  static (emitJson|load)\([^\n]+\n/gm,'');
 const result=await page.evaluate(async src=>{const b=await WASM_OS_V31.compileImportedSource(src);return {size:b.byteLength,valid:WebAssembly.validate(b)};},source);
 assert.ok(result.valid&&result.size>0);assert.deepEqual(packageRequests,[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);console.log('Chromium: clean shell → base → provider → selected extra → offline reload → WASM launch/remove; offline Studio import/compile',result);
}finally{await browser?.close();server.kill();}
