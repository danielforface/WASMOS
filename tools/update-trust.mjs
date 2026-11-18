// Offline, deterministic generator. Never trusts an unsigned automatic download.
// Inputs are release-pinned in trust/upstream.json; change those pins in review.
import {readFileSync as read,writeFileSync as write} from 'node:fs';
import {createHash,X509Certificate} from 'node:crypto';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
const [file,incident]=process.argv.slice(2);
if(!file||!incident)throw Error('Usage: node tools/update-trust.mjs /absolute/certdata.txt /absolute/impacted-intermediates.json');
const hash=(bytes,alg='sha256')=>createHash(alg).update(bytes).digest('hex').toUpperCase();
const upstream=JSON.parse(read('trust/upstream.json'));
function verified(path,key){const b=read(path);if(hash(b)!==upstream[key].sha256)throw Error('Input digest mismatch: '+key);return b.toString();}
const certdata=verified(file,'nss'),incidentList=JSON.parse(verified(incident,'incident'));
const legacy=JSON.parse(read('trust/legacy-fingerprints.json'));
const allowed=new Set(legacy.map(x=>x.sha256)),denied=new Set(),trust=new Set(),certs=[];
function oct(block,key){const m=block.match(new RegExp('^'+key+' MULTILINE_OCTAL\\n((?:\\\\[0-7]{3}|\\n)+?)\\nEND$','m'));return m?Buffer.from([...m[1].matchAll(/\\([0-7]{3})/g)].map(x=>parseInt(x[1],8))):null;}
for(const block of certdata.split(/(?=^CKA_CLASS )/m)){
  if(block.startsWith('CKA_CLASS CK_OBJECT_CLASS CKO_NSS_TRUST\n')&&/^CKA_TRUST_SERVER_AUTH CK_TRUST CKT_NSS_TRUSTED_DELEGATOR$/m.test(block))trust.add(oct(block,'CKA_CERT_SHA1_HASH').toString('hex').toUpperCase());
  if(block.startsWith('CKA_CLASS CK_OBJECT_CLASS CKO_CERTIFICATE\n')){
    const b=oct(block,'CKA_VALUE'),x=new X509Certificate(b);
    const k=hash(x.publicKey.export({type:'spki',format:'der'}));
    const constrained=!/^CKA_NSS_SERVER_DISTRUST_AFTER CK_BBOOL CK_FALSE$/m.test(block);
    certs.push({b,k,h:hash(b),sha1:hash(b,'sha1'),constrained});
    if(constrained)denied.add(k);
  }
}
for(const x of incidentList){const c=new X509Certificate(x.pem),k=hash(c.publicKey.export({type:'spki',format:'der'}));if(k!==x.spki_sha256||hash(c.raw)!==x.sha256)throw Error('Incident pins do not match DER');denied.add(k);}
const roots=certs.filter(x=>allowed.has(x.h)&&!x.constrained&&trust.has(x.sha1)&&!denied.has(x.k));
for(const l of legacy)if(!roots.some(x=>x.h===l.sha256))denied.add(l.spki);
if(roots.some(x=>denied.has(x.k))||roots.length<80||incidentList.length!==16)throw Error('Unexpected root policy result; review manually');
const json=(p,x)=>write(p,JSON.stringify(x,null,2)+'\n');
json('trust/roots.json',roots.map(x=>x.b.toString('base64')));
json('trust/blocked-spki.json',[...denied].sort());
const browser='apps/browser/main.ts',src=read(browser,'utf8'),marker=/^const BLOCKED_SPKI_HEX:string\[\]=\[.*\];$/gm;
if([...src.matchAll(marker)].length!==1)throw Error('Missing or duplicate browser policy declaration');
write(browser,src.replace(marker,()=> 'const BLOCKED_SPKI_HEX:string[]='+JSON.stringify([...denied].sort())+';'));
console.log(legacy.length+' legacy roots -> '+roots.length+' unconstrained TLS roots; '+denied.size+' blocked SPKIs');
