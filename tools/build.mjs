import {readFile,writeFile,cp,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stripAutoSdk,withSdk} from '../sdk/source.mjs';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const read=p=>readFile(p,'utf8');
const json=async p=>JSON.parse(await read(p));
const [abi,helpers,roots]=await Promise.all([json('sdk/host-abi.json'),read('sdk/stdlib.ts'),json('trust/roots.json')]);
if (new Set(abi.map(x=>x.name)).size!==abi.length) throw Error('Duplicate Host ABI names');
const sdk=['// --- WASM ARCHITECT STUDIO AUTO-INJECTED STDLIB START ---',...abi.map(x=>x.declaration),helpers.trimEnd(),'// --- WASM ARCHITECT STUDIO AUTO-INJECTED STDLIB END ---',''].join('\n');
const imports={assemblyscript:'./vendor/assemblyscript.js','assemblyscript/asc':'./vendor/asc.js',binaryen:'./vendor/binaryen.js',long:'./vendor/long.js'};
const runtime=(await Promise.all(['host/package-store.mjs','host/package-panel.js','host/package-ui.js'].map(read))).join('\n').replace(/^export /gm,'');
const slots={HOST_ABI:JSON.stringify(abi),SDK_STRING:JSON.stringify(sdk),ROOTS:JSON.stringify(roots),PACKAGE_RUNTIME:runtime,SDK_SOURCE_FUNCTIONS:stripAutoSdk.toString()+'\n'+withSdk.toString(),COMPILER_IMPORTMAP:'<script type="importmap">'+JSON.stringify({imports})+'</script>'};
const template=await read('host/studio.template.html');
for(const key of Object.keys(slots))if(template.split('@@'+key+'@@').length!==2)throw Error('Missing/duplicate host slot: '+key);
const html=template.replace(/@@([A-Z_0-9]+)@@/g,(_,k)=>{if(!(k in slots))throw Error(k);return slots[k]});
await mkdir('dist/shell/vendor',{recursive:true});
await writeFile('dist/shell/index.html',html);
function run(bin,args){const r=spawnSync(process.execPath,[bin,...args],{stdio:'inherit'});if(r.status!==0)throw Error(bin+' failed: '+(r.status??r.error));}
if(!process.argv.includes('--sources-only')){
  const files={'assemblyscript/dist/assemblyscript.js':'assemblyscript.js','assemblyscript/dist/asc.js':'asc.js','binaryen/index.js':'binaryen.js','long/index.js':'long.js','hls.js/dist/hls.min.js':'hls.min.js','monaco-editor/min/vs':'vs','@fortawesome/fontawesome-free/css/all.min.css':'fontawesome/css/all.min.css','@fortawesome/fontawesome-free/webfonts':'fontawesome/webfonts'};
  for(const name of ['ort.wasm.min.js','ort-wasm-simd-threaded.mjs','ort-wasm-simd-threaded.wasm'])files['onnxruntime-web/dist/'+name]='ort/'+name;
  await Promise.all(Object.entries(files).map(([from,to])=>cp('node_modules/'+from,'dist/shell/vendor/'+to,{recursive:true})));
  run('node_modules/tailwindcss/lib/cli.js',['-c','tailwind.config.cjs','-i','host/style.css','-o','dist/shell/vendor/studio.css','--minify']);
}
if(!process.argv.includes('--shell-only')){
  const catalog=(await json('packages/catalog.json')).packages;
  await mkdir('build/apps',{recursive:true});
  for(const {slug:id,path,format} of catalog.filter(p=>p.format==='assemblyscript')){
    const file='build/apps/'+id,source=withSdk(await read(path),sdk);
    await writeFile(file+'.ts',source);
    if(process.argv.includes('--sources-only'))continue;
    run('node_modules/assemblyscript/bin/asc.js',[file+'.ts','--outFile',file+'.wasm','--runtime','incremental','--exportRuntime','-O3','--shrinkLevel','0','--converge','--noAssert',...(/@wasm-feature\s+simd|\bv128\s*\./i.test(source)?['--enable','simd']:[])]);
    const mod=new WebAssembly.Module(await readFile(file+'.wasm'));
    for(const imp of WebAssembly.Module.imports(mod))if(imp.module==='host'&&!abi.some(x=>x.name===imp.name))throw Error('Unknown import '+imp.name);
    console.log('Built',id);
  }
}
