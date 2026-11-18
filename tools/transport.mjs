import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
const dir=fileURLToPath(new URL('../transport/',import.meta.url));
mkdirSync(new URL('../dist/',import.meta.url),{recursive:true});mkdirSync(new URL('../build/',import.meta.url),{recursive:true});
function run(bin,args,cross=false){const r=spawnSync(bin,args,{cwd:dir,stdio:'inherit',env:{...process.env,...(cross?{GOOS:'wasip1',GOARCH:'wasm',CGO_ENABLED:'0'}:{})}});if(r.status!==0)throw Error(String(r.error||bin+' exited '+r.status))}
const go=process.env.WASMOS_GO||'go';
run(go,['build','-buildmode=c-shared','-trimpath','-ldflags=-s -w','-o','../dist/packet-engine.wasm','./cmd/packet-engine'],true);
if(process.argv.includes('--test')){
 run(go,['test','-count=1','-timeout','60s','./...']);
 run(go,['test','-c','-o','../build/transport-tests.wasm'],true);
 run(process.execPath,['run-wasi.mjs','../build/transport-tests.wasm','-test.v','-test.timeout=60s']);
 run(process.execPath,['interop.mjs']);
}
