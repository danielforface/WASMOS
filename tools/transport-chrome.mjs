import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
const dir=new URL('../dist/',import.meta.url),server=createServer(async(req,res)=>{
 try{if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end('<title>Local worker integration</title>');}
   const allowed=/^\/(?:packet-engine\.wasm|packet-worker\/(?:[\w-]+\.mjs|wasi\/[\w-]+\.js))$/;
   if(!allowed.test(req.url))throw Error();const bytes=await readFile(new URL(req.url.slice(1),dir));
   res.writeHead(200,{'content-type':req.url.endsWith('.wasm')?'application/wasm':'text/javascript'});res.end(bytes);
 }catch{res.writeHead(404);res.end();}
});
await new Promise((r,j)=>server.once('error',j).listen(0,'127.0.0.1',r));let browser;
try{browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true});
 const base='http://127.0.0.1:'+server.address().port,page=await browser.newPage(),external=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));await page.context().route(/^https?:/,route=>{if(new URL(route.request().url()).origin===base)return route.continue();external.push(route.request().url());return route.abort();});await page.goto(base);
 const result=await page.evaluate(async()=>{
   const {PacketWorkerSession:S}=await import('/packet-worker/worker-session.mjs'),mod=await WebAssembly.compileStreaming(fetch('/packet-engine.wasm'));
   const ctl=new AbortController(),opts={signal:ctl.signal},l='192.0.2.20:4300',r='192.0.2.21:4301',conf=(local,remote)=>({op:'rtc',local,remote,origin:'https://app.example'});
   const [a,b]=await Promise.all([S.open(mod,conf(l,r),opts),S.open(mod,conf(r,l),opts)]);
   let ap=[],bp=[],ac=[{op:'channel',label:'browser-worker'},{op:'offer'}],bc=[],msg='',count=0,heartbeats=0;
   const timer=setInterval(()=>heartbeats++,5),until=performance.now()+25000;
   try{while(!msg&&performance.now()<until){const [ar,br]=await Promise.all([a.pump(ap,ac),b.pump(bp,bc)]);ap=br.packets;bp=ar.packets;count+=ap.length+bp.length;ac=[];bc=[];
     for(const e of ar.events){if(e.type==='error')throw Error(e.text);if(e.type==='offer')bc.push({op:'answer',sdp:e.text});if(e.type==='channel')ac.push({op:'message',id:e.id,data:btoa('from Chromium Worker')});}
     for(const e of br.events){if(e.type==='error')throw Error(e.text);if(e.type==='answer')ac.push({op:'accept-answer',sdp:e.text});if(e.type==='message')msg=atob(e.data);}
     await new Promise(r=>setTimeout(r,3));
   }return {msg,count,heartbeats};}finally{clearInterval(timer);ctl.abort();a.close();b.close();}
 });assert.equal(result.msg,'from Chromium Worker');assert.ok(result.count>0&&result.heartbeats>0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);console.log(result);
}finally{await browser?.close();server.close();}
