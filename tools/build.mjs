import {readFile,writeFile,cp,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stripAutoSdk,withSdk} from '../sdk/source.mjs';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const read=p=>readFile(p,'utf8');
const json=async p=>JSON.parse(await read(p));
const [abi,helpers,catalog,roots]=await Promise.all([json('sdk/host-abi.json'),read('sdk/stdlib.ts'),json('apps/catalog.json'),json('trust/roots.json')]);
if (new Set(abi.map(x=>x.name)).size!==abi.length) throw Error('Duplicate Host ABI names');
const sdk=['// --- WASM ARCHITECT STUDIO AUTO-INJECTED STDLIB START ---',...abi.map(x=>x.declaration),helpers.trimEnd(),'// --- WASM ARCHITECT STUDIO AUTO-INJECTED STDLIB END ---',''].join('\n');
const browser=stripAutoSdk(await read('apps/browser/main.ts'));
const imports={assemblyscript:'./vendor/assemblyscript.js','assemblyscript/asc':'./vendor/asc.js',binaryen:'./vendor/binaryen.js',long:'./vendor/long.js'};
const slots={HOST_ABI:JSON.stringify(abi),SDK_STRING:JSON.stringify(sdk),ROOTS:JSON.stringify(roots),BROWSER_B64:Buffer.from(browser).toString('base64'),SDK_SOURCE_FUNCTIONS:stripAutoSdk.toString()+'\n'+withSdk.toString(),COMPILER_IMPORTMAP:'<script type="importmap">'+JSON.stringify({imports})+'</script>'};
const template=await read('host/studio.template.html');
for(const key of Object.keys(slots))if(template.split('@@'+key+'@@').length!==2)throw Error('Missing/duplicate host slot: '+key);
const html=template.replace(/@@([A-Z_0-9]+)@@/g,(_,k)=>{if(!(k in slots))throw Error(k);return slots[k]});
await mkdir('dist/apps',{recursive:true});await mkdir('dist/vendor',{recursive:true});
await Promise.all([writeFile('dist/index.html',html),writeFile('dist/apps/catalog.json',JSON.stringify(catalog.map(({id,name})=>({id,name,source:id+'.ts',wasm:id+'.wasm'})),null,2)),...catalog.map(async a=>writeFile('dist/apps/'+a.id+'.ts',withSdk(await read(a.source),sdk)))]);
function run(bin,args){const r=spawnSync(process.execPath,[bin,...args],{stdio:'inherit'});if(r.status!==0)throw Error(bin+' failed: '+(r.status??r.error));}
if(!process.argv.includes('--sources-only')){
  const files={'assemblyscript/dist/assemblyscript.js':'assemblyscript.js','assemblyscript/dist/asc.js':'asc.js','binaryen/index.js':'binaryen.js','long/index.js':'long.js','hls.js/dist/hls.min.js':'hls.min.js','monaco-editor/min/vs':'vs','@fortawesome/fontawesome-free/css/all.min.css':'fontawesome/css/all.min.css','@fortawesome/fontawesome-free/webfonts':'fontawesome/webfonts'};
  for(const name of ['ort.wasm.min.js','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'])files['onnxruntime-web/dist/'+name]='ort/'+name;
  await Promise.all(Object.entries(files).map(([from,to])=>cp('node_modules/'+from,'dist/vendor/'+to,{recursive:true})));
  run('node_modules/tailwindcss/lib/cli.js',['-c','tailwind.config.cjs','-i','host/style.css','-o','dist/vendor/studio.css','--minify']);
  for(const {id} of catalog){
    const file='dist/apps/'+id;
    const source=await read(file+'.ts');
    run('node_modules/assemblyscript/bin/asc.js',[file+'.ts','--outFile',file+'.wasm','--runtime','incremental','--exportRuntime','-O3','--shrinkLevel','0','--converge','--noAssert',...(/@wasm-feature\s+simd|\bv128\s*\./i.test(source)?['--enable','simd']:[])]);
    const mod=new WebAssembly.Module(await readFile(file+'.wasm'));
    for(const imp of WebAssembly.Module.imports(mod))if(imp.module==='host'&&!abi.some(x=>x.name===imp.name))throw Error('Unknown import '+imp.name);
    console.log('Built',id);
  }
}
