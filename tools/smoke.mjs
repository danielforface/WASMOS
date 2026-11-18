import {chromium} from 'playwright-core';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
const url='http://127.0.0.1:4173',server=spawn(process.execPath,['tools/serve.mjs']);
let browser;
try{
 for(let i=0;i<60;i++){try{if((await fetch(url)).ok)break}catch{}await delay(100)}
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/chromium',headless:true,args:['--disable-dev-shm-usage']});
 const page=await browser.newPage();const errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route(/^https?:/,route=>{if(new URL(route.request().url()).origin!==url){external.push(route.request().url());return route.abort()}return route.continue()});
 await page.goto(url);await page.waitForFunction(()=>!!window.__WASM_ARCHITECT_ASC__&&typeof compileTab==='function',undefined,{timeout:60000});
 const result=await page.evaluate(async()=>{
   const original=await(await fetch('/apps/browser.ts')).text();
   const stale=original.replace(/^  static (emitJson|load)\([^\n]+\n/gm,'');
   const body=stripAutoSdk(stale);
   const bytes=await compileTab({id:-17,name:'system_browser.ts',kind:'source',content:body,dirty:true},{log:false});
   return {size:bytes.byteLength,valid:WebAssembly.validate(bytes),roots:WASM_OS_TRUST_ANCHORS_B64.length,imports:HOST_ABI_MANIFEST.length};
 });assert.ok(result.valid&&result.size>0&&result.roots===113);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);console.log('Offline Chromium Studio import → compile:',result);
}finally{await browser?.close();server.kill()}
