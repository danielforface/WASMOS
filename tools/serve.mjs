import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const root=resolve('dist/shell'),types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.woff2':'font/woff2','.ts':'text/plain; charset=utf-8'};
createServer(async(req,res)=>{try{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(root+sep)||!['GET','HEAD'].includes(req.method))throw Error();
  const bytes=await readFile(file);res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?undefined:bytes);
}catch{res.writeHead(404);res.end()}}).listen(4173,'127.0.0.1',()=>console.log('Studio: http://127.0.0.1:4173'));
