// Run our Go test binary in WASI preview1 with no directories, env or socket imports.
import fs from 'node:fs/promises';
import {WASI} from 'node:wasi';
const [file,...args]=process.argv.slice(2),mod=await WebAssembly.compile(await fs.readFile(file));
const wasi=new WASI({version:'preview1',args:['wasmos-transport',...args],env:{},preopens:{},returnOnExit:true});
const imports=wasi.getImportObject();
for(const {module,name} of WebAssembly.Module.imports(mod)){
  if(module!=='wasi_snapshot_preview1')throw Error('Unexpected module '+module);
  if(name.startsWith('sock_')) imports[module][name]=()=>76; // ENOTCAPABLE
}
const instance=await WebAssembly.instantiate(mod,imports);process.exitCode=wasi.start(instance);
