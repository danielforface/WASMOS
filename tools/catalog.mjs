import {readFile,readdir,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validatePackageCatalog} from '../host/package-store.mjs';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const formats={assemblyscript:'ts',wasm:'wasm',panel:'html'},packages=[];
for(const group of ['base','extra']){
  const dirs=await readdir('packages/'+group,{withFileTypes:true});
  for(const d of dirs.sort((a,b)=>a.name<b.name?-1:1)){
    if(!d.isDirectory())throw Error('Unexpected entry '+d.name);
    const slug=d.name,root='packages/'+group+'/'+slug,meta=JSON.parse(await readFile(root+'/package.json','utf8'));
    const path=root+'/main.'+formats[meta.format];if(!(await lstat(path)).isFile())throw Error('Payload must be a regular file: '+path);
    const bytes=await readFile(path);
    packages.push({...meta,group,slug,path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
}
const doc={schema:'wasmos.packages/1',packages:validatePackageCatalog({schema:'wasmos.packages/1',packages})};
const src=JSON.stringify(doc,null,2)+'\n';
if(process.argv.includes('--check')){if(src!==await readFile('packages/catalog.json','utf8'))throw Error('Stale official catalog. Run npm run catalog');}
else await writeFile('packages/catalog.json',src);
console.log('Official catalog:',...['base','extra'].map(g=>g+'='+packages.filter(p=>p.group===g).length));
