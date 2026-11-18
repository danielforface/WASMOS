// @wasm-opt speed
// =============================================================================
// WASM OS SYSTEM BROWSER V3.0 - HTTP/2 + PACKET OWNED TLS 1.3 ENGINE
// =============================================================================
// Network contract:
//   - host TCP/UDP imports are TRANSPORT ONLY.
//   - HTTP request construction/parsing, redirects, cookies, history and document
//     parsing happen inside this WASM application.
//   - No host fetch(), proxy URL or iframe NETWORK fallback is used. The
//     optional iframe is a deny-network native render surface fed only by WASM.
//   - TLS 1.3 record/handshake state, HKDF-SHA256, X.509 parsing, certificate
//     path/hostname/time validation and HTTPS HTTP bytes execute in this WASM.
//   - The host supplies only opaque TCP, CSPRNG, ECDH/AEAD/signature primitives
//     and public DER trust anchors. It never terminates TLS or parses HTTP.
//
// This source is installed by WASM OS as the Browser system application.
// =============================================================================

const WIDTH:i32 = 1180;
const HEIGHT:i32 = 760;
export const pixels = new Uint32Array(WIDTH * HEIGHT);
export function getWidth():i32 { return WIDTH; }
export function getHeight():i32 { return HEIGHT; }

const C_BG:u32       = rgba(12,13,16);
const C_TOP:u32      = rgba(32,33,36);
const C_TAB:u32      = rgba(45,47,51);
const C_TAB_ACT:u32  = rgba(245,246,248);
const C_TAB_TEXT:u32 = rgba(230,232,235);
const C_TEXT:u32     = rgba(32,33,36);
const C_MUTED:u32    = rgba(95,99,104);
const C_BLUE:u32     = rgba(26,115,232);
const C_LINE:u32     = rgba(218,220,224);
const C_WHITE:u32    = rgba(255,255,255);
const C_GREEN:u32    = rgba(24,128,56);
const C_RED:u32      = rgba(217,48,37);
const C_AMBER:u32    = rgba(249,171,0);
const C_LINK:u32     = rgba(26,115,232);
const C_CODE:u32     = rgba(248,249,250);
const C_SEL:u32      = rgba(232,240,254);

const TABBAR_H:i32=38;
const NAV_H:i32=48;
const BOOKMARK_H:i32=28;
const STATUS_H:i32=22;
const CONTENT_Y:i32=TABBAR_H+NAV_H+BOOKMARK_H;
const CONTENT_H:i32=HEIGHT-CONTENT_Y-STATUS_H;
const MAX_TABS:i32=12;
const NET_BUF:i32=65536;
const MAX_DOC_BYTES:i32=16*1024*1024;
const MAX_ELEMENTS:i32=4096;
const MAX_LINKS:i32=1024;
const MAX_REDIRECTS:i32=10;

const PAGE_IDLE:i32=0;
const PAGE_CONNECTING:i32=1;
const PAGE_SENDING:i32=2;
const PAGE_RECEIVING:i32=3;
const PAGE_PARSING:i32=4;
const PAGE_READY:i32=5;
const PAGE_ERROR:i32=-1;
const PAGE_TLS_REQUIRED:i32=-2;
const PAGE_TLS_HANDSHAKE:i32=6;

const TLS_MAX_RECORD:i32=18432;
const TLS_MAX_HANDSHAKE:i32=1024*1024;
const TLS_MAX_CERTS:i32=8;
const TLS_PHASE_FAILED:i32=-1;
const BLOCKED_SPKI_HEX:string[]=["1EA3C5E43ED66C2DA2983A42A4A79B1E906786CE9F1B58621419A00463A87D38","36D7C79F3D089A0FF79972D90923DEA5CA76B4CCBAF7C2751CB152E9494F52D0","43BFFA19D6EF651451F6841E019931E96F6F2EAEFF28AB4B6F1CE4576DE2717B","49DD353DC2B919A3770645117D0E60C16115E7D1BC259EEFE734B00EA434FE5F","5C0660A2B164910D8FF589C18E14552E9E0EC237DCEFE2CB736D41A4811F81A0","62554C17005543B237215F04268DCD2FD1C470240AD3C8660E25AE2C59630F55","63ECEFEE431D49523BC1136C4E72D0206A477086CAF606CD5CF025686C109CF8","6DBFAE00D37B9CD73F8FB47DE65917AF00E0DDDF42DBCEAC20C17C0275EE2095","76EE8590374C715437BBCA6BBA6028EADDE2DC6DBBB8C3F610E851F11D1AB7F5","8D417DB2DD8BF5E3084D1E3F196D583849D81BDD4C00C70B9D39369E96B8C782","92C063D67E8F14DB71D288E11266FFDAF69CBF115F7BAB14F3BC2F68D25E0E30","952C2039C0243EB515DD73D83FC3643184874FEB0862A9837731ED9B4742E17A","B7408B4D2BE0238BA37004DD34E276C6019BD2F24C9DB7D4980F5F6C359A4BCC","E0254C7FCDC265E2F0F8A428DABB75AB4AE039B4872D62F5EE57F0877D5A8A41","E14E51891F3492243EEA613BC2C814D47224B224C57D38169E958E30B3DEDEE4","E5CA37BC7B6C361979BC6B123CA9A1DB019046D7FF5F57DFB854B19D10B0682F","EABC185C4E82D942B1A5978BA3C0181487D6B3B9974E5C49F72F6D0BD9637150","EBED6475C2C2D80FCB199F3FE8DD6E6B3CE60B77EB15D4E42C3DEC0C6F5B5105","EC4FFA1AD0AC88081314B7AAFFEF6A91F97CD57291BB5BA686C5415F5EB4F6B6","FEA2B7D645FBA73D753C1EC9A7870C40E1F7B0C561E927B985BF711866E36F22"];
function browserSpkiBlocked(spki:Uint8Array):bool{
  let h=sha256(spki),hex="",alphabet="0123456789ABCDEF";
  for(let i=0;i<h.length;i++)hex+=alphabet.charAt(h[i]>>4)+alphabet.charAt(h[i]&15);
  return BLOCKED_SPKI_HEX.indexOf(hex)>=0;
}
function tlsMayFinish(c:TlsConnection):bool{
  return c.phase==TLS_PHASE_SERVER_FLIGHT && c.eeSeen && c.policyUntil>epoch_ms() && (c.resumed || (c.chainTrusted && c.signatureChecked));
}
const TLS_PHASE_KEYGEN:i32=1;
const TLS_PHASE_CLIENT_HELLO:i32=2;
const TLS_PHASE_SERVER_HELLO:i32=3;
const TLS_PHASE_DERIVE:i32=4;
const TLS_PHASE_SERVER_FLIGHT:i32=5;
const TLS_PHASE_CHAIN_VERIFY:i32=6;
const TLS_PHASE_CERT_VERIFY:i32=7;
const TLS_PHASE_CLIENT_FINISHED:i32=8;
const TLS_PHASE_HTTP_ENCRYPT:i32=9;
const TLS_PHASE_ESTABLISHED:i32=10;
const TLS_OP_NONE:i32=0;
const TLS_OP_KEYGEN:i32=1;
const TLS_OP_DERIVE:i32=2;
const TLS_OP_DECRYPT:i32=3;
const TLS_OP_VERIFY_CHAIN:i32=4;
const TLS_OP_VERIFY_CERT:i32=5;
const TLS_OP_ENCRYPT_FINISHED:i32=6;
const TLS_OP_ENCRYPT_HTTP:i32=7;
const TLS_OP_ENCRYPT_APP:i32=8;
const TLS_OP_ENCRYPT_KEY_UPDATE:i32=9;
const TLS_OP_VERIFY_OCSP:i32=10;
const TLS_OP_VERIFY_CRL:i32=11;
const TLS_OP_VERIFY_CT:i32=12;

const H2_FRAME_DATA:i32=0;
const H2_FRAME_HEADERS:i32=1;
const H2_FRAME_RST_STREAM:i32=3;
const H2_FRAME_SETTINGS:i32=4;
const H2_FRAME_PUSH_PROMISE:i32=5;
const H2_FRAME_PING:i32=6;
const H2_FRAME_GOAWAY:i32=7;
const H2_FRAME_WINDOW_UPDATE:i32=8;
const H2_FRAME_CONTINUATION:i32=9;
const H2_FLAG_END_STREAM:i32=1;
const H2_FLAG_ACK:i32=1;
const H2_FLAG_END_HEADERS:i32=4;
const H2_FLAG_PADDED:i32=8;
const H2_FLAG_PRIORITY:i32=0x20;

const E_TEXT:i32=1;
const E_H1:i32=2;
const E_H2:i32=3;
const E_H3:i32=4;
const E_LINK:i32=5;
const E_LIST:i32=6;
const E_PRE:i32=7;
const E_RULE:i32=8;
const E_IMG:i32=9;

let activeTab:i32=0;
let nextTabId:i32=1;
let addressFocused:bool=false;
let addressDraft:string="";
let statusMessage:string="Ready";
let sidePanel:i32=0; // 0 off, 1 history, 2 bookmarks, 3 network, 4 developer tools
let hoverX:i32=0;
let hoverY:i32=0;
let mouseButtons:i32=0;
let browserServiceId:i32=-1;
let urlServiceId:i32=-1;
let originServiceId:i32=-1;
let httpServiceId:i32=-1;
let tlsServiceId:i32=-1;
let resourceServiceId:i32=-1;
let tabsServiceId:i32=-1;
let bookmarksServiceId:i32=-1;
let cookiesServiceId:i32=-1;
let rendererServiceId:i32=-1;
let websocketServiceId:i32=-1;
let transportMask:i32=0;
let frameCounter:i32=0;
let needsRender:bool=true;
let presentedFrameRevision:i32=0;
const rxScratch=new Uint8Array(NET_BUF);

// Portable semantic browser state. Live sockets, response bodies and TLS/session
// secrets are deliberately excluded from OS snapshots. Tabs restore lazily and
// reconnect only when the user reloads/navigates.
let workspaceStateBuffer:ArrayBuffer=new ArrayBuffer(0);
const workspaceRestoreScratch=new Uint8Array(1024*1024);
let transportInfo:string="";

function minI(a:i32,b:i32):i32{return a<b?a:b;}
function maxI(a:i32,b:i32):i32{return a>b?a:b;}
function clampI(v:i32,a:i32,b:i32):i32{return v<a?a:(v>b?b:v);}
function lower(s:string):string{return s.toLowerCase();}
function startsI(s:string,p:string):bool{return lower(s).startsWith(lower(p));}
function trim(s:string):string{return s.trim();}
function logLine(s:string):void{let b=String.UTF8.encode("[Browser] "+s);log_utf8(changetype<usize>(b),b.byteLength);}

function drawUnicodeText(text:string,x:i32,y:i32,maxW:i32,fontPx:i32,color:u32,flags:i32=16):i32{
  if(text.length==0)return 0;
  let b=String.UTF8.encode(text);
  return host_unicode_text_draw(pixels.dataStart,WIDTH,HEIGHT,changetype<usize>(b),b.byteLength,x,y,maxW,fontPx,color,flags);
}

class ByteAccumulator {
  data:Uint8Array=new Uint8Array(4096);
  length:i32=0;
  clear():void{this.length=0;}
  ensure(extra:i32):bool{
    if(extra<0||this.length+extra>MAX_DOC_BYTES)return false;
    if(this.length+extra<=this.data.length)return true;
    let cap=this.data.length;if(cap<1)cap=4096;
    while(cap<this.length+extra){cap=cap<1048576?cap*2:cap+1048576;if(cap>MAX_DOC_BYTES){cap=MAX_DOC_BYTES;break;}}
    if(cap<this.length+extra)return false;
    let n=new Uint8Array(cap);memory.copy(n.dataStart,this.data.dataStart,<usize>this.length);this.data=n;return true;
  }
  append(src:Uint8Array,n:i32):bool{
    if(n<=0)return true;if(!this.ensure(n))return false;
    memory.copy(this.data.dataStart+this.length,src.dataStart,<usize>n);this.length+=n;return true;
  }
  slice(start:i32,end:i32):Uint8Array{
    start=clampI(start,0,this.length);end=clampI(end,start,this.length);
    let n=end-start;let out=new Uint8Array(n);if(n>0)memory.copy(out.dataStart,this.data.dataStart+start,<usize>n);return out;
  }
  text(start:i32=0,end:i32=-1):string{
    if(end<0)end=this.length;let b=this.slice(start,end);return String.UTF8.decode(b.buffer);
  }
}

class TlsWriter {
  a:Array<u8>=new Array<u8>();
  u8v(v:i32):void{this.a.push(<u8>v);}
  u16(v:i32):void{this.a.push(<u8>(v>>8));this.a.push(<u8>v);}
  u24(v:i32):void{this.a.push(<u8>(v>>16));this.a.push(<u8>(v>>8));this.a.push(<u8>v);}
  u32(v:u32):void{this.a.push(<u8>(v>>24));this.a.push(<u8>(v>>16));this.a.push(<u8>(v>>8));this.a.push(<u8>v);}
  u64bytes(v:Uint8Array):void{if(v.length==8)this.bytes(v);}
  bytes(b:Uint8Array):void{for(let i:i32=0;i<b.length;i++)this.a.push(b[i]);}
  raw(b:ArrayBuffer):void{let x=Uint8Array.wrap(b);this.bytes(x);}
  out():Uint8Array{let b=new Uint8Array(this.a.length);for(let i:i32=0;i<this.a.length;i++)b[i]=this.a[i];return b;}
}

function bytesSlice(b:Uint8Array,s:i32,e:i32):Uint8Array{s=clampI(s,0,b.length);e=clampI(e,s,b.length);let x=new Uint8Array(e-s);if(x.length)memory.copy(x.dataStart,b.dataStart+s,<usize>x.length);return x;}
function bytesCat(a:Uint8Array,b:Uint8Array):Uint8Array{let x=new Uint8Array(a.length+b.length);if(a.length)memory.copy(x.dataStart,a.dataStart,<usize>a.length);if(b.length)memory.copy(x.dataStart+a.length,b.dataStart,<usize>b.length);return x;}
function bytesCat3(a:Uint8Array,b:Uint8Array,c:Uint8Array):Uint8Array{return bytesCat(bytesCat(a,b),c);}
function bytesEq(a:Uint8Array,b:Uint8Array):bool{if(a.length!=b.length)return false;let d:u8=0;for(let i:i32=0;i<a.length;i++)d|=a[i]^b[i];return d==0;}
function utf8Bytes(s:string):Uint8Array{let ab=String.UTF8.encode(s);let x=new Uint8Array(ab.byteLength);if(x.length)memory.copy(x.dataStart,changetype<usize>(ab),<usize>x.length);return x;}
function be16(b:Uint8Array,p:i32):i32{return (<i32>b[p]<<8)|b[p+1];}
function be24(b:Uint8Array,p:i32):i32{return (<i32>b[p]<<16)|(<i32>b[p+1]<<8)|b[p+2];}
function be32(b:Uint8Array,p:i32):u32{return (<u32>b[p]<<24)|(<u32>b[p+1]<<16)|(<u32>b[p+2]<<8)|b[p+3];}

const SHA256_K:u32[]=[
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];
function ror32(x:u32,n:i32):u32{return (x>>>n)|(x<<(32-n));}
function sha256(src:Uint8Array):Uint8Array{
  let total:i32=((src.length+9+63)/64)*64;let b=new Uint8Array(total);if(src.length)memory.copy(b.dataStart,src.dataStart,<usize>src.length);b[src.length]=0x80;
  let bits:u64=<u64>src.length*8;for(let i:i32=0;i<8;i++)b[total-1-i]=<u8>(bits>>(i*8));
  let h0:u32=0x6a09e667,h1:u32=0xbb67ae85,h2:u32=0x3c6ef372,h3:u32=0xa54ff53a,h4:u32=0x510e527f,h5:u32=0x9b05688c,h6:u32=0x1f83d9ab,h7:u32=0x5be0cd19;
  let w=new Uint32Array(64);
  for(let p:i32=0;p<total;p+=64){for(let i:i32=0;i<16;i++)w[i]=be32(b,p+i*4);for(let i:i32=16;i<64;i++){let x=w[i-15],y=w[i-2];let s0=ror32(x,7)^ror32(x,18)^(x>>>3),s1=ror32(y,17)^ror32(y,19)^(y>>>10);w[i]=w[i-16]+s0+w[i-7]+s1;}
    let a=h0,c1=h1,c2=h2,c3=h3,c4=h4,c5=h5,c6=h6,c7=h7;
    for(let i:i32=0;i<64;i++){let S1=ror32(c4,6)^ror32(c4,11)^ror32(c4,25),ch=(c4&c5)^((~c4)&c6),t1=c7+S1+ch+SHA256_K[i]+w[i],S0=ror32(a,2)^ror32(a,13)^ror32(a,22),maj=(a&c1)^(a&c2)^(c1&c2),t2=S0+maj;c7=c6;c6=c5;c5=c4;c4=c3+t1;c3=c2;c2=c1;c1=a;a=t1+t2;}
    h0+=a;h1+=c1;h2+=c2;h3+=c3;h4+=c4;h5+=c5;h6+=c6;h7+=c7;
  }
  let out=new Uint8Array(32),hs:u32[]=[h0,h1,h2,h3,h4,h5,h6,h7];for(let i:i32=0;i<8;i++){out[i*4]=<u8>(hs[i]>>24);out[i*4+1]=<u8>(hs[i]>>16);out[i*4+2]=<u8>(hs[i]>>8);out[i*4+3]=<u8>hs[i];}return out;
}
function sha1(src:Uint8Array):Uint8Array{let bitLen:u64=<u64>src.length*8,total=((src.length+9+63)/64)*64,b=new Uint8Array(total);if(src.length)memory.copy(b.dataStart,src.dataStart,<usize>src.length);b[src.length]=0x80;for(let i:i32=0;i<8;i++)b[total-1-i]=<u8>(bitLen>>(i*8));let h0:u32=0x67452301,h1:u32=0xefcdab89,h2:u32=0x98badcfe,h3:u32=0x10325476,h4:u32=0xc3d2e1f0,w=new Array<u32>(80);for(let off:i32=0;off<total;off+=64){for(let i:i32=0;i<16;i++)w[i]=be32(b,off+i*4);for(let i:i32=16;i<80;i++){let v=w[i-3]^w[i-8]^w[i-14]^w[i-16];w[i]=(v<<1)|(v>>>31);}let a=h0,c=h1,d=h2,e=h3,f=h4;for(let i:i32=0;i<80;i++){let q:u32=0,k:u32=0;if(i<20){q=(c&d)|((~c)&e);k=0x5a827999;}else if(i<40){q=c^d^e;k=0x6ed9eba1;}else if(i<60){q=(c&d)|(c&e)|(d&e);k=0x8f1bbcdc;}else{q=c^d^e;k=0xca62c1d6;}let z=((a<<5)|(a>>>27))+q+f+k+w[i];f=e;e=d;d=(c<<30)|(c>>>2);c=a;a=z;}h0+=a;h1+=c;h2+=d;h3+=e;h4+=f;}let out=new Uint8Array(20),hs:u32[]=[h0,h1,h2,h3,h4];for(let i:i32=0;i<5;i++){out[i*4]=<u8>(hs[i]>>24);out[i*4+1]=<u8>(hs[i]>>16);out[i*4+2]=<u8>(hs[i]>>8);out[i*4+3]=<u8>hs[i];}return out;}
function hmac256(key:Uint8Array,data:Uint8Array):Uint8Array{let k=key.length>64?sha256(key):key;let inner=new Uint8Array(64+data.length),outer=new Uint8Array(96);for(let i:i32=0;i<64;i++){let v:u8=i<k.length?k[i]:0;inner[i]=v^0x36;outer[i]=v^0x5c;}if(data.length)memory.copy(inner.dataStart+64,data.dataStart,<usize>data.length);let ih=sha256(inner);memory.copy(outer.dataStart+64,ih.dataStart,32);return sha256(outer);}
function hkdfExtract(salt:Uint8Array,ikm:Uint8Array):Uint8Array{return hmac256(salt,ikm);}
function hkdfExpand(prk:Uint8Array,info:Uint8Array,len:i32):Uint8Array{let out=new Uint8Array(len),t=new Uint8Array(0),done:i32=0,c:u8=1;while(done<len){let d=new Uint8Array(t.length+info.length+1);if(t.length)memory.copy(d.dataStart,t.dataStart,<usize>t.length);if(info.length)memory.copy(d.dataStart+t.length,info.dataStart,<usize>info.length);d[d.length-1]=c++;t=hmac256(prk,d);let n=minI(t.length,len-done);memory.copy(out.dataStart+done,t.dataStart,<usize>n);done+=n;}return out;}
function hkdfLabel(secret:Uint8Array,label:string,context:Uint8Array,len:i32):Uint8Array{let l=utf8Bytes("tls13 "+label),w=new TlsWriter();w.u16(len);w.u8v(l.length);w.bytes(l);w.u8v(context.length);w.bytes(context);return hkdfExpand(secret,w.out(),len);}
function deriveSecret(secret:Uint8Array,label:string,transcript:Uint8Array):Uint8Array{return hkdfLabel(secret,label,sha256(transcript),32);}
function zeroBytes(n:i32):Uint8Array{return new Uint8Array(n);}

class DerNode{tag:i32=0;start:i32=0;content:i32=0;end:i32=0;valid:bool=false;}
function derNode(b:Uint8Array,p:i32,limit:i32=-1):DerNode{let n=new DerNode();if(limit<0||limit>b.length)limit=b.length;if(p<0||p+2>limit)return n;n.start=p;n.tag=b[p++];let l:i32=b[p++];if((l&0x80)!=0){let c=l&0x7f;if(c<1||c>3||p+c>limit)return n;l=0;for(let i:i32=0;i<c;i++)l=(l<<8)|b[p++];}if(l<0||p+l>limit)return n;n.content=p;n.end=p+l;n.valid=true;return n;}
function oidEq(b:Uint8Array,n:DerNode,hex:string):bool{if(!n.valid||n.tag!=6||hex.length!=(n.end-n.content)*2)return false;for(let i:i32=0;i<n.end-n.content;i++){let a=hexNibble(hex.charCodeAt(i*2)),c=hexNibble(hex.charCodeAt(i*2+1));if(a<0||c<0||b[n.content+i]!=((a<<4)|c))return false;}return true;}
function derText(b:Uint8Array,n:DerNode):string{return n.valid?String.UTF8.decode(bytesSlice(b,n.content,n.end).buffer):"";}
function leap(y:i32):bool{return y%4==0&&(y%100!=0||y%400==0);}
function epochDate(y:i32,m:i32,d:i32,hh:i32,mm:i32,ss:i32):f64{let days:i64=0;for(let yr:i32=1970;yr<y;yr++)days+=leap(yr)?366:365;let md:i32[]=[31,28,31,30,31,30,31,31,30,31,30,31];for(let x:i32=1;x<m;x++)days+=x==2&&leap(y)?29:md[x-1];days+=d-1;return <f64>(days*86400+<i64>hh*3600+<i64>mm*60+ss)*1000.0;}
function digits(s:string,p:i32,n:i32):i32{let v:i32=0;if(p<0||p+n>s.length)return-1;for(let i:i32=0;i<n;i++){let c=s.charCodeAt(p+i);if(c<48||c>57)return-1;v=v*10+c-48;}return v;}
function parseDerTime(b:Uint8Array,n:DerNode):f64{let s=derText(b,n),p:i32=0,y:i32=0;if(n.tag==23){let yy=digits(s,0,2);if(yy<0)return-1;y=yy>=50?1900+yy:2000+yy;p=2;}else if(n.tag==24){y=digits(s,0,4);p=4;}else return-1;let mo=digits(s,p,2),d=digits(s,p+2,2),h=digits(s,p+4,2),mi=digits(s,p+6,2),se=digits(s,p+8,2);if(y<1970||mo<1||mo>12||d<1||d>31||h<0||h>23||mi<0||mi>59||se<0||se>60)return-1;return epochDate(y,mo,d,h,mi,se);}
function dnsMatches(pattern:string,host:string):bool{let p=lower(pattern),h=lower(host);if(p==h)return true;if(p.startsWith("*.")){let suffix=p.substring(1);if(!h.endsWith(suffix))return false;let left=h.substring(0,h.length-suffix.length);return left.length>0&&!left.includes(".");}return false;}
function dnsWithinConstraint(host:string,constraint:string):bool{let h=lower(host),n=lower(constraint);if(n.startsWith("."))return h.length>n.length&&h.endsWith(n);return h==n||h.endsWith("."+n);}
function parseIpv4(s:string):Uint8Array{let p=s.split(".");if(p.length!=4)return new Uint8Array(0);let out=new Uint8Array(4);for(let i:i32=0;i<4;i++){if(p[i].length==0||p[i].length>3)return new Uint8Array(0);let v=I32.parseInt(p[i]);if(v<0||v>255||v.toString()!=p[i])return new Uint8Array(0);out[i]=<u8>v;}return out;}
function parseHex16(s:string):i32{if(s.length<1||s.length>4)return-1;let v:i32=0;for(let i:i32=0;i<s.length;i++){let n=hexNibble(s.charCodeAt(i));if(n<0)return-1;v=(v<<4)|n;}return v;}
function appendIpv6Part(out:Array<i32>,part:string):bool{if(part.includes(".")){let v4=parseIpv4(part);if(v4.length!=4)return false;out.push((<i32>v4[0]<<8)|v4[1]);out.push((<i32>v4[2]<<8)|v4[3]);return true;}let v=parseHex16(part);if(v<0)return false;out.push(v);return true;}
function parseIpLiteral(input:string):Uint8Array{let s=lower(input);if(s.startsWith("[")&&s.endsWith("]"))s=s.substring(1,s.length-1);let v4=parseIpv4(s);if(v4.length==4)return v4;if(!s.includes(":"))return new Uint8Array(0);let dc=s.indexOf("::");if(dc>=0&&s.indexOf("::",dc+2)>=0)return new Uint8Array(0);let left=new Array<i32>(),right=new Array<i32>();let ls=dc>=0?s.substring(0,dc):s,rs=dc>=0?s.substring(dc+2):"";if(ls.length){let a=ls.split(":");for(let i:i32=0;i<a.length;i++)if(!appendIpv6Part(left,a[i]))return new Uint8Array(0);}if(rs.length){let a=rs.split(":");for(let i:i32=0;i<a.length;i++)if(!appendIpv6Part(right,a[i]))return new Uint8Array(0);}let zeros=8-left.length-right.length;if(dc<0&&zeros!=0)return new Uint8Array(0);if(dc>=0&&zeros<1)return new Uint8Array(0);let words=new Array<i32>();for(let i:i32=0;i<left.length;i++)words.push(left[i]);for(let i:i32=0;i<zeros;i++)words.push(0);for(let i:i32=0;i<right.length;i++)words.push(right[i]);if(words.length!=8)return new Uint8Array(0);let out=new Uint8Array(16);for(let i:i32=0;i<8;i++){out[i*2]=<u8>(words[i]>>8);out[i*2+1]=<u8>words[i];}return out;}
function hostIsIp(host:string):bool{return parseIpLiteral(host).length>0;}
function authorityHost(host:string):string{return host.includes(":")?"["+host+"]":host;}

class CertificateInfo{
  der:Uint8Array=new Uint8Array(0);tbs:Uint8Array=new Uint8Array(0);serial:Uint8Array=new Uint8Array(0);issuer:Uint8Array=new Uint8Array(0);subject:Uint8Array=new Uint8Array(0);spki:Uint8Array=new Uint8Array(0);subjectKey:Uint8Array=new Uint8Array(0);signature:Uint8Array=new Uint8Array(0);sigAlg:i32=0;notBefore:f64=-1;notAfter:f64=-1;isCa:bool=false;pathLen:i32=-1;keyUsagePresent:bool=false;digitalSignature:bool=false;keyCertSign:bool=false;ekuPresent:bool=false;serverAuth:bool=false;noRevAvail:bool=false;mustStaple:bool=false;unsupportedCritical:bool=false;sans:Array<string>=new Array<string>();ipSans:Array<Uint8Array>=new Array<Uint8Array>();aiaIssuers:Array<string>=new Array<string>();ocspUrls:Array<string>=new Array<string>();crlUrls:Array<string>=new Array<string>();sctList:Uint8Array=new Uint8Array(0);permittedDns:Array<string>=new Array<string>();excludedDns:Array<string>=new Array<string>();valid:bool=false;
}
function derPositiveInt(b:Uint8Array,n:DerNode):i32{if(!n.valid||n.tag!=2||n.end<=n.content||n.end-n.content>4)return-1;let v:i32=0;for(let i:i32=n.content;i<n.end;i++)v=(v<<8)|b[i];return v;}
function parseNameConstraintSet(c:CertificateInfo,der:Uint8Array,node:DerNode,permitted:bool):void{let p=node.content;while(p<node.end){let subtree=derNode(der,p,node.end);if(!subtree.valid||subtree.tag!=0x30)break;let base=derNode(der,subtree.content,subtree.end);if(base.valid&&base.tag==0x82){let s=lower(derText(der,base));if(permitted)c.permittedDns.push(s);else c.excludedDns.push(s);}p=subtree.end;}}
function collectDerUris(der:Uint8Array,node:DerNode,out:Array<string>,depth:i32=0):void{if(depth>8||out.length>=8)return;if(node.tag==0x86){let u=derText(der,node);if(u.startsWith("http://")||u.startsWith("https://"))out.push(u);return;}if((node.tag&0x20)==0&&node.tag!=0x30&&node.tag!=0x31&&node.tag<0xa0)return;let p=node.content;while(p<node.end){let x=derNode(der,p,node.end);if(!x.valid||x.end<=p)return;collectDerUris(der,x,out,depth+1);p=x.end;}}
function parseCertExtension(c:CertificateInfo,der:Uint8Array,oid:DerNode,value:DerNode):bool{
  if(oidEq(der,oid,"551d11")){let seq=derNode(der,value.content,value.end);if(seq.valid&&seq.tag==0x30){let p=seq.content;while(p<seq.end){let gn=derNode(der,p,seq.end);if(!gn.valid)break;if(gn.tag==0x82)c.sans.push(derText(der,gn));else if(gn.tag==0x87)c.ipSans.push(bytesSlice(der,gn.content,gn.end));p=gn.end;}}return true;}
  if(oidEq(der,oid,"551d13")){let seq=derNode(der,value.content,value.end);if(seq.valid&&seq.tag==0x30){let p=seq.content,n=derNode(der,p,seq.end);if(n.valid&&n.tag==1){c.isCa=n.end>n.content&&der[n.content]!=0;p=n.end;n=derNode(der,p,seq.end);}if(n.valid&&n.tag==2)c.pathLen=derPositiveInt(der,n);}return true;}
  if(oidEq(der,oid,"551d0f")){let bits=derNode(der,value.content,value.end);if(bits.valid&&bits.tag==3&&bits.end-bits.content>=2){c.keyUsagePresent=true;let first=der[bits.content+1];c.digitalSignature=(first&0x80)!=0;c.keyCertSign=(first&0x04)!=0;}return true;}
  if(oidEq(der,oid,"551d25")){let seq=derNode(der,value.content,value.end);if(seq.valid&&seq.tag==0x30){c.ekuPresent=true;let p=seq.content;while(p<seq.end){let x=derNode(der,p,seq.end);if(!x.valid)break;if(oidEq(der,x,"2b06010505070301")||oidEq(der,x,"551d2500"))c.serverAuth=true;p=x.end;}}return true;}
  if(oidEq(der,oid,"551d1e")){let seq=derNode(der,value.content,value.end);if(seq.valid&&seq.tag==0x30){let p=seq.content;while(p<seq.end){let x=derNode(der,p,seq.end);if(!x.valid)break;if(x.tag==0xa0)parseNameConstraintSet(c,der,x,true);else if(x.tag==0xa1)parseNameConstraintSet(c,der,x,false);p=x.end;}}return true;}
  if(oidEq(der,oid,"2b06010505070101")){let seq=derNode(der,value.content,value.end);if(seq.valid&&seq.tag==0x30){let p=seq.content;while(p<seq.end){let ad=derNode(der,p,seq.end);if(!ad.valid||ad.tag!=0x30)break;let method=derNode(der,ad.content,ad.end),loc=derNode(der,method.end,ad.end);if(loc.valid&&loc.tag==0x86){let u=derText(der,loc);if(oidEq(der,method,"2b06010505073002"))c.aiaIssuers.push(u);else if(oidEq(der,method,"2b06010505073001"))c.ocspUrls.push(u);}p=ad.end;}}return true;}
  if(oidEq(der,oid,"551d1f")){let seq=derNode(der,value.content,value.end);if(seq.valid)collectDerUris(der,seq,c.crlUrls);return true;}
  if(oidEq(der,oid,"2b06010401d679020402")){c.sctList=bytesSlice(der,value.content,value.end);return true;}
  if(oidEq(der,oid,"2b06010505070118")){let seq=derNode(der,value.content,value.end);if(seq.valid&&seq.tag==0x30){let p=seq.content;while(p<seq.end){let f=derNode(der,p,seq.end);if(!f.valid||f.tag!=2)break;if(derPositiveInt(der,f)==5)c.mustStaple=true;p=f.end;}}return true;}
  if(oidEq(der,oid,"551d38")){c.noRevAvail=true;return true;}
  return true;
}
function parseCertificate(der:Uint8Array):CertificateInfo{
  let c=new CertificateInfo();c.der=der;let root=derNode(der,0);if(!root.valid||root.tag!=0x30||root.end!=der.length)return c;let tbs=derNode(der,root.content,root.end);if(!tbs.valid||tbs.tag!=0x30)return c;let alg=derNode(der,tbs.end,root.end),sig=derNode(der,alg.end,root.end);if(!alg.valid||!sig.valid||alg.tag!=0x30||sig.tag!=3||sig.end-sig.content<2)return c;c.tbs=bytesSlice(der,tbs.start,tbs.end);c.signature=bytesSlice(der,sig.content+1,sig.end);
  let oid=derNode(der,alg.content,alg.end);if(oidEq(der,oid,"2a864886f70d01010b"))c.sigAlg=3;else if(oidEq(der,oid,"2a8648ce3d040302"))c.sigAlg=2;else if(oidEq(der,oid,"2a864886f70d01010c"))c.sigAlg=6;else if(oidEq(der,oid,"2a8648ce3d040303"))c.sigAlg=5;else if(oidEq(der,oid,"2a864886f70d01010d"))c.sigAlg=7;else if(oidEq(der,oid,"2a8648ce3d040304"))c.sigAlg=9;else if(oidEq(der,oid,"2a864886f70d01010a")){let params=bytesSlice(der,oid.end,alg.end);c.sigAlg=bytesContains(params,[0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x03])?8:(bytesContains(params,[0x60,0x86,0x48,0x01,0x65,0x03,0x04,0x02,0x02])?4:1);}
  let p=tbs.content,n=derNode(der,p,tbs.end);if(n.valid&&n.tag==0xa0){p=n.end;n=derNode(der,p,tbs.end);}if(!n.valid)return c;let serial=n;c.serial=bytesSlice(der,serial.content,serial.end);p=serial.end;let tbsAlg=derNode(der,p,tbs.end);if(!tbsAlg.valid)return c;p=tbsAlg.end;let issuer=derNode(der,p,tbs.end);if(!issuer.valid)return c;c.issuer=bytesSlice(der,issuer.start,issuer.end);p=issuer.end;
  let validity=derNode(der,p,tbs.end);if(!validity.valid||validity.tag!=0x30)return c;let nb=derNode(der,validity.content,validity.end),na=derNode(der,nb.end,validity.end);if(!nb.valid||!na.valid)return c;c.notBefore=parseDerTime(der,nb);c.notAfter=parseDerTime(der,na);p=validity.end;let subject=derNode(der,p,tbs.end);if(!subject.valid)return c;c.subject=bytesSlice(der,subject.start,subject.end);p=subject.end;let spki=derNode(der,p,tbs.end);if(!spki.valid||spki.tag!=0x30)return c;c.spki=bytesSlice(der,spki.start,spki.end);let spa=derNode(der,spki.content,spki.end),spb=derNode(der,spa.end,spki.end);if(spb.valid&&spb.tag==3&&spb.end>spb.content)c.subjectKey=bytesSlice(der,spb.content+1,spb.end);p=spki.end;
  while(p<tbs.end){let x=derNode(der,p,tbs.end);if(!x.valid)break;if(x.tag==0xa3){let seq=derNode(der,x.content,x.end);if(seq.valid&&seq.tag==0x30){let ep=seq.content;while(ep<seq.end){let ex=derNode(der,ep,seq.end);if(!ex.valid||ex.tag!=0x30)break;let op=ex.content,eo=derNode(der,op,ex.end);if(!eo.valid)break;op=eo.end;let value=derNode(der,op,ex.end),critical=false;if(value.valid&&value.tag==1){critical=value.end>value.content&&der[value.content]!=0;op=value.end;value=derNode(der,op,ex.end);}if(value.valid&&value.tag==4){let known=parseCertExtension(c,der,eo,value);if(critical&&!known)c.unsupportedCritical=true;}ep=ex.end;}}}p=x.end;
  }
  c.valid=c.notBefore>=0&&c.notAfter>c.notBefore&&c.spki.length>0&&c.signature.length>0;return c;
}
function bytesContains(b:Uint8Array,needle:i32[]):bool{if(needle.length==0||needle.length>b.length)return false;for(let i:i32=0;i<=b.length-needle.length;i++){let ok=true;for(let j:i32=0;j<needle.length;j++)if(b[i+j]!=needle[j]){ok=false;break;}if(ok)return true;}return false;}
function signatureAlgNode(der:Uint8Array,alg:DerNode):i32{let oid=derNode(der,alg.content,alg.end);if(oidEq(der,oid,"2a864886f70d01010b"))return 3;if(oidEq(der,oid,"2a8648ce3d040302"))return 2;if(oidEq(der,oid,"2a864886f70d01010c"))return 6;if(oidEq(der,oid,"2a8648ce3d040303"))return 5;if(oidEq(der,oid,"2a864886f70d01010d"))return 7;if(oidEq(der,oid,"2a8648ce3d040304"))return 9;return 0;}
class OcspInfo{valid:bool=false;status:i32=2;tbs:Uint8Array=new Uint8Array(0);signature:Uint8Array=new Uint8Array(0);sigAlg:i32=0;thisUpdate:f64=-1;nextUpdate:f64=-1;}
function parseOcspResponse(der:Uint8Array,leaf:CertificateInfo,issuer:CertificateInfo):OcspInfo{let out=new OcspInfo(),root=derNode(der,0);if(!root.valid||root.tag!=0x30||root.end!=der.length)return out;let p=root.content,status=derNode(der,p,root.end);if(!status.valid||status.tag!=10||status.end-status.content!=1||der[status.content]!=0)return out;p=status.end;let rb=derNode(der,p,root.end);if(!rb.valid||rb.tag!=0xa0)return out;let rseq=derNode(der,rb.content,rb.end),oid=derNode(der,rseq.content,rseq.end),oct=derNode(der,oid.end,rseq.end);if(!rseq.valid||rseq.tag!=0x30||!oidEq(der,oid,"2b0601050507300101")||!oct.valid||oct.tag!=4)return out;let basic=bytesSlice(der,oct.content,oct.end),br=derNode(basic,0);if(!br.valid||br.tag!=0x30||br.end!=basic.length)return out;let tbs=derNode(basic,br.content,br.end),alg=derNode(basic,tbs.end,br.end),sig=derNode(basic,alg.end,br.end);if(!tbs.valid||tbs.tag!=0x30||!alg.valid||alg.tag!=0x30||!sig.valid||sig.tag!=3||sig.end-sig.content<2)return out;out.sigAlg=signatureAlgNode(basic,alg);if(out.sigAlg==0)return out;out.tbs=bytesSlice(basic,tbs.start,tbs.end);out.signature=bytesSlice(basic,sig.content+1,sig.end);p=tbs.content;let n=derNode(basic,p,tbs.end);if(n.valid&&n.tag==0xa0){p=n.end;n=derNode(basic,p,tbs.end);}if(!n.valid||(n.tag!=0xa1&&n.tag!=0xa2))return out;let responderOk=false;if(n.tag==0xa1)responderOk=bytesEq(bytesSlice(basic,n.content,n.end),issuer.subject);else{let kh=bytesSlice(basic,n.content,n.end),inside=derNode(basic,n.content,n.end);if(inside.valid&&inside.tag==4&&inside.end==n.end)kh=bytesSlice(basic,inside.content,inside.end);responderOk=bytesEq(kh,sha1(issuer.subjectKey));}if(!responderOk)return out;p=n.end;let produced=derNode(basic,p,tbs.end);if(!produced.valid||produced.tag!=24)return out;p=produced.end;let responses=derNode(basic,p,tbs.end);if(!responses.valid||responses.tag!=0x30)return out;let expectedName=sha1(issuer.subject),expectedKey=sha1(issuer.subjectKey);p=responses.content;while(p<responses.end){let single=derNode(basic,p,responses.end);if(!single.valid||single.tag!=0x30)break;let q=single.content,certId=derNode(basic,q,single.end);if(!certId.valid||certId.tag!=0x30){p=single.end;continue;}q=certId.content;let ha=derNode(basic,q,certId.end),nh=derNode(basic,ha.end,certId.end),kh=derNode(basic,nh.end,certId.end),serial=derNode(basic,kh.end,certId.end),ho=derNode(basic,ha.content,ha.end);let match=ha.valid&&oidEq(basic,ho,"2b0e03021a")&&nh.valid&&nh.tag==4&&kh.valid&&kh.tag==4&&serial.valid&&serial.tag==2&&bytesEq(bytesSlice(basic,nh.content,nh.end),expectedName)&&bytesEq(bytesSlice(basic,kh.content,kh.end),expectedKey)&&bytesEq(bytesSlice(basic,serial.content,serial.end),leaf.serial);q=certId.end;let cs=derNode(basic,q,single.end);if(!cs.valid){p=single.end;continue;}q=cs.end;let tu=derNode(basic,q,single.end);if(match&&tu.valid&&(tu.tag==23||tu.tag==24)){out.status=cs.tag==0x80?0:(cs.tag==0xa1?1:2);out.thisUpdate=parseDerTime(basic,tu);q=tu.end;let nx=derNode(basic,q,single.end);if(nx.valid&&nx.tag==0xa0){let nt=derNode(basic,nx.content,nx.end);if(nt.valid)out.nextUpdate=parseDerTime(basic,nt);}let now=epoch_ms();out.valid=out.thisUpdate>=0&&out.thisUpdate<=now+300000&&(out.nextUpdate<0||out.nextUpdate>=now-300000);return out;}p=single.end;}return out;}
class CrlInfo{valid:bool=false;revoked:bool=false;tbs:Uint8Array=new Uint8Array(0);signature:Uint8Array=new Uint8Array(0);sigAlg:i32=0;}
function parseCrl(der:Uint8Array,leaf:CertificateInfo,issuer:CertificateInfo):CrlInfo{let out=new CrlInfo(),root=derNode(der,0);if(!root.valid||root.tag!=0x30||root.end!=der.length)return out;let tbs=derNode(der,root.content,root.end),alg=derNode(der,tbs.end,root.end),sig=derNode(der,alg.end,root.end);if(!tbs.valid||tbs.tag!=0x30||!alg.valid||alg.tag!=0x30||!sig.valid||sig.tag!=3||sig.end-sig.content<2)return out;out.sigAlg=signatureAlgNode(der,alg);if(out.sigAlg==0)return out;out.tbs=bytesSlice(der,tbs.start,tbs.end);out.signature=bytesSlice(der,sig.content+1,sig.end);let p=tbs.content,n=derNode(der,p,tbs.end);if(n.valid&&n.tag==2){p=n.end;n=derNode(der,p,tbs.end);}if(!n.valid||n.tag!=0x30)return out;p=n.end;let name=derNode(der,p,tbs.end);if(!name.valid||!bytesEq(bytesSlice(der,name.start,name.end),issuer.subject))return out;p=name.end;let thisUpdate=derNode(der,p,tbs.end);if(!thisUpdate.valid||(thisUpdate.tag!=23&&thisUpdate.tag!=24))return out;p=thisUpdate.end;let next=derNode(der,p,tbs.end),nextTime:f64=-1;if(next.valid&&(next.tag==23||next.tag==24)){nextTime=parseDerTime(der,next);p=next.end;}let now=epoch_ms(),thisTime=parseDerTime(der,thisUpdate);if(thisTime<0||thisTime>now+300000||nextTime<now-300000)return out;let revoked=derNode(der,p,tbs.end);if(revoked.valid&&revoked.tag==0x30){let q=revoked.content;while(q<revoked.end){let entry=derNode(der,q,revoked.end);if(!entry.valid||entry.tag!=0x30)break;let serial=derNode(der,entry.content,entry.end);if(serial.valid&&serial.tag==2&&bytesEq(bytesSlice(der,serial.content,serial.end),leaf.serial))out.revoked=true;q=entry.end;}}out.valid=true;return out;}
class CtSct{signed:Uint8Array=new Uint8Array(0);signature:Uint8Array=new Uint8Array(0);spki:Uint8Array=new Uint8Array(0);alg:i32=0;operator:i32=-1;}
function derWrap(tag:i32,content:Uint8Array):Uint8Array{let w=new TlsWriter();w.u8v(tag);if(content.length<128)w.u8v(content.length);else if(content.length<256){w.u8v(0x81);w.u8v(content.length);}else if(content.length<65536){w.u8v(0x82);w.u16(content.length);}else{w.u8v(0x83);w.u24(content.length);}w.bytes(content);return w.out();}
function ctPrecertTbs(cert:CertificateInfo):Uint8Array{let b=cert.tbs,root=derNode(b,0);if(!root.valid||root.tag!=0x30)return new Uint8Array(0);let p=root.content,out=new ByteAccumulator(),pa:u8[]=[0x30,0x13,0x06,0x0a,0x2b,0x06,0x01,0x04,0x01,0xd6,0x79,0x02,0x04,0x03,0x01,0x01,0xff,0x04,0x02,0x05,0x00],poison=new Uint8Array(pa.length);for(let z:i32=0;z<pa.length;z++)poison[z]=pa[z];while(p<root.end){let n=derNode(b,p,root.end);if(!n.valid)return new Uint8Array(0);if(n.tag==0xa3){let seq=derNode(b,n.content,n.end);if(!seq.valid||seq.tag!=0x30)return new Uint8Array(0);let q=seq.content,exts=new ByteAccumulator(),replaced=false;while(q<seq.end){let ex=derNode(b,q,seq.end);if(!ex.valid||ex.tag!=0x30)return new Uint8Array(0);let oid=derNode(b,ex.content,ex.end);if(oidEq(b,oid,"2b06010401d679020402")){exts.append(poison,poison.length);replaced=true;}else exts.append(bytesSlice(b,ex.start,ex.end),ex.end-ex.start);q=ex.end;}if(!replaced)return new Uint8Array(0);let es=derWrap(0x30,exts.slice(0,exts.length)),wrap=derWrap(0xa3,es);out.append(wrap,wrap.length);}else out.append(bytesSlice(b,n.start,n.end),n.end-n.start);p=n.end;}return derWrap(0x30,out.slice(0,out.length));}
function ctLogFor(id:Uint8Array,timestamp:f64,s:CtSct):bool{let count=host_ct_log_count();for(let i:i32=0;i<count;i++){let lid=new Uint8Array(32);if(host_ct_log_id_read(i,lid.dataStart,32)!=32||!bytesEq(id,lid))continue;let state=host_ct_log_state(i),start=host_ct_log_start_ms(i),end=host_ct_log_end_ms(i);if(state<=0||(start>0&&timestamp<start)||(end>0&&timestamp>=end))return false;let n=host_ct_log_key_size(i);if(n<=0||n>4096)return false;s.spki=new Uint8Array(n);if(host_ct_log_key_read(i,s.spki.dataStart,n)!=n)return false;s.operator=host_ct_log_operator(i);return true;}return false;}
function ctAddList(c:TlsConnection,list:Uint8Array,precert:bool,preTbs:Uint8Array):void{if(list.length<2)return;let total=be16(list,0),p:i32=2;if(total+2!=list.length)return;let leaf=c.certs[0],issuer=tlsLeafIssuer(c);while(p+2<=list.length&&c.ctQueue.length<16){let n=be16(list,p);p+=2;if(n<47||p+n>list.length)break;let sct=bytesSlice(list,p,p+n);p+=n;if(sct[0]!=0)continue;let id=bytesSlice(sct,1,33),tsb=bytesSlice(sct,33,41),hi=be32(tsb,0),lo=be32(tsb,4),timestamp=<f64>hi*4294967296.0+<f64>lo,ep:i32=41,el=be16(sct,ep);ep+=2;if(ep+el+4>sct.length)continue;let ext=bytesSlice(sct,ep,ep+el);ep+=el;let hash=sct[ep++],sigType=sct[ep++],sl=be16(sct,ep);ep+=2;if(ep+sl!=sct.length||timestamp<leaf.notBefore||timestamp>leaf.notAfter)continue;let x=new CtSct();x.alg=hash==4?(sigType==3?2:(sigType==1?3:0)):(hash==5?(sigType==3?5:(sigType==1?6:0)):(hash==6?(sigType==3?9:(sigType==1?7:0)):0));if(x.alg==0||!ctLogFor(id,timestamp,x))continue;x.signature=bytesSlice(sct,ep,ep+sl);let w=new TlsWriter();w.u8v(0);w.u8v(0);w.u64bytes(tsb);if(precert){if(issuer==null||preTbs.length==0)continue;w.u16(1);w.bytes(sha256(issuer.spki));w.u24(preTbs.length);w.bytes(preTbs);}else{w.u16(0);w.u24(leaf.der.length);w.bytes(leaf.der);}w.u16(ext.length);w.bytes(ext);x.signed=w.out();c.ctQueue.push(x);}}

class BrowserUrl {
  raw:string="";
  scheme:string="http";
  host:string="";
  port:i32=80;
  path:string="/";
  valid:bool=false;
  secure:bool=false;
}

function parseUrl(input:string,base:string=""):BrowserUrl{
  let u=new BrowserUrl();let s=trim(input);
  if(s.length==0)return u;
  if(!s.includes("://")){
    if(base.length>0&&(s.startsWith("/")||s.startsWith("./")||s.startsWith("../")))return resolveRelative(base,s);
    s="https://"+s;
  }
  let p=s.indexOf("://");if(p<=0)return u;
  u.scheme=lower(s.substring(0,p));u.secure=u.scheme=="https";
  if(u.scheme!="http"&&u.scheme!="https")return u;
  let rest=s.substring(p+3);let slash=rest.indexOf("/");let auth=slash>=0?rest.substring(0,slash):rest;u.path=slash>=0?rest.substring(slash):"/";
  let hash=u.path.indexOf("#");if(hash>=0)u.path=u.path.substring(0,hash);
  if(u.path.length==0)u.path="/";
  if(auth.startsWith("[")){let close=auth.indexOf("]");if(close<2)return u;u.host=auth.substring(1,close);if(close+1<auth.length){if(auth.charCodeAt(close+1)!=58)return u;let ps=auth.substring(close+2),pv=I32.parseInt(ps);if(pv<1||pv>65535)return u;u.port=pv;}else u.port=u.secure?443:80;}else{let colon=auth.lastIndexOf(":");if(colon>0&&auth.indexOf(":")==colon){u.host=auth.substring(0,colon);let ps=auth.substring(colon+1),pv=I32.parseInt(ps);if(pv>0&&pv<65536)u.port=pv;else return u;}else{u.host=auth;u.port=u.secure?443:80;}}
  if(u.host.length==0)return u;
  u.raw=u.scheme+"://"+authorityHost(u.host)+((u.secure&&u.port!=443)||(!u.secure&&u.port!=80)?":"+u.port.toString():"")+u.path;
  u.valid=true;return u;
}

function isNavigationHostLike(s:string):bool{
  let host=s,slash=host.indexOf("/");if(slash>=0)host=host.substring(0,slash);let q=host.indexOf("?");if(q>=0)host=host.substring(0,q);
  if(host=="localhost"||host.startsWith("localhost:")||host.startsWith("[")||host.includes("."))return true;
  let digits:i32=0,colons:i32=0;for(let i:i32=0;i<host.length;i++){let c=host.charCodeAt(i);if(c>=48&&c<=57)digits++;else if(c==58)colons++;else return false;}return digits>0||colons>1;
}
function hasNavigationWhitespace(s:string):bool{for(let i:i32=0;i<s.length;i++)if(s.charCodeAt(i)<=32)return true;return false;}
function percentEncodeQuery(s:string):string{
  let b=utf8Bytes(s),hex="0123456789ABCDEF",out="";for(let i:i32=0;i<b.length;i++){let c=b[i];if((c>=65&&c<=90)||(c>=97&&c<=122)||(c>=48&&c<=57)||c==45||c==46||c==95||c==126)out+=String.fromCharCode(c);else if(c==32)out+="+";else{out+="%";out+=hex.charAt(c>>4);out+=hex.charAt(c&15);}}return out;
}
function navigationUrl(input:string,base:string=""):BrowserUrl{
  let s=trim(input);if(s.length==0)return new BrowserUrl();let l=lower(s);
  if(l.startsWith("http://")||l.startsWith("https://"))return parseUrl(s);
  if(base.length>0&&(s.startsWith("/")||s.startsWith("./")||s.startsWith("../")||s.startsWith("#")||s.startsWith("//")))return resolveRelative(base,s);
  if(hasNavigationWhitespace(s)||!isNavigationHostLike(s))return parseUrl("https://www.google.com/search?q="+percentEncodeQuery(s));
  return parseUrl("https://"+s);
}

function resolveRelative(base:string,href:string):BrowserUrl{
  let b=parseUrl(base);if(!b.valid)return parseUrl(href);
  let h=trim(href);if(h.startsWith("http://")||h.startsWith("https://"))return parseUrl(h);
  if(h.startsWith("//"))return parseUrl(b.scheme+":"+h);
  if(h.startsWith("#")){let x=new BrowserUrl();x.raw=base;x.scheme=b.scheme;x.host=b.host;x.port=b.port;x.path=b.path;x.valid=true;x.secure=b.secure;return x;}
  let path="";
  if(h.startsWith("/"))path=h;else{let dir=b.path;let q=dir.lastIndexOf("/");dir=q>=0?dir.substring(0,q+1):"/";path=dir+h;}
  let parts=path.split("/");let out=new Array<string>();
  for(let i=0;i<parts.length;i++){let x=parts[i];if(x==""&&i==0){out.push("");continue;}if(x=="."||x=="")continue;if(x==".."){if(out.length>1)out.pop();}else out.push(x);}
  path=out.join("/");if(!path.startsWith("/"))path="/"+path;
  return parseUrl(b.scheme+"://"+authorityHost(b.host)+((b.secure&&b.port!=443)||(!b.secure&&b.port!=80)?":"+b.port.toString():"")+path);
}

class Cookie {
  name:string="";value:string="";domain:string="";path:string="/";secure:bool=false;
}
const cookies=new Array<Cookie>();
const bookmarks=new Array<string>();
const bookmarkTitles=new Array<string>();

function setCookie(host:string,path:string,line:string):void{
  let parts=line.split(";");if(parts.length==0)return;let eq=parts[0].indexOf("=");if(eq<=0)return;
  let c=new Cookie();c.name=trim(parts[0].substring(0,eq));c.value=trim(parts[0].substring(eq+1));c.domain=host;c.path="/";
  for(let i=1;i<parts.length;i++){let v=trim(parts[i]);let vl=lower(v);if(vl=="secure")c.secure=true;else if(vl.startsWith("domain="))c.domain=trim(v.substring(7)).replace(".","");else if(vl.startsWith("path="))c.path=trim(v.substring(5));}
  for(let i=0;i<cookies.length;i++){let x=cookies[i];if(x.name==c.name&&x.domain==c.domain&&x.path==c.path){cookies[i]=c;return;}}
  if(cookies.length<512)cookies.push(c);
}
function cookieHeader(u:BrowserUrl):string{
  let out="";for(let i=0;i<cookies.length;i++){let c=cookies[i];if(c.secure&&!u.secure)continue;if(!(u.host==c.domain||u.host.endsWith("."+c.domain)))continue;if(!u.path.startsWith(c.path))continue;if(out.length)out+="; ";out+=c.name+"="+c.value;}return out;
}

class PageElement {
  kind:i32=E_TEXT;
  text:string="";
  href:string="";
  x:i32=0;y:i32=0;w:i32=0;h:i32=0;
}

// =============================================================================
// MODERN DOM TREE, CSS CASCADE & BOX MODEL ENGINE
// =============================================================================

class CssDeclaration {
  property: string = "";
  value: string = "";
  constructor(p: string = "", v: string = "") { this.property = lower(trim(p)); this.value = lower(trim(v)); }
}

class CssRule {
  selector: string = "";
  declarations: Array<CssDeclaration> = new Array<CssDeclaration>();
  specificity: i32 = 0;
  order: i32 = 0;
  constructor(sel: string = "") { this.selector = lower(trim(sel)); }
}

class DomStyle {
  color: u32 = rgba(32, 33, 36);
  bgColor: u32 = 0; // 0 = transparent
  borderColor: u32 = 0;
  fontSize: i32 = 15;
  lineHeight: i32 = 24;
  isBold: bool = false;
  isMonospace: bool = false;
  paddingTop: i32 = 0;
  paddingBottom: i32 = 0;
  paddingLeft: i32 = 0;
  paddingRight: i32 = 0;
  marginTop: i32 = 0;
  marginBottom: i32 = 0;
  marginLeft: i32 = 0;
  marginRight: i32 = 0;
  borderWidth: i32 = 0;
  borderRadius: i32 = 0;
  display: i32 = 1; // 0 = none, 1 = block, 2 = inline, 3 = flex, 4 = grid
  flexDirection: i32 = 0; // 0 = row, 1 = column
  justifyContent: i32 = 0; // 0 start, 1 center, 2 end, 3 space-between
  alignItems: i32 = 0;
  gap: i32 = 0;
  width: i32 = -1; // -1 = auto
  height: i32 = -1;
  minWidth: i32 = 0;
  minHeight: i32 = 0;
  maxWidth: i32 = 0;
  maxHeight: i32 = 0;
  textAlign: i32 = 0; // 0 = left/start, 1 = center, 2 = right
  whiteSpacePre: bool = false;
}

class DomNode {
  uid: i32 = 0;
  id: string = "";
  tagName: string = "";
  text: string = "";
  href: string = "";
  resourceId: i32 = 0;
  classList: Array<string> = new Array<string>();
  inlineStyles: Array<CssDeclaration> = new Array<CssDeclaration>();
  children: Array<DomNode> = new Array<DomNode>();
  parent: DomNode | null = null;
  style: DomStyle = new DomStyle();

  // Computed layout geometry
  x: i32 = 0;
  y: i32 = 0;
  w: i32 = 0;
  h: i32 = 0;

  constructor(tag: string = "") { this.tagName = lower(trim(tag)); }

  appendChild(child: DomNode): void { child.parent = this; this.children.push(child); }

  hasClass(cls: string): bool {
    let target = lower(cls);
    for (let i = 0; i < this.classList.length; i++) if (this.classList[i] == target) return true;
    return false;
  }
}

function appStorageSetText(key:string,value:string):void{let k=String.UTF8.encode(key),v=String.UTF8.encode(value);host_app_storage_set(changetype<usize>(k),k.byteLength,changetype<usize>(v),v.byteLength);}
function appStorageGetText(key:string):string{let k=String.UTF8.encode(key);let n=host_app_storage_size(changetype<usize>(k),k.byteLength);if(n<=0||n>4*1024*1024)return"";let b=new Uint8Array(n);let r=host_app_storage_get(changetype<usize>(k),k.byteLength,b.dataStart,n);return r>0?String.UTF8.decode(b.buffer):"";}
function saveBookmarks():void{let out="";for(let i=0;i<bookmarks.length;i++){out+=bookmarks[i].replace("\t"," ")+"\t"+bookmarkTitles[i].replace("\t"," ")+"\n";}appStorageSetText("bookmarks.v1",out);}
function loadBookmarks():void{bookmarks.length=0;bookmarkTitles.length=0;let s=appStorageGetText("bookmarks.v1");if(!s.length)return;let lines=s.split("\n");for(let i=0;i<lines.length&&bookmarks.length<512;i++){let l=lines[i],p=l.indexOf("\t");if(p<=0)continue;bookmarks.push(l.substring(0,p));bookmarkTitles.push(l.substring(p+1));}}
function bookmarkIndex(url:string):i32{for(let i=0;i<bookmarks.length;i++)if(bookmarks[i]==url)return i;return-1;}
function toggleBookmark(t:BrowserTab):void{if(!t.url.length)return;let i=bookmarkIndex(t.url);if(i>=0){bookmarks.splice(i,1);bookmarkTitles.splice(i,1);statusMessage="Bookmark removed";}else{bookmarks.push(t.url);bookmarkTitles.push(t.title.length?t.title:t.url);statusMessage="Bookmarked";}saveBookmarks();needsRender=true;}

function stateEscape(s:string):string{
  let out="";for(let i:i32=0;i<s.length;i++){let c=s.charCodeAt(i);if(c==37)out+="%25";else if(c==9)out+="%09";else if(c==10)out+="%0A";else if(c==13)out+="%0D";else out+=s.charAt(i);}return out;
}
function hexNibble(c:i32):i32{if(c>=48&&c<=57)return c-48;if(c>=65&&c<=70)return c-55;if(c>=97&&c<=102)return c-87;return-1;}
function stateUnescape(s:string):string{
  let out="";let i:i32=0;while(i<s.length){if(s.charCodeAt(i)==37&&i+2<s.length){let a=hexNibble(s.charCodeAt(i+1)),b=hexNibble(s.charCodeAt(i+2));if(a>=0&&b>=0){out+=String.fromCharCode((a<<4)|b);i+=3;continue;}}out+=s.charAt(i);i++;}return out;
}
function restoredTabElements(url:string):Array<PageElement>{
  let a=new Array<PageElement>();pushElement(a,E_H1,url.length?"Restored tab":"New Tab");
  if(url.length){pushElement(a,E_TEXT,"This tab was restored from the portable WASM OS workspace.");pushElement(a,E_TEXT,"Live network sockets are intentionally not serialized. Press Reload to reconnect through the packet-owned transport.");pushElement(a,E_LINK,"Reload restored URL",url);}else{a=homeElements();}return a;
}
function serializeWorkspaceState():string{
  let out="WASMBROWSER\t1\nA\t"+activeTab.toString()+"\t"+sidePanel.toString()+"\n";
  for(let i:i32=0;i<tabs.length;i++){
    let t=tabs[i];out+="T\t"+t.id.toString()+"\t"+stateEscape(t.title)+"\t"+stateEscape(t.url)+"\t"+t.historyIndex.toString()+"\t"+t.scrollY.toString()+"\n";
    for(let h:i32=0;h<t.history.length;h++)out+="H\t"+i.toString()+"\t"+stateEscape(t.history[h])+"\n";
  }
  for(let i:i32=0;i<bookmarks.length;i++)out+="B\t"+stateEscape(bookmarks[i])+"\t"+stateEscape(bookmarkTitles[i])+"\n";
  return out;
}
function restoreWorkspaceState(text:string):bool{
  let lines=text.split("\n");if(lines.length==0||!lines[0].startsWith("WASMBROWSER\t1"))return false;
  for(let i:i32=0;i<tabs.length;i++){cancelPageResources(tabs[i]);if(tabs[i].socketId>=0)host_tcp_close(tabs[i].socketId);}
  tabs.length=0;bookmarks.length=0;bookmarkTitles.length=0;let wantedActive:i32=0;sidePanel=0;nextTabId=1;
  for(let li:i32=1;li<lines.length;li++){
    let parts=lines[li].split("\t");if(parts.length==0)continue;let kind=parts[0];
    if(kind=="A"&&parts.length>=3){wantedActive=I32.parseInt(parts[1]);sidePanel=clampI(I32.parseInt(parts[2]),0,4);}
    else if(kind=="T"&&parts.length>=6&&tabs.length<MAX_TABS){let t=new BrowserTab();t.id=I32.parseInt(parts[1]);if(t.id<=0)t.id=nextTabId;t.title=stateUnescape(parts[2]);t.url=stateUnescape(parts[3]);t.displayUrl=t.url;t.historyIndex=I32.parseInt(parts[4]);t.scrollY=maxI(0,I32.parseInt(parts[5]));t.state=PAGE_READY;t.elements=restoredTabElements(t.url);tabs.push(t);if(t.id>=nextTabId)nextTabId=t.id+1;}
    else if(kind=="H"&&parts.length>=3){let ti=I32.parseInt(parts[1]);if(ti>=0&&ti<tabs.length&&tabs[ti].history.length<200)tabs[ti].history.push(stateUnescape(parts[2]));}
    else if(kind=="B"&&parts.length>=3&&bookmarks.length<512){bookmarks.push(stateUnescape(parts[1]));bookmarkTitles.push(stateUnescape(parts[2]));}
  }
  if(tabs.length==0){let t=new BrowserTab();t.id=nextTabId++;t.elements=homeElements();t.state=PAGE_READY;tabs.push(t);}activeTab=clampI(wantedActive,0,tabs.length-1);
  for(let i:i32=0;i<tabs.length;i++){let t=tabs[i];t.historyIndex=clampI(t.historyIndex,-1,t.history.length-1);layoutDocument(t);t.scrollY=clampI(t.scrollY,0,t.maxScroll);}addressDraft=tabNow().url;addressFocused=false;saveBookmarks();statusMessage="Workspace restored · network sessions require reconnect";needsRender=true;return true;
}
export function osWorkspaceStatePtr():i32{workspaceStateBuffer=String.UTF8.encode(serializeWorkspaceState());return <i32>changetype<usize>(workspaceStateBuffer);}
export function osWorkspaceStateSize():i32{return workspaceStateBuffer.byteLength;}
export function osWorkspaceRestorePtr():i32{return <i32>workspaceRestoreScratch.dataStart;}
export function osWorkspaceRestoreCapacity():i32{return workspaceRestoreScratch.length;}
export function osWorkspaceRestore(len:i32):i32{if(len<=0||len>workspaceRestoreScratch.length)return 0;let b=new Uint8Array(len);memory.copy(b.dataStart,workspaceRestoreScratch.dataStart,<usize>len);return restoreWorkspaceState(String.UTF8.decode(b.buffer))?1:0;}

const RESOURCE_CSS:i32=1,RESOURCE_SCRIPT:i32=2,RESOURCE_IMAGE:i32=3,RESOURCE_FONT:i32=4,RESOURCE_OTHER:i32=5;
const RESOURCE_QUEUED:i32=0,RESOURCE_LOADING:i32=1,RESOURCE_READY:i32=2,RESOURCE_WAITING:i32=3,RESOURCE_FAILED:i32=-1;
const RESOURCE_MAX_PARALLEL:i32=32,RESOURCE_MAX_PER_PAGE:i32=512,RESOURCE_CACHE_LIMIT:i32=128*1024*1024;
let nextResourceRequestId:i32=100000;

class BrowserResource {
  id:i32=0;ownerTabId:i32=0;requestTabId:i32=0;kind:i32=RESOURCE_OTHER;state:i32=RESOURCE_QUEUED;
  url:string="";contentType:string="";statusCode:i32=0;error:string="";bytes:i32=0;startedAt:f64=0;completedAt:f64=0;
  requestMethod:string="GET";requestHeaders:string="";requestBody:Uint8Array=new Uint8Array(0);cacheKey:string="";
  requestMode:string="no-cors";requestCredentials:string="include";requestOrigin:string="";requestDestination:string="resource";corsRequired:bool=false;
  preflightForId:i32=0;preflightHeaderNames:string="";
  body:Uint8Array=new Uint8Array(0);
  imageHandle:i32=-1;imageW:i32=0;imageH:i32=0;
  fetchIds:Array<i32>=new Array<i32>();
}

class BrowserTab {
  id:i32=0;
  title:string="New Tab";
  url:string="";
  displayUrl:string="";
  state:i32=PAGE_IDLE;
  error:string="";
  socketId:i32=-1;
  statusCode:i32=0;
  contentType:string="";
  contentLength:i32=-1;
  chunked:bool=false;
  headerEnd:i32=-1;
  requestStarted:f64=0;
  firstByteAt:f64=0;
  completedAt:f64=0;
  bytesReceived:i32=0;
  bytesSent:i32=0;
  redirects:i32=0;
  response:ByteAccumulator=new ByteAccumulator();
  body:Uint8Array=new Uint8Array(0);
  elements:Array<PageElement>=new Array<PageElement>();
  rootDom:DomNode=new DomNode("body");
  hasDomTree:bool=false;
  history:Array<string>=new Array<string>();
  historyIndex:i32=-1;
  scrollY:i32=0;
  maxScroll:i32=0;
  selectedLink:i32=-1;
  requestHeaders:string="";
  responseHeaders:string="";
  requestMethod:string="GET";
  requestExtraHeaders:string="";
  requestBody:Uint8Array=new Uint8Array(0);
  requestMode:string="navigate";
  requestCredentials:string="include";
  requestOrigin:string="";
  requestDestination:string="document";
  navigationInput:string="";
  autoHttps:bool=false;
  httpFallbackTried:bool=false;
  consoleLines:Array<string>=new Array<string>();
  consoleKinds:Array<i32>=new Array<i32>(); // 0 info, 1 warning, 2 error
  domNodeCount:i32=0;
  cssRuleCount:i32=0;
  scriptCount:i32=0;
  parseErrorCount:i32=0;
  parseDurationMs:f64=0;
  layoutDurationMs:f64=0;
  isResourceRequest:bool=false;
  isServiceRequest:bool=false;
  serviceRequestId:i32=0;
  isWebSocketRequest:bool=false;
  webSocketId:i32=0;
  h2PoolCarrier:bool=false;
  resourceId:i32=0;
  resourceOwnerTabId:i32=0;
  resourceKind:i32=RESOURCE_OTHER;
  resources:Array<BrowserResource>=new Array<BrowserResource>();
  cssRules:Array<CssRule>=new Array<CssRule>();
  resourceBytes:i32=0;
  resourcesReady:i32=0;
  resourcesFailed:i32=0;
  jsRealmId:i32=-1;
  rendererId:i32=-1;
  rendererCommitted:bool=false;
  rendererCreatedAt:f64=0;
}

function devConsole(t:BrowserTab,message:string,kind:i32=0):void{
  if(t.consoleLines.length>=200){t.consoleLines.shift();t.consoleKinds.shift();}
  t.consoleLines.push(message.length>500?message.substring(0,500):message);
  t.consoleKinds.push(clampI(kind,0,2));
}

const HPACK_HUFF_CODES:u32[]=[8184,8388568,268435426,268435427,268435428,268435429,268435430,268435431,268435432,16777194,1073741820,268435433,268435434,1073741821,268435435,268435436,268435437,268435438,268435439,268435440,268435441,268435442,1073741822,268435443,268435444,268435445,268435446,268435447,268435448,268435449,268435450,268435451,20,1016,1017,4090,8185,21,248,2042,1018,1019,249,2043,250,22,23,24,0,1,2,25,26,27,28,29,30,31,92,251,32764,32,4091,1020,8186,33,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,252,115,253,8187,524272,8188,16380,34,32765,3,35,4,36,5,37,38,39,6,116,117,40,41,42,7,43,118,44,8,9,45,119,120,121,122,123,32766,2044,16381,8189,268435452,1048550,4194258,1048551,1048552,4194259,4194260,4194261,8388569,4194262,8388570,8388571,8388572,8388573,8388574,16777195,8388575,16777196,16777197,4194263,8388576,16777198,8388577,8388578,8388579,8388580,2097116,4194264,8388581,4194265,8388582,8388583,16777199,4194266,2097117,1048553,4194267,4194268,8388584,8388585,2097118,8388586,4194269,4194270,16777200,2097119,4194271,8388587,8388588,2097120,2097121,4194272,2097122,8388589,4194273,8388590,8388591,1048554,4194274,4194275,4194276,8388592,4194277,4194278,8388593,67108832,67108833,1048555,524273,4194279,8388594,4194280,33554412,67108834,67108835,67108836,134217694,134217695,67108837,16777201,33554413,524274,2097123,67108838,134217696,134217697,67108839,134217698,16777202,2097124,2097125,67108840,67108841,268435453,134217699,134217700,134217701,1048556,16777203,1048557,2097126,4194281,2097127,2097128,8388595,4194282,4194283,33554414,33554415,16777204,16777205,67108842,8388596,67108843,134217702,67108844,67108845,134217703,134217704,134217705,134217706,134217707,268435454,134217708,134217709,134217710,134217711,134217712,67108846,1073741823];
const HPACK_HUFF_BITS:u8[]=[13,23,28,28,28,28,28,28,28,24,30,28,28,30,28,28,28,28,28,28,28,28,30,28,28,28,28,28,28,28,28,28,6,10,10,12,13,6,8,11,10,10,8,11,8,6,6,6,5,5,5,6,6,6,6,6,6,6,7,8,15,6,12,10,13,6,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,8,7,8,13,19,13,14,6,15,5,6,5,6,5,6,6,6,5,7,7,6,6,6,5,6,7,6,5,5,6,7,7,7,7,7,15,11,14,13,28,20,22,20,20,22,22,22,23,22,23,23,23,23,23,24,23,24,24,22,23,24,23,23,23,23,21,22,23,22,23,23,24,22,21,20,22,22,23,23,21,23,22,22,24,21,22,23,23,21,21,22,21,23,22,23,23,20,22,22,22,23,22,22,23,26,26,20,19,22,23,22,25,26,26,26,27,27,26,24,25,19,21,26,27,27,26,27,24,21,21,26,26,28,27,27,27,20,24,20,21,22,21,21,23,22,22,25,25,24,24,26,23,26,27,26,26,27,27,27,27,27,28,27,27,27,27,27,26,30];
const HPACK_STATIC_NAMES:string[]=["",":authority",":method",":method",":path",":path",":scheme",":scheme",":status",":status",":status",":status",":status",":status",":status","accept-charset","accept-encoding","accept-language","accept-ranges","accept","access-control-allow-origin","age","allow","authorization","cache-control","content-disposition","content-encoding","content-language","content-length","content-location","content-range","content-type","cookie","date","etag","expect","expires","from","host","if-match","if-modified-since","if-none-match","if-range","if-unmodified-since","last-modified","link","location","max-forwards","proxy-authenticate","proxy-authorization","range","referer","refresh","retry-after","server","set-cookie","strict-transport-security","transfer-encoding","user-agent","vary","via","www-authenticate"];
const HPACK_STATIC_VALUES:string[]=["","","GET","POST","/","/index.html","http","https","200","204","206","304","400","404","500","","gzip, deflate","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","","",""];
class HpackField{name:string="";value:string="";constructor(name:string="",value:string=""){this.name=name;this.value=value;}}
class HpackCursor{p:i32=0;ok:bool=true;}
function hpackInt(b:Uint8Array,c:HpackCursor,prefix:i32):i32{if(c.p>=b.length){c.ok=false;return 0;}let mask=(1<<prefix)-1,v=<i32>(b[c.p]&mask);c.p++;if(v<mask)return v;let shift:i32=0;while(c.p<b.length&&shift<=28){let x=b[c.p++];v+=(<i32>(x&127))<<shift;if((x&128)==0)return v;shift+=7;}c.ok=false;return 0;}
function hpackHuffman(src:Uint8Array):string{let out=new Array<u8>(),code:u32=0,bits:i32=0;for(let i:i32=0;i<src.length;i++){for(let j:i32=7;j>=0;j--){code=(code<<1)|((<u32>src[i]>>j)&1);bits++;let found:i32=-1;for(let s:i32=0;s<257;s++)if(HPACK_HUFF_BITS[s]==<u8>bits&&HPACK_HUFF_CODES[s]==code){found=s;break;}if(found>=0){if(found==256)return "";out.push(<u8>found);code=0;bits=0;}else if(bits>=30)return "";}}if(bits>7||(bits>0&&code!=((<u32>1<<bits)-1)))return "";let a=new Uint8Array(out.length);for(let i:i32=0;i<out.length;i++)a[i]=out[i];return String.UTF8.decode(a.buffer);}
function hpackString(b:Uint8Array,c:HpackCursor):string{if(c.p>=b.length){c.ok=false;return "";}let h=(b[c.p]&128)!=0,n=hpackInt(b,c,7);if(!c.ok||n<0||c.p+n>b.length){c.ok=false;return "";}let x=bytesSlice(b,c.p,c.p+n);c.p+=n;if(!h)return String.UTF8.decode(x.buffer);let s=hpackHuffman(x);if(s.length==0&&x.length>0)c.ok=false;return s;}
function hpackLookup(c:TlsConnection,index:i32):HpackField|null{if(index<=0)return null;if(index<HPACK_STATIC_NAMES.length)return new HpackField(HPACK_STATIC_NAMES[index],HPACK_STATIC_VALUES[index]);let d=index-HPACK_STATIC_NAMES.length;if(d<0||d>=c.hpackNames.length)return null;return new HpackField(c.hpackNames[d],c.hpackValues[d]);}
function hpackEvict(c:TlsConnection):void{while(c.hpackBytes>c.hpackMax&&c.hpackNames.length>0){let i=c.hpackNames.length-1;c.hpackBytes-=32+utf8Bytes(c.hpackNames[i]).length+utf8Bytes(c.hpackValues[i]).length;c.hpackNames.pop();c.hpackValues.pop();}}
function hpackInsert(c:TlsConnection,name:string,value:string):void{let n=32+utf8Bytes(name).length+utf8Bytes(value).length;if(n>c.hpackMax){c.hpackNames.length=0;c.hpackValues.length=0;c.hpackBytes=0;return;}c.hpackNames.unshift(name);c.hpackValues.unshift(value);c.hpackBytes+=n;hpackEvict(c);}
function hpackDecode(c:TlsConnection,b:Uint8Array):Array<HpackField>|null{let out=new Array<HpackField>(),p=new HpackCursor(),sawField=false,total:i32=0;while(p.p<b.length&&p.ok){let first=b[p.p],name="",value="",indexed=false;if((first&128)!=0){let n=hpackInt(b,p,7),f=hpackLookup(c,n);if(f==null){p.ok=false;break;}name=f.name;value=f.value;sawField=true;}else if((first&64)!=0){let n=hpackInt(b,p,6);if(n==0)name=hpackString(b,p);else{let f=hpackLookup(c,n);if(f==null){p.ok=false;break;}name=f.name;}value=hpackString(b,p);indexed=true;sawField=true;}else if((first&32)!=0){if(sawField){p.ok=false;break;}let n=hpackInt(b,p,5);if(!p.ok||n>4096){p.ok=false;break;}c.hpackMax=n;hpackEvict(c);continue;}else{let n=hpackInt(b,p,4);if(n==0)name=hpackString(b,p);else{let f=hpackLookup(c,n);if(f==null){p.ok=false;break;}name=f.name;}value=hpackString(b,p);sawField=true;}if(!p.ok||name.length==0){p.ok=false;break;}for(let i:i32=0;i<name.length;i++){let ch=name.charCodeAt(i);if(ch>=65&&ch<=90){p.ok=false;break;}}if(!p.ok)break;total+=name.length+value.length+32;if(total>65536||out.length>=256){p.ok=false;break;}let f=new HpackField(name,value);out.push(f);if(indexed)hpackInsert(c,name,value);}return p.ok&&p.p==b.length?out:null;}
function hpackWriteInt(out:Array<u8>,value:i32,prefix:i32,mask:i32):void{let m=(1<<prefix)-1;if(value<m){out.push(<u8>(mask|value));return;}out.push(<u8>(mask|m));value-=m;while(value>=128){out.push(<u8>((value&127)|128));value>>=7;}out.push(<u8>value);}
function hpackWriteString(out:Array<u8>,value:string):void{let b=utf8Bytes(value);hpackWriteInt(out,b.length,7,0);for(let i:i32=0;i<b.length;i++)out.push(b[i]);}
function hpackLiteral(out:Array<u8>,nameIndex:i32,value:string):void{hpackWriteInt(out,nameIndex,4,0);hpackWriteString(out,value);}
function hpackLiteralName(out:Array<u8>,name:string,value:string):void{hpackWriteInt(out,0,4,0);hpackWriteString(out,name);hpackWriteString(out,value);}
function resourceAccept(kind:i32):string{if(kind==RESOURCE_CSS)return"text/css,*/*;q=0.1";if(kind==RESOURCE_SCRIPT)return"text/javascript,application/javascript,*/*;q=0.1";if(kind==RESOURCE_IMAGE)return"image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/*;q=0.8,*/*;q=0.1";if(kind==RESOURCE_FONT)return"font/woff2,font/woff,application/font-woff,*/*;q=0.1";if(kind==RESOURCE_OTHER)return"*/*";return"text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5";}
function forbiddenRequestHeader(name:string):bool{let n=lower(trim(name));return n=="host"||n=="connection"||n=="proxy-connection"||n=="keep-alive"||n=="transfer-encoding"||n=="upgrade"||n=="content-length"||n=="cookie"||n=="origin"||n=="referer"||n.startsWith("sec-")||n.startsWith(":");}
function appendHpackExtraHeaders(out:Array<u8>,raw:string):void{let lines=raw.split("\n");for(let i:i32=0;i<lines.length&&i<64;i++){let line=trim(lines[i]),p=line.indexOf(":");if(p<=0)continue;let name=lower(trim(line.substring(0,p))),value=trim(line.substring(p+1));if(name.length==0||value.length>8192||forbiddenRequestHeader(name))continue;hpackLiteralName(out,name,value);}}
function urlOrigin(u:BrowserUrl):string{return (u.secure?"https://":"http://")+authorityHost(u.host)+(((u.secure&&u.port!=443)||(!u.secure&&u.port!=80))?":"+u.port.toString():"");}
function sameOrigin(a:BrowserUrl,b:BrowserUrl):bool{return a.valid&&b.valid&&a.secure==b.secure&&a.host==b.host&&a.port==b.port;}
function requestSendsCookies(t:BrowserTab,u:BrowserUrl):bool{if(t.requestCredentials=="omit")return false;if(t.requestCredentials=="include")return true;let source=parseUrl(t.requestOrigin);return source.valid&&sameOrigin(source,u);}
function hpackRequest(t:BrowserTab):Uint8Array{let u=parseUrl(t.url),out=new Array<u8>(),method=t.requestMethod.length?t.requestMethod.toUpperCase():"GET";if(method=="GET")out.push(0x82);else if(method=="POST")out.push(0x83);else hpackLiteral(out,2,method);out.push(0x87);hpackLiteral(out,4,u.path);let authority=authorityHost(u.host)+(((u.secure&&u.port!=443)||(!u.secure&&u.port!=80))?":"+u.port.toString():"");hpackLiteral(out,1,authority);hpackLiteral(out,58,"WASM-OS-Browser/5.1 PacketOwned-TLS13-H2");hpackLiteral(out,19,resourceAccept(t.isResourceRequest?t.resourceKind:0));hpackLiteral(out,17,"en-US,en;q=0.9,he;q=0.8");let ck=requestSendsCookies(t,u)?cookieHeader(u):"";if(ck.length)hpackLiteral(out,32,ck);if(t.requestOrigin.length)hpackLiteralName(out,"origin",t.requestOrigin);if(t.requestBody.length>0)hpackLiteral(out,28,t.requestBody.length.toString());appendHpackExtraHeaders(out,t.requestExtraHeaders);let b=new Uint8Array(out.length);for(let i:i32=0;i<out.length;i++)b[i]=out[i];return b;}
class H2Stream{
  id:i32=0;tabId:i32=0;headers:ByteAccumulator=new ByteAccumulator();endOnHeaders:bool=false;
  sendWindow:i32=65535;bodyOffset:i32=0;localClosed:bool=false;remoteClosed:bool=false;
  constructor(id:i32=0,tabId:i32=0,window:i32=65535){this.id=id;this.tabId=tabId;this.sendWindow=window;}
}
class TlsConnection{
  tabId:i32=0;host:string="";port:i32=443;poolOwnerId:i32=0;phase:i32=TLS_PHASE_KEYGEN;opId:i32=-1;opKind:i32=TLS_OP_NONE;keyId:i32=-1;publicKey:Uint8Array=new Uint8Array(0);wire:ByteAccumulator=new ByteAccumulator();handshake:ByteAccumulator=new ByteAccumulator();transcript:ByteAccumulator=new ByteAccumulator();certs:Array<CertificateInfo>=new Array<CertificateInfo>();chainIndex:i32=0;anchorIndex:i32=0;verifyAnchor:bool=false;pendingHandshake:Uint8Array=new Uint8Array(0);pendingInnerType:i32=0;pendingSeq:u64=0;shared:Uint8Array=new Uint8Array(0);offeredPsk:Uint8Array=new Uint8Array(0);offeredTicket:Uint8Array=new Uint8Array(0);handshakeSecret:Uint8Array=new Uint8Array(0);masterSecret:Uint8Array=new Uint8Array(0);resumptionMasterSecret:Uint8Array=new Uint8Array(0);clientHsSecret:Uint8Array=new Uint8Array(0);serverHsSecret:Uint8Array=new Uint8Array(0);clientAppSecret:Uint8Array=new Uint8Array(0);serverAppSecret:Uint8Array=new Uint8Array(0);readKey:Uint8Array=new Uint8Array(0);readIv:Uint8Array=new Uint8Array(0);writeKey:Uint8Array=new Uint8Array(0);writeIv:Uint8Array=new Uint8Array(0);readSeq:u64=0;writeSeq:u64=0;encrypted:bool=false;chainTrusted:bool=false;resumed:bool=false;protocol:string="http/1.1";cipher:string="TLS_AES_128_GCM_SHA256";peerSummary:string="";stapledOcsp:Uint8Array=new Uint8Array(0);tlsSctList:Uint8Array=new Uint8Array(0);outbound:Array<Uint8Array>=new Array<Uint8Array>();h2wire:ByteAccumulator=new ByteAccumulator();h2HeaderStream:i32=0;h2MaxFrame:i32=16384;h2Started:bool=false;h2NextStreamId:i32=3;h2PeerMaxConcurrent:i32=100;h2PeerInitialWindow:i32=65535;h2ConnSendWindow:i32=65535;h2Goaway:bool=false;h2GoawayLast:i32=0x7fffffff;h2Streams:Array<H2Stream>=new Array<H2Stream>();hpackNames:Array<string>=new Array<string>();hpackValues:Array<string>=new Array<string>();hpackBytes:i32=0;hpackMax:i32=4096;aiaUrlsTried:Array<string>=new Array<string>();aiaFetching:bool=false;aiaCandidate:bool=false;anchorCert:CertificateInfo|null=null;revocationChecked:bool=false;crlFetching:bool=false;crlUrlsTried:Array<string>=new Array<string>();pendingRevoked:bool=false;ctQueue:Array<CtSct>=new Array<CtSct>();ctIndex:i32=0;ctValid:i32=0;ctOperators:Array<i32>=new Array<i32>();ctChecked:bool=false;
  eeSeen:bool=false;
  signatureChecked:bool=false;
  policyUntil:f64=0;
  forceHttp1:bool=false;
}
class SessionTicket{port:i32=443;policyUntil:f64=0;host:string="";ticket:Uint8Array=new Uint8Array(0);psk:Uint8Array=new Uint8Array(0);ageAdd:u32=0;lifetime:u32=0;issuedAt:f64=0;}
const sessionTickets=new Array<SessionTicket>();
class TrustCacheEntry{host:string="";leafHash:Uint8Array=new Uint8Array(0);expiresAt:f64=0;}
const trustCache=new Array<TrustCacheEntry>();
const TRUST_CACHE_TTL_MS:f64=10.0*60.0*1000.0;
function trustCachePrune():void{let now=epoch_ms();for(let i:i32=trustCache.length-1;i>=0;i--)if(trustCache[i].expiresAt<=now)trustCache.splice(i,1);}
function trustCacheHostReady(host:string):bool{trustCachePrune();for(let i:i32=0;i<trustCache.length;i++)if(trustCache[i].host==host)return true;return false;}
function trustCacheStore(c:TlsConnection):void{if(c.certs.length==0)return;trustCachePrune();let fp=sha256(c.certs[0].der),now=epoch_ms(),ttlEnd=now+TRUST_CACHE_TTL_MS,until=c.certs[0].notAfter<ttlEnd?c.certs[0].notAfter:ttlEnd;for(let i:i32=0;i<trustCache.length;i++)if(trustCache[i].host==c.host&&bytesEq(trustCache[i].leafHash,fp)){trustCache[i].expiresAt=until;return;}let x=new TrustCacheEntry();x.host=c.host;x.leafHash=fp;x.expiresAt=until;trustCache.push(x);while(trustCache.length>32)trustCache.shift();}
function sessionTicketFor(host:string,port:i32):SessionTicket|null{let now=epoch_ms();for(let i:i32=sessionTickets.length-1;i>=0;i--){let x=sessionTickets[i];if(now>=x.policyUntil||now<x.issuedAt||now-x.issuedAt>=<f64>x.lifetime*1000.0||x.lifetime==0){sessionTickets.splice(i,1);continue;}if(x.host==host&&x.port==port)return x;}return null;}
function storeSessionTicket(c:TlsConnection,msg:Uint8Array):bool{if(c.resumptionMasterSecret.length!=32||msg.length<14)return false;let p:i32=4,life:u32=be32(msg,p);p+=4;let age:u32=be32(msg,p);p+=4;let nl=msg[p++];if(life==0||life>604800||p+nl+2>msg.length)return false;let nonce=bytesSlice(msg,p,p+nl);p+=nl;let tl=be16(msg,p);p+=2;if(tl<1||p+tl+2>msg.length)return false;let ticket=bytesSlice(msg,p,p+tl);p+=tl;let ex=be16(msg,p);p+=2;if(p+ex!=msg.length)return false;let x=new SessionTicket();x.host=c.host;x.port=c.port;x.policyUntil=c.policyUntil;x.ticket=ticket;x.psk=hkdfLabel(c.resumptionMasterSecret,"resumption",nonce,32);x.ageAdd=age;x.lifetime=life;x.issuedAt=epoch_ms();for(let i:i32=sessionTickets.length-1;i>=0;i--)if(sessionTickets[i].host==x.host&&bytesEq(sessionTickets[i].ticket,x.ticket))sessionTickets.splice(i,1);sessionTickets.push(x);while(sessionTickets.length>16)sessionTickets.shift();return true;}
const tlsConnections=new Array<TlsConnection>();
const resourceRequests=new Array<BrowserTab>();
class WebSocketChannel{rendererSocketId:i32=0;rendererId:i32=0;ownerTabId:i32=0;networkTabId:i32=0;serviceRequestId:i32=0;state:i32=0;closeStarted:f64=0;key:string="";protocols:string="";protocol:string="";incoming:ByteAccumulator=new ByteAccumulator();fragment:ByteAccumulator=new ByteAccumulator();fragmentOpcode:i32=0;}
const webSocketChannels=new Array<WebSocketChannel>();
let nextServiceWebSocketId:i32=1000000;
function webSocketById(rendererId:i32,socketId:i32):WebSocketChannel|null{for(let i:i32=0;i<webSocketChannels.length;i++){let w=webSocketChannels[i];if(w.rendererId==rendererId&&w.rendererSocketId==socketId)return w;}return null;}
function webSocketByNetworkTab(tabId:i32):WebSocketChannel|null{for(let i:i32=0;i<webSocketChannels.length;i++)if(webSocketChannels[i].networkTabId==tabId)return webSocketChannels[i];return null;}
function webSocketDispatch(w:WebSocketChannel,type:string,body:Uint8Array=new Uint8Array(0),extra:string=""):void{let json="{\"type\":\""+type+"\",\"socketId\":"+w.rendererSocketId.toString()+extra;if(body.length)json+=",\"bodyBase64\":\""+base64Encode(body)+"\"";json+="}";if(w.rendererId>=0){let b=String.UTF8.encode(json);host_web_renderer_protocol_dispatch(w.rendererId,changetype<usize>(b),b.byteLength,body.dataStart,body.length);}else{if(type=="websocket-open"&&w.serviceRequestId>0){OsService.respondJson(w.serviceRequestId,200,"{\"ok\":true,\"socketId\":"+w.rendererSocketId.toString()+",\"protocol\":\""+jsonEscapeText(w.protocol)+"\"}");w.serviceRequestId=0;}else if(type=="websocket-close"&&w.serviceRequestId>0){OsService.respondJson(w.serviceRequestId,502,"{\"ok\":false,\"error\":\"WebSocket handshake failed\"}");w.serviceRequestId=0;}if(websocketServiceId>=0)OsService.emitJson(websocketServiceId,"socket."+w.rendererSocketId.toString(),json);}}
function webSocketRemove(w:WebSocketChannel,code:i32=1006,reason:string="",clean:bool=false):void{let t=tabById(w.networkTabId);if(t!=null){if(t.socketId>=0){host_tcp_close(t.socketId);t.socketId=-1;}tlsRemove(t.id);for(let i:i32=resourceRequests.length-1;i>=0;i--)if(resourceRequests[i].id==t.id)resourceRequests.splice(i,1);}w.state=3;webSocketDispatch(w,"websocket-close",new Uint8Array(0),",\"code\":"+code.toString()+",\"reason\":\""+jsonEscapeText(reason)+"\",\"clean\":"+(clean?"true":"false"));for(let i:i32=webSocketChannels.length-1;i>=0;i--)if(webSocketChannels[i]===w){webSocketChannels.splice(i,1);break;}}
function tlsFind(tabId:i32):TlsConnection|null{for(let i:i32=0;i<tlsConnections.length;i++)if(tlsConnections[i].tabId==tabId)return tlsConnections[i];return null;}
function tlsRemove(tabId:i32):void{for(let i:i32=aiaFetches.length-1;i>=0;i--)if(aiaFetches[i].conn.tabId==tabId){if(aiaFetches[i].socketId>=0)host_tcp_close(aiaFetches[i].socketId);aiaFetches.splice(i,1);}for(let i:i32=crlFetches.length-1;i>=0;i--)if(crlFetches[i].conn.tabId==tabId){if(crlFetches[i].socketId>=0)host_tcp_close(crlFetches[i].socketId);crlFetches.splice(i,1);}for(let i:i32=tlsConnections.length-1;i>=0;i--)if(tlsConnections[i].tabId==tabId){let c=tlsConnections[i];if(c.opId>=0){host_crypto_op_release(c.opId);c.opId=-1;}if(c.keyId>=0){host_crypto_key_release(c.keyId);c.keyId=-1;}tlsConnections.splice(i,1);}}
function tabById(id:i32):BrowserTab|null{for(let i:i32=0;i<tabs.length;i++)if(tabs[i].id==id)return tabs[i];for(let i:i32=0;i<resourceRequests.length;i++)if(resourceRequests[i].id==id)return resourceRequests[i];return null;}
function tlsFail(c:TlsConnection,message:string):void{if(c.phase==TLS_PHASE_FAILED)return;c.phase=TLS_PHASE_FAILED;c.chainTrusted=false;c.signatureChecked=false;let t=tabById(c.tabId);if(t!=null&&t.isWebSocketRequest){let w=webSocketByNetworkTab(t.id);if(w!=null){webSocketDispatch(w,"websocket-error");webSocketRemove(w,1006,message);return;}}if(t&&!t.isResourceRequest&&(message.includes("raw TCP")||message.includes("TCP closed before secure"))&&tryHttpFallback(t,message))return;c.h2Goaway=true;if(c.protocol=="h2"&&c.h2Streams.length>0)h2AbortAll(c,"HTTP/2 connection failure: "+message);if(t&&t.state!=PAGE_READY){t.state=PAGE_ERROR;t.error="TLS 1.3: "+message;}if(t&&t.socketId>=0){host_tcp_close(t.socketId);t.socketId=-1;}if(t==null||!t.isResourceRequest)statusMessage="Secure connection failed: "+message;needsRender=true;if(c.opId>=0){host_crypto_op_release(c.opId);c.opId=-1;}if(c.keyId>=0){host_crypto_key_release(c.keyId);c.keyId=-1;}}
function tlsAppendTranscript(c:TlsConnection,msg:Uint8Array):bool{return c.transcript.append(msg,msg.length);}
function tlsExtension(kind:i32,data:Uint8Array):Uint8Array{let w=new TlsWriter();w.u16(kind);w.u16(data.length);w.bytes(data);return w.out();}
function tlsHandshakeMessage(kind:i32,body:Uint8Array):Uint8Array{let w=new TlsWriter();w.u8v(kind);w.u24(body.length);w.bytes(body);return w.out();}
function tlsPlainRecord(kind:i32,payload:Uint8Array,legacy:i32=0x0303):Uint8Array{let w=new TlsWriter();w.u8v(kind);w.u16(legacy);w.u16(payload.length);w.bytes(payload);return w.out();}
function tlsNonce(iv:Uint8Array,seq:u64):Uint8Array{let n=bytesSlice(iv,0,iv.length);for(let i:i32=0;i<8;i++)n[n.length-1-i]^=<u8>(seq>>(i*8));return n;}
function tlsCryptoResult(op:i32):Uint8Array{let n=host_crypto_op_size(op);if(n<0||n>2*1024*1024)return new Uint8Array(0);let b=new Uint8Array(n);let r=host_crypto_op_read(op,b.dataStart,n);return r==n?b:new Uint8Array(0);}
function tlsCryptoError(op:i32):string{let n=host_crypto_op_error_size(op);if(n<=0||n>4096)return"cryptographic primitive rejected";let b=new Uint8Array(n);let r=host_crypto_op_read_error(op,b.dataStart,n);return r>0?String.UTF8.decode(b.buffer):"cryptographic primitive rejected";}

function tlsBuildClientHello(c:TlsConnection):Uint8Array{
  let host=utf8Bytes(c.host),random=new Uint8Array(32),sid=new Uint8Array(32);if(host_crypto_random(random.dataStart,32)!=32||host_crypto_random(sid.dataStart,32)!=32)return new Uint8Array(0);
  let sni=new TlsWriter();sni.u16(3+host.length);sni.u8v(0);sni.u16(host.length);sni.bytes(host);
  let groups=new TlsWriter();groups.u16(2);groups.u16(0x0017);
  let sigs=new TlsWriter();sigs.u16(18);sigs.u16(0x0804);sigs.u16(0x0805);sigs.u16(0x0806);sigs.u16(0x0403);sigs.u16(0x0503);sigs.u16(0x0603);sigs.u16(0x0809);sigs.u16(0x080a);sigs.u16(0x080b);
  let vers=new TlsWriter();vers.u8v(2);vers.u16(0x0304);
  let share=new TlsWriter();share.u16(4+c.publicKey.length);share.u16(0x0017);share.u16(c.publicKey.length);share.bytes(c.publicKey);
  let h2=utf8Bytes("h2"),h1=utf8Bytes("http/1.1"),alpn=new TlsWriter();if(c.forceHttp1){alpn.u16(1+h1.length);alpn.u8v(h1.length);alpn.bytes(h1);}else{alpn.u16(2+h2.length+h1.length);alpn.u8v(h2.length);alpn.bytes(h2);alpn.u8v(h1.length);alpn.bytes(h1);}let status=new TlsWriter();status.u8v(1);status.u16(0);status.u16(0);
  let ext=new TlsWriter();if(!hostIsIp(c.host))ext.bytes(tlsExtension(0,sni.out()));ext.bytes(tlsExtension(5,status.out()));ext.bytes(tlsExtension(18,new Uint8Array(0)));ext.bytes(tlsExtension(10,groups.out()));ext.bytes(tlsExtension(13,sigs.out()));ext.bytes(tlsExtension(43,vers.out()));ext.bytes(tlsExtension(51,share.out()));ext.bytes(tlsExtension(16,alpn.out()));let ticket=sessionTicketFor(c.host,c.port),binderTail:i32=0;if(ticket){c.policyUntil=ticket.policyUntil;c.offeredPsk=bytesSlice(ticket.psk,0,ticket.psk.length);c.offeredTicket=bytesSlice(ticket.ticket,0,ticket.ticket.length);let modes=new TlsWriter();modes.u8v(1);modes.u8v(1);ext.bytes(tlsExtension(45,modes.out()));let identities=new TlsWriter();identities.u16(2+ticket.ticket.length+4);identities.u16(ticket.ticket.length);identities.bytes(ticket.ticket);let age=<u32>maxI(0,<i32>(epoch_ms()-ticket.issuedAt));identities.u32(age+ticket.ageAdd);let psk=new TlsWriter();psk.bytes(identities.out());psk.u16(33);psk.u8v(32);psk.bytes(new Uint8Array(32));ext.bytes(tlsExtension(41,psk.out()));binderTail=35;}
  let body=new TlsWriter();body.u16(0x0303);body.bytes(random);body.u8v(sid.length);body.bytes(sid);body.u16(2);body.u16(0x1301);body.u8v(1);body.u8v(0);let ex=ext.out();body.u16(ex.length);body.bytes(ex);let msg=tlsHandshakeMessage(1,body.out());if(ticket){let truncated=bytesSlice(msg,0,msg.length-binderTail),early=hkdfExtract(zeroBytes(32),ticket.psk),binderKey=deriveSecret(early,"res binder",new Uint8Array(0)),finishedKey=hkdfLabel(binderKey,"finished",new Uint8Array(0),32),binder=hmac256(finishedKey,sha256(truncated));memory.copy(msg.dataStart+msg.length-32,binder.dataStart,32);}tlsAppendTranscript(c,msg);return tlsPlainRecord(22,msg,0x0301);
}

function tlsStartVerify(c:TlsConnection,kind:i32,alg:i32,spki:Uint8Array,sig:Uint8Array,data:Uint8Array):bool{let op=host_crypto_verify_spki(alg,spki.dataStart,spki.length,sig.dataStart,sig.length,data.dataStart,data.length);if(op<0){tlsFail(c,"signature verification primitive unavailable");return false;}c.opId=op;c.opKind=kind;return true;}
function tlsParseCertificateMessage(c:TlsConnection,msg:Uint8Array):bool{
  if(msg.length<8)return false;let p:i32=4,contextLen:i32=msg[p++];if(p+contextLen+3>msg.length)return false;p+=contextLen;let listLen=be24(msg,p);p+=3;if(listLen<1||p+listLen!=msg.length)return false;c.certs.length=0;let end=p+listLen;
  while(p<end&&c.certs.length<TLS_MAX_CERTS){if(p+3>end)return false;let n=be24(msg,p);p+=3;if(n<1||p+n+2>end)return false;let cert=parseCertificate(bytesSlice(msg,p,p+n));if(!cert.valid)return false;c.certs.push(cert);p+=n;let ex=be16(msg,p);p+=2;if(p+ex>end)return false;let ee=p+ex;while(p<ee){if(p+4>ee)return false;let k=be16(msg,p),l=be16(msg,p+2);p+=4;if(p+l>ee)return false;if(c.certs.length==1&&k==5&&l>=4&&msg[p]==1&&be24(msg,p+1)==l-4)c.stapledOcsp=bytesSlice(msg,p+4,p+l);else if(c.certs.length==1&&k==18)c.tlsSctList=bytesSlice(msg,p,p+l);p+=l;}}
  return p==end&&c.certs.length>0;
}
function tlsCertificatePolicy(c:TlsConnection):bool{
  let now=epoch_ms();for(let i:i32=0;i<c.certs.length;i++){let x=c.certs[i];if(browserSpkiBlocked(x.spki)){tlsFail(c,"certificate public key is distrusted");return false;}if(now<x.notBefore||now>x.notAfter){tlsFail(c,"certificate is outside its validity period");return false;}if(x.unsupportedCritical){tlsFail(c,"certificate contains an unsupported critical extension");return false;}if(i>0){if(!x.isCa){tlsFail(c,"intermediate certificate lacks CA basic constraint");return false;}if(x.keyUsagePresent&&!x.keyCertSign){tlsFail(c,"intermediate certificate is not authorized to sign certificates");return false;}if(x.pathLen>=0&&i-1>x.pathLen){tlsFail(c,"certificate path exceeds an intermediate pathLen constraint");return false;}}}
  let leaf=c.certs[0];if(leaf.keyUsagePresent&&!leaf.digitalSignature){tlsFail(c,"leaf certificate is not authorized for digital signatures");return false;}if(leaf.ekuPresent&&!leaf.serverAuth){tlsFail(c,"leaf certificate is not authorized for TLS server authentication");return false;}
  let targetIp=parseIpLiteral(c.host),hostOk=false;if(targetIp.length){for(let i:i32=0;i<leaf.ipSans.length;i++)if(bytesEq(targetIp,leaf.ipSans[i])){hostOk=true;break;}}else for(let i:i32=0;i<leaf.sans.length;i++)if(dnsMatches(leaf.sans[i],c.host)){hostOk=true;break;}if(!hostOk){tlsFail(c,"certificate subjectAltName does not match "+c.host);return false;}
  if(!targetIp.length)for(let i:i32=1;i<c.certs.length;i++){let issuer=c.certs[i];for(let j:i32=0;j<issuer.excludedDns.length;j++)if(dnsWithinConstraint(c.host,issuer.excludedDns[j])){tlsFail(c,"certificate DNS name is excluded by a CA name constraint");return false;}if(issuer.permittedDns.length>0){let permitted=false;for(let j:i32=0;j<issuer.permittedDns.length;j++)if(dnsWithinConstraint(c.host,issuer.permittedDns[j])){permitted=true;break;}if(!permitted){tlsFail(c,"certificate DNS name is outside the CA permitted namespace");return false;}}}
  c.peerSummary=c.host+" · "+c.certs.length.toString()+" certs";return true;
}
function tlsOrderPresentedChain(c:TlsConnection):void{if(c.certs.length<2)return;let pool=c.certs,out=new Array<CertificateInfo>(),used=new Array<bool>();for(let i:i32=0;i<pool.length;i++)used.push(false);out.push(pool[0]);used[0]=true;while(out.length<pool.length){let last=out[out.length-1],found:i32=-1;for(let i:i32=1;i<pool.length;i++)if(!used[i]&&bytesEq(last.issuer,pool[i].subject)){found=i;break;}if(found<0)break;used[found]=true;out.push(pool[found]);}c.certs=out;}
function tlsStartChainValidation(c:TlsConnection):void{tlsOrderPresentedChain(c);if(!tlsCertificatePolicy(c))return;c.phase=TLS_PHASE_CHAIN_VERIFY;c.chainIndex=0;c.anchorIndex=0;c.verifyAnchor=false;tlsContinueChain(c);}
function tlsLeafIssuer(c:TlsConnection):CertificateInfo|null{return c.certs.length>1?c.certs[1]:c.anchorCert;}
function tlsFinalizeTrust(c:TlsConnection):void{if(c.phase==TLS_PHASE_FAILED||!c.chainTrusted)return;let until=epoch_ms()+TRUST_CACHE_TTL_MS;for(let i=0;i<c.certs.length;i++)until=Math.min(until,c.certs[i].notAfter);if(c.anchorCert!=null)until=Math.min(until,changetype<CertificateInfo>(c.anchorCert).notAfter);c.policyUntil=until;trustCacheStore(c);c.phase=TLS_PHASE_SERVER_FLIGHT;statusMessage="Certificate path, revocation, and CT policy accepted · "+c.peerSummary;let t=tabById(c.tabId);if(t)tlsPump(t,c);}
function ctOperatorSeen(c:TlsConnection,op:i32):bool{for(let i:i32=0;i<c.ctOperators.length;i++)if(c.ctOperators[i]==op)return true;return false;}
function ctNext(c:TlsConnection):void{while(c.ctIndex<c.ctQueue.length){let s=c.ctQueue[c.ctIndex++];if(tlsStartVerify(c,TLS_OP_VERIFY_CT,s.alg,s.spki,s.signature,s.signed)){statusMessage="Verifying Certificate Transparency SCT "+c.ctIndex.toString()+"/"+c.ctQueue.length.toString();return;}}tlsFinalizeTrust(c);}
function tlsTrustReady(c:TlsConnection):void{c.revocationChecked=true;if(c.ctChecked){tlsFinalizeTrust(c);return;}c.ctChecked=true;if(host_ct_log_count()<=0){tlsFinalizeTrust(c);return;}let pre=ctPrecertTbs(c.certs[0]);ctAddList(c,c.tlsSctList,false,new Uint8Array(0));ctAddList(c,c.certs[0].sctList,true,pre);if(c.ctQueue.length==0){tlsFinalizeTrust(c);return;}c.ctIndex=0;c.ctValid=0;c.ctOperators.length=0;ctNext(c);}
function tlsBeginTrustChecks(c:TlsConnection):void{let leaf=c.certs[0],issuer=tlsLeafIssuer(c);if(c.stapledOcsp.length){if(issuer==null){tlsFail(c,"OCSP issuer certificate unavailable");return;}let o=parseOcspResponse(c.stapledOcsp,leaf,issuer);if(!o.valid){tlsFail(c,"malformed, stale, mismatched, or unauthorized stapled OCSP response");return;}if(o.status==1){tlsFail(c,"certificate is revoked according to stapled OCSP");return;}if(o.status!=0){tlsFail(c,"stapled OCSP status is unknown");return;}if(!tlsStartVerify(c,TLS_OP_VERIFY_OCSP,o.sigAlg,issuer.spki,o.signature,o.tbs))return;statusMessage="Verifying signed stapled OCSP response";return;}if(leaf.mustStaple){tlsFail(c,"certificate requires OCSP stapling but the server supplied none");return;}if(!leaf.noRevAvail&&leaf.crlUrls.length>0&&crlTryNext(c))return;tlsTrustReady(c);}
function tlsContinueChain(c:TlsConnection):void{
  if(c.phase==TLS_PHASE_FAILED)return;
  if(c.certs.length==0){tlsFail(c,"empty certificate path");return;}
  if(c.chainIndex<c.certs.length-1){let child=c.certs[c.chainIndex],issuer=c.certs[c.chainIndex+1];if(!bytesEq(child.issuer,issuer.subject)){tlsFail(c,"certificate issuer/subject chain mismatch");return;}c.verifyAnchor=false;if(!tlsStartVerify(c,TLS_OP_VERIFY_CHAIN,child.sigAlg,issuer.spki,child.signature,child.tbs))return;return;}
  let last=c.certs[c.certs.length-1],count=host_trust_anchor_count();while(c.anchorIndex<count){let n=host_trust_anchor_size(c.anchorIndex);if(n<=0||n>65536){c.anchorIndex++;continue;}let b=new Uint8Array(n);if(host_trust_anchor_read(c.anchorIndex,b.dataStart,n)!=n){c.anchorIndex++;continue;}let root=parseCertificate(b);c.anchorIndex++;if(!root.valid||(!bytesEq(last.der,root.der)&&!bytesEq(last.issuer,root.subject)))continue;if(browserSpkiBlocked(root.spki))continue;if(bytesEq(last.der,root.der)){c.anchorCert=root;c.chainTrusted=true;tlsBeginTrustChecks(c);return;}if(!bytesEq(last.issuer,root.subject))continue;c.anchorCert=root;c.verifyAnchor=true;if(!tlsStartVerify(c,TLS_OP_VERIFY_CHAIN,last.sigAlg,root.spki,last.signature,last.tbs))return;return;}if(aiaTryNext(c))return;
  tlsFail(c,"no trusted TLS root found after exhausting chain and AIA candidates");
}

class AiaFetch{socketId:i32=-1;conn:TlsConnection;url:BrowserUrl;response:ByteAccumulator=new ByteAccumulator();sent:bool=false;headerEnd:i32=-1;contentLength:i32=-1;chunked:bool=false;constructor(conn:TlsConnection,url:BrowserUrl){this.conn=conn;this.url=url;}}
const aiaFetches=new Array<AiaFetch>();
function aiaSeen(c:TlsConnection,url:string):bool{for(let i:i32=0;i<c.aiaUrlsTried.length;i++)if(c.aiaUrlsTried[i]==url)return true;return false;}
function collectCertCandidates(b:Uint8Array,p:i32,end:i32,out:Array<CertificateInfo>,depth:i32=0):void{if(depth>12)return;while(p<end&&out.length<16){let n=derNode(b,p,end);if(!n.valid)return;if(n.tag==0x30){let der=bytesSlice(b,n.start,n.end),c=parseCertificate(der);if(c.valid){let duplicate=false;for(let i:i32=0;i<out.length;i++)if(bytesEq(out[i].der,c.der)){duplicate=true;break;}if(!duplicate)out.push(c);}collectCertCandidates(b,n.content,n.end,out,depth+1);}p=n.end;}}
function aiaTryNext(c:TlsConnection):bool{if(c.aiaFetching||c.certs.length==0)return c.aiaFetching;let last=c.certs[c.certs.length-1];for(let i:i32=0;i<last.aiaIssuers.length;i++){let raw=last.aiaIssuers[i];if(aiaSeen(c,raw))continue;c.aiaUrlsTried.push(raw);let u=parseUrl(raw);if(!u.valid||u.secure)continue;let a=new AiaFetch(c,u);a.socketId=tcpConnectString(u.host,u.port,3);if(a.socketId<0)continue;c.aiaFetching=true;aiaFetches.push(a);statusMessage="Building alternate certificate path via AIA · "+u.host;return true;}return false;}
function aiaRemove(a:AiaFetch):void{for(let i:i32=aiaFetches.length-1;i>=0;i--)if(aiaFetches[i]===a)aiaFetches.splice(i,1);}
function aiaComplete(a:AiaFetch,networkOk:bool):void{let c=a.conn;c.aiaFetching=false;if(a.socketId>=0){host_tcp_close(a.socketId);a.socketId=-1;}aiaRemove(a);if(c.phase==TLS_PHASE_FAILED)return;let accepted=false;if(networkOk&&a.headerEnd>=0){let headers=a.response.text(0,a.headerEnd),status=parseStatus(headers);if(status==200){let raw=a.response.slice(a.headerEnd,a.response.length),body=a.chunked?decodeChunked(raw):raw,candidates=new Array<CertificateInfo>(),last=c.certs[c.certs.length-1];collectCertCandidates(body,0,body.length,candidates);for(let i:i32=0;i<candidates.length;i++){let x=candidates[i],now=epoch_ms();if(bytesEq(last.issuer,x.subject)&&x.isCa&&(!x.keyUsagePresent||x.keyCertSign)&&!x.unsupportedCritical&&now>=x.notBefore&&now<=x.notAfter){let duplicate=false;for(let j:i32=0;j<c.certs.length;j++)if(bytesEq(c.certs[j].der,x.der)){duplicate=true;break;}if(!duplicate){c.certs.push(x);c.aiaCandidate=true;c.anchorIndex=0;accepted=true;break;}}}}}if(accepted){if(!tlsCertificatePolicy(c))return;tlsContinueChain(c);return;}if(!aiaTryNext(c))tlsFail(c,"AIA issuer retrieval exhausted without a valid intermediate certificate");}
function aiaPump(a:AiaFetch,state:i32):void{if(state<0){aiaComplete(a,false);return;}if(state==1&&!a.sent){let host=authorityHost(a.url.host)+(a.url.port!=80?":"+a.url.port.toString():""),req=utf8Bytes("GET "+a.url.path+" HTTP/1.1\r\nHost: "+host+"\r\nUser-Agent: WASM-OS-Browser/3.0 AIA\r\nAccept: application/pkix-cert,application/pkcs7-mime,*/*\r\nConnection: close\r\n\r\n");let n=host_tcp_send(a.socketId,req.dataStart,req.length);if(n!=req.length){aiaComplete(a,false);return;}a.sent=true;}let loops:i32=0;while(a.socketId>=0&&host_tcp_pending(a.socketId)>0&&loops<32){let n=host_tcp_receive(a.socketId,rxScratch.dataStart,rxScratch.length);if(n<=0)break;if(!a.response.append(rxScratch,n)){aiaComplete(a,false);return;}if(a.headerEnd<0){a.headerEnd=findHeaderEnd(a.response.data,a.response.length);if(a.headerEnd>=0){let h=a.response.text(0,a.headerEnd),cl=headerValue(h,"content-length");if(cl.length)a.contentLength=I32.parseInt(cl);a.chunked=lower(headerValue(h,"transfer-encoding")).includes("chunked");}}loops++;}if(a.socketId<0)return;if(a.headerEnd>=0&&!a.chunked&&a.contentLength>=0&&a.response.length-a.headerEnd>=a.contentLength){aiaComplete(a,true);return;}if(state==3)aiaComplete(a,a.headerEnd>=0);}
class CrlFetch{socketId:i32=-1;conn:TlsConnection;url:BrowserUrl;response:ByteAccumulator=new ByteAccumulator();sent:bool=false;headerEnd:i32=-1;contentLength:i32=-1;chunked:bool=false;constructor(conn:TlsConnection,url:BrowserUrl){this.conn=conn;this.url=url;}}
const crlFetches=new Array<CrlFetch>();
function crlSeen(c:TlsConnection,url:string):bool{for(let i:i32=0;i<c.crlUrlsTried.length;i++)if(c.crlUrlsTried[i]==url)return true;return false;}
function crlSoftFail(c:TlsConnection):void{statusMessage="Revocation network unavailable · browser soft-fail policy · chain remains cryptographically trusted";tlsTrustReady(c);}
function crlTryNext(c:TlsConnection):bool{if(c.crlFetching)return true;let leaf=c.certs[0];for(let i:i32=0;i<leaf.crlUrls.length;i++){let raw=leaf.crlUrls[i];if(crlSeen(c,raw))continue;c.crlUrlsTried.push(raw);let u=parseUrl(raw);if(!u.valid||u.secure)continue;let x=new CrlFetch(c,u);x.socketId=tcpConnectString(u.host,u.port,3);if(x.socketId<0)continue;c.crlFetching=true;crlFetches.push(x);statusMessage="Checking certificate revocation list · "+u.host;return true;}return false;}
function crlRemove(x:CrlFetch):void{for(let i:i32=crlFetches.length-1;i>=0;i--)if(crlFetches[i]===x)crlFetches.splice(i,1);}
function crlComplete(x:CrlFetch,networkOk:bool):void{let c=x.conn;c.crlFetching=false;if(x.socketId>=0){host_tcp_close(x.socketId);x.socketId=-1;}crlRemove(x);if(c.phase==TLS_PHASE_FAILED)return;if(networkOk&&x.headerEnd>=0&&parseStatus(x.response.text(0,x.headerEnd))==200){let raw=x.response.slice(x.headerEnd,x.response.length),body=x.chunked?decodeChunked(raw):raw,issuer=tlsLeafIssuer(c);if(issuer!=null){let info=parseCrl(body,c.certs[0],issuer);if(info.valid){c.pendingRevoked=info.revoked;if(tlsStartVerify(c,TLS_OP_VERIFY_CRL,info.sigAlg,issuer.spki,info.signature,info.tbs)){statusMessage="Verifying signed CRL";return;}}}}if(crlTryNext(c))return;crlSoftFail(c);}
function crlPump(x:CrlFetch,state:i32):void{if(state<0){crlComplete(x,false);return;}if(state==1&&!x.sent){let host=authorityHost(x.url.host)+(x.url.port!=80?":"+x.url.port.toString():""),req=utf8Bytes("GET "+x.url.path+" HTTP/1.1\r\nHost: "+host+"\r\nUser-Agent: WASM-OS-Browser/3.0 CRL\r\nAccept: application/pkix-crl,*/*\r\nConnection: close\r\n\r\n");if(host_tcp_send(x.socketId,req.dataStart,req.length)!=req.length){crlComplete(x,false);return;}x.sent=true;}let loops:i32=0;while(x.socketId>=0&&host_tcp_pending(x.socketId)>0&&loops<32){let n=host_tcp_receive(x.socketId,rxScratch.dataStart,rxScratch.length);if(n<=0)break;if(!x.response.append(rxScratch,n)){crlComplete(x,false);return;}if(x.headerEnd<0){x.headerEnd=findHeaderEnd(x.response.data,x.response.length);if(x.headerEnd>=0){let h=x.response.text(0,x.headerEnd),cl=headerValue(h,"content-length");if(cl.length)x.contentLength=I32.parseInt(cl);x.chunked=lower(headerValue(h,"transfer-encoding")).includes("chunked");}}loops++;}if(x.socketId<0)return;if(x.headerEnd>=0&&!x.chunked&&x.contentLength>=0&&x.response.length-x.headerEnd>=x.contentLength){crlComplete(x,true);return;}if(state==3)crlComplete(x,x.headerEnd>=0);}
function tlsDeriveHandshakeSecrets(c:TlsConnection):void{let z=zeroBytes(32),empty=new Uint8Array(0),early=hkdfExtract(z,c.resumed?c.offeredPsk:z),derived=deriveSecret(early,"derived",empty);c.handshakeSecret=hkdfExtract(derived,c.shared);let tr=c.transcript.slice(0,c.transcript.length);c.clientHsSecret=deriveSecret(c.handshakeSecret,"c hs traffic",tr);c.serverHsSecret=deriveSecret(c.handshakeSecret,"s hs traffic",tr);c.writeKey=hkdfLabel(c.clientHsSecret,"key",empty,16);c.writeIv=hkdfLabel(c.clientHsSecret,"iv",empty,12);c.readKey=hkdfLabel(c.serverHsSecret,"key",empty,16);c.readIv=hkdfLabel(c.serverHsSecret,"iv",empty,12);c.readSeq=0;c.writeSeq=0;c.encrypted=true;c.phase=TLS_PHASE_SERVER_FLIGHT;if(c.resumed){c.chainTrusted=true;c.peerSummary=c.host+" · resumed PSK";}if(c.keyId>=0){host_crypto_key_release(c.keyId);c.keyId=-1;}}
function tlsDeriveApplicationSecrets(c:TlsConnection):void{let empty=new Uint8Array(0),derived=deriveSecret(c.handshakeSecret,"derived",empty);c.masterSecret=hkdfExtract(derived,zeroBytes(32));let tr=c.transcript.slice(0,c.transcript.length);c.clientAppSecret=deriveSecret(c.masterSecret,"c ap traffic",tr);c.serverAppSecret=deriveSecret(c.masterSecret,"s ap traffic",tr);}
function tlsUpdateReadKeys(c:TlsConnection):void{let empty=new Uint8Array(0);c.serverAppSecret=hkdfLabel(c.serverAppSecret,"traffic upd",empty,32);c.readKey=hkdfLabel(c.serverAppSecret,"key",empty,16);c.readIv=hkdfLabel(c.serverAppSecret,"iv",empty,12);c.readSeq=0;}
function tlsUpdateWriteKeys(c:TlsConnection):void{let empty=new Uint8Array(0);c.clientAppSecret=hkdfLabel(c.clientAppSecret,"traffic upd",empty,32);c.writeKey=hkdfLabel(c.clientAppSecret,"key",empty,16);c.writeIv=hkdfLabel(c.clientAppSecret,"iv",empty,12);c.writeSeq=0;}
function tlsStartEncrypt(c:TlsConnection,kind:i32,content:Uint8Array,innerType:i32,key:Uint8Array,iv:Uint8Array,seq:u64):bool{let plain=new Uint8Array(content.length+1);if(content.length)memory.copy(plain.dataStart,content.dataStart,<usize>content.length);plain[content.length]=<u8>innerType;let aad=new Uint8Array(5);aad[0]=23;aad[1]=3;aad[2]=3;let clen=plain.length+16;aad[3]=<u8>(clen>>8);aad[4]=<u8>clen;let nonce=tlsNonce(iv,seq),op=host_crypto_aes_gcm_encrypt(key.dataStart,key.length,nonce.dataStart,nonce.length,aad.dataStart,aad.length,plain.dataStart,plain.length);if(op<0){tlsFail(c,"AES-GCM encrypt rejected");return false;}c.opId=op;c.opKind=kind;c.pendingInnerType=innerType;c.pendingSeq=seq;return true;}
function tlsStartDecrypt(c:TlsConnection,cipher:Uint8Array,aad:Uint8Array):bool{let nonce=tlsNonce(c.readIv,c.readSeq),op=host_crypto_aes_gcm_decrypt(c.readKey.dataStart,c.readKey.length,nonce.dataStart,nonce.length,aad.dataStart,aad.length,cipher.dataStart,cipher.length);if(op<0){tlsFail(c,"AES-GCM decrypt rejected");return false;}c.pendingSeq=c.readSeq++;c.opId=op;c.opKind=TLS_OP_DECRYPT;return true;}
function tlsSendCipherRecord(t:BrowserTab,c:TlsConnection,cipher:Uint8Array):bool{let r=tlsPlainRecord(23,cipher);let n=host_tcp_send(t.socketId,r.dataStart,r.length);if(n!=r.length){tlsFail(c,"short encrypted TCP write");return false;}t.bytesSent+=n;return true;}
function h2Frame(kind:i32,flags:i32,stream:i32,payload:Uint8Array):Uint8Array{let w=new TlsWriter();w.u24(payload.length);w.u8v(kind);w.u8v(flags);w.u32(<u32>stream&0x7fffffff);w.bytes(payload);return w.out();}
function tlsQueueApp(c:TlsConnection,b:Uint8Array):void{if(b.length)c.outbound.push(b);}
function tlsStartHttpPayload(c:TlsConnection,b:Uint8Array):bool{if(b.length==0)return false;let first=bytesSlice(b,0,minI(16384,b.length));for(let p:i32=first.length;p<b.length;p+=16384)c.outbound.push(bytesSlice(b,p,minI(b.length,p+16384)));return tlsStartEncrypt(c,TLS_OP_ENCRYPT_HTTP,first,23,c.writeKey,c.writeIv,c.writeSeq);}
function tlsPumpOutbound(t:BrowserTab,c:TlsConnection):void{if(t.socketId<0||c.opId>=0||c.outbound.length==0||c.phase<TLS_PHASE_ESTABLISHED)return;let b=c.outbound.shift();if(tlsStartEncrypt(c,TLS_OP_ENCRYPT_APP,b,23,c.writeKey,c.writeIv,c.writeSeq))c.writeSeq++;}
function h2StreamFind(c:TlsConnection,id:i32):H2Stream|null{for(let i:i32=0;i<c.h2Streams.length;i++)if(c.h2Streams[i].id==id)return c.h2Streams[i];return null;}
function h2StreamTab(s:H2Stream|null):BrowserTab|null{if(s==null)return null;return tabById(s.tabId);}
function h2StreamRemove(c:TlsConnection,id:i32):void{for(let i:i32=c.h2Streams.length-1;i>=0;i--)if(c.h2Streams[i].id==id){c.h2Streams.splice(i,1);return;}}
function h2ActiveStreams(c:TlsConnection):i32{let n:i32=0;for(let i:i32=0;i<c.h2Streams.length;i++)if(!c.h2Streams[i].remoteClosed)n++;return n;}
function h2AppendBody(c:TlsConnection,s:H2Stream,t:BrowserTab,out:ByteAccumulator):void{
  while(s.bodyOffset<t.requestBody.length&&c.h2ConnSendWindow>0&&s.sendWindow>0){let n=minI(c.h2MaxFrame,t.requestBody.length-s.bodyOffset);n=minI(n,c.h2ConnSendWindow);n=minI(n,s.sendWindow);if(n<=0)break;let end=s.bodyOffset+n>=t.requestBody.length,frame=h2Frame(H2_FRAME_DATA,end?H2_FLAG_END_STREAM:0,s.id,bytesSlice(t.requestBody,s.bodyOffset,s.bodyOffset+n));if(!out.append(frame,frame.length))return;s.bodyOffset+=n;c.h2ConnSendWindow-=n;s.sendWindow-=n;if(end)s.localClosed=true;}
}
function h2NewStream(c:TlsConnection,t:BrowserTab,id:i32):H2Stream{let s=new H2Stream(id,t.id,c.h2PeerInitialWindow);c.h2Streams.push(s);return s;}
function h2AppendHeaders(c:TlsConnection,t:BrowserTab,id:i32,out:ByteAccumulator):void{let block=hpackRequest(t),p:i32=0,first=true;do{let n=minI(c.h2MaxFrame,block.length-p),end=p+n>=block.length,kind=first?H2_FRAME_HEADERS:H2_FRAME_CONTINUATION,flags=(end?H2_FLAG_END_HEADERS:0)|(first&&t.requestBody.length==0?H2_FLAG_END_STREAM:0),frame=h2Frame(kind,flags,id,bytesSlice(block,p,p+n));out.append(frame,frame.length);p+=n;first=false;}while(p<block.length);}
function h2RequestFrames(c:TlsConnection,t:BrowserTab,id:i32):Uint8Array{let s=h2NewStream(c,t,id),out=new ByteAccumulator();h2AppendHeaders(c,t,id,out);if(t.requestBody.length==0)s.localClosed=true;else h2AppendBody(c,s,t,out);let u=parseUrl(t.url);t.requestHeaders=":method: "+t.requestMethod.toUpperCase()+"\r\n:scheme: https\r\n:authority: "+authorityHost(u.host)+"\r\n:path: "+u.path+"\r\n"+t.requestExtraHeaders;return out.slice(0,out.length);}
function h2Initial(t:BrowserTab,c:TlsConnection):Uint8Array{let settings=new TlsWriter();settings.u16(2);settings.u32(0);settings.u16(4);settings.u32(16*1024*1024);settings.u16(6);settings.u32(65536);let wu=new TlsWriter();wu.u32(16*1024*1024-65535);let out=new ByteAccumulator(),preface=utf8Bytes("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"),sf=h2Frame(H2_FRAME_SETTINGS,0,0,settings.out()),wf=h2Frame(H2_FRAME_WINDOW_UPDATE,0,0,wu.out()),request=h2RequestFrames(c,t,1);out.append(preface,preface.length);out.append(sf,sf.length);out.append(wf,wf.length);out.append(request,request.length);return out.slice(0,out.length);}
function h2FlushBodies(c:TlsConnection):void{let out=new ByteAccumulator();for(let i:i32=0;i<c.h2Streams.length;i++){let s=c.h2Streams[i];if(s.localClosed)continue;let t=tabById(s.tabId);if(t!=null)h2AppendBody(c,s,t,out);}if(out.length)tlsQueueApp(c,out.slice(0,out.length));}
function h2Carrier(c:TlsConnection):BrowserTab|null{return tabById(c.tabId);}
function h2PoolFor(ownerId:i32,u:BrowserUrl):TlsConnection|null{for(let i:i32=0;i<tlsConnections.length;i++){let c=tlsConnections[i],carrier=h2Carrier(c);if(c.poolOwnerId==ownerId&&c.host==u.host&&c.port==u.port&&c.protocol=="h2"&&c.phase>=TLS_PHASE_ESTABLISHED&&!c.h2Goaway&&c.h2NextStreamId>0&&c.h2NextStreamId<0x7fffffff&&h2ActiveStreams(c)<c.h2PeerMaxConcurrent&&carrier!=null&&carrier.socketId>=0)return c;}return null;}
function h2AttachRequest(c:TlsConnection,t:BrowserTab):bool{let carrier=h2Carrier(c);if(carrier==null||carrier.socketId<0||c.h2Goaway)return false;let id=c.h2NextStreamId;c.h2NextStreamId+=2;let frames=h2RequestFrames(c,t,id);t.state=PAGE_RECEIVING;t.requestStarted=now_ms();tlsQueueApp(c,frames);h2FlushBodies(c);tlsPumpOutbound(carrier,c);return true;}
function h2ApplyHeaders(t:BrowserTab,c:TlsConnection,block:Uint8Array):bool{let fields=hpackDecode(c,block);if(fields==null)return false;let first=t.statusCode==0,pseudo=true,statusSeen=false,lines=first?"HTTP/2":"";for(let i:i32=0;i<fields.length;i++){let f=fields[i],isPseudo=f.name.startsWith(":");if(isPseudo&&!pseudo)return false;if(!isPseudo)pseudo=false;if(f.name==":status"){if(!first||statusSeen||f.value.length!=3)return false;t.statusCode=I32.parseInt(f.value);if(t.statusCode<100||t.statusCode>999)return false;statusSeen=true;lines="HTTP/2 "+f.value+"\r\n";continue;}if(isPseudo)return false;if(f.name=="connection"||f.name=="proxy-connection"||f.name=="keep-alive"||f.name=="upgrade"||f.name=="transfer-encoding")return false;if(f.name=="te"&&lower(f.value)!="trailers")return false;lines+=f.name+": "+f.value+"\r\n";if(first&&f.name=="content-type")t.contentType=lower(f.value);else if(first&&f.name=="content-length")t.contentLength=I32.parseInt(f.value);else if(first&&f.name=="set-cookie"){let u=parseUrl(t.url);if(requestSendsCookies(t,u))setCookie(u.host,u.path,f.value);}}
  if(first&&!statusSeen)return false;if(first){t.responseHeaders=lines+"\r\n";if(t.statusCode>=100&&t.statusCode<200){t.statusCode=0;t.responseHeaders="";t.contentType="";t.contentLength=-1;}}else t.responseHeaders+=lines;return true;}
function h2FinishStream(c:TlsConnection,s:H2Stream):void{if(s.remoteClosed)return;s.remoteClosed=true;let t=tabById(s.tabId);h2StreamRemove(c,s.id);if(t==null||t.state!=PAGE_RECEIVING)return;t.body=t.response.slice(0,t.response.length);t.headerEnd=0;finalizeDecodedResponse(t);}
function h2FailStream(c:TlsConnection,s:H2Stream,message:string):void{let t=tabById(s.tabId);h2StreamRemove(c,s.id);if(t==null)return;t.state=PAGE_ERROR;t.error=message;if(t.isResourceRequest)failResourceRequest(t);else{statusMessage=message;needsRender=true;}}
function h2RetryStream(c:TlsConnection,s:H2Stream):bool{let t=tabById(s.tabId);if(t==null||!t.isResourceRequest||t.id==c.tabId||(t.requestMethod!="GET"&&t.requestMethod!="HEAD")||t.requestBody.length>0)return false;let owner=tabById(t.resourceOwnerTabId);if(owner==null||owner.isResourceRequest)return false;let r=resourceById(owner,t.resourceId);if(r==null)return false;h2StreamRemove(c,s.id);r.state=RESOURCE_QUEUED;r.requestTabId=0;for(let i:i32=resourceRequests.length-1;i>=0;i--)if(resourceRequests[i].id==t.id){resourceRequests.splice(i,1);break;}devConsole(owner,"Retrying idempotent HTTP/2 request after GOAWAY: "+r.url,1);return true;}
function h2AbortAll(c:TlsConnection,message:string):void{while(c.h2Streams.length>0){let s=c.h2Streams[c.h2Streams.length-1];h2FailStream(c,s,message);}}
function h2DetachTab(tabId:i32):void{for(let i:i32=0;i<tlsConnections.length;i++){let c=tlsConnections[i];for(let j:i32=c.h2Streams.length-1;j>=0;j--)if(c.h2Streams[j].tabId==tabId){let w=new TlsWriter();w.u32(8);tlsQueueApp(c,h2Frame(H2_FRAME_RST_STREAM,0,c.h2Streams[j].id,w.out()));h2StreamRemove(c,c.h2Streams[j].id);let carrier=h2Carrier(c);if(carrier!=null)tlsPumpOutbound(carrier,c);}}}
function h2Consume(carrier:BrowserTab,c:TlsConnection,plain:Uint8Array):void{if(plain.length==0)return;if(!c.h2wire.append(plain,plain.length)){tlsFail(c,"HTTP/2 receive buffer exceeded policy");return;}let controls=new ByteAccumulator();while(c.h2wire.length>=9){let n=be24(c.h2wire.data,0),kind=c.h2wire.data[3],flags=c.h2wire.data[4],stream=<i32>(be32(c.h2wire.data,5)&0x7fffffff);if(n>16384){tlsFail(c,"HTTP/2 peer exceeded the client receive MAX_FRAME_SIZE");return;}if(c.h2wire.length<9+n)break;let payload=c.h2wire.slice(9,9+n),rest=c.h2wire.slice(9+n,c.h2wire.length);c.h2wire.data=rest;c.h2wire.length=rest.length;if(c.h2HeaderStream!=0&&(kind!=H2_FRAME_CONTINUATION||stream!=c.h2HeaderStream)){tlsFail(c,"HTTP/2 header block was interleaved");return;}
    if(kind==H2_FRAME_SETTINGS){if(stream!=0){tlsFail(c,"HTTP/2 SETTINGS used a stream id");return;}if((flags&H2_FLAG_ACK)!=0){if(n!=0){tlsFail(c,"HTTP/2 SETTINGS ack carried a payload");return;}}else{if(n%6!=0){tlsFail(c,"malformed HTTP/2 SETTINGS");return;}for(let p:i32=0;p<n;p+=6){let id=be16(payload,p),v=be32(payload,p+2);if(id==2&&v>1){tlsFail(c,"invalid SETTINGS_ENABLE_PUSH");return;}if(id==3)c.h2PeerMaxConcurrent=v>1024?1024:<i32>v;if(id==5){if(v<16384||v>16777215){tlsFail(c,"invalid SETTINGS_MAX_FRAME_SIZE");return;}c.h2MaxFrame=<i32>v;}if(id==4){if(v>0x7fffffff){tlsFail(c,"invalid SETTINGS_INITIAL_WINDOW_SIZE");return;}let delta=<i32>v-c.h2PeerInitialWindow;c.h2PeerInitialWindow=<i32>v;for(let j:i32=0;j<c.h2Streams.length;j++){let next=c.h2Streams[j].sendWindow+delta;if(next<0-0x7fffffff||next>0x7fffffff){tlsFail(c,"HTTP/2 stream flow-control window overflow");return;}c.h2Streams[j].sendWindow=next;}}}controls.append(h2Frame(H2_FRAME_SETTINGS,H2_FLAG_ACK,0,new Uint8Array(0)),9);h2FlushBodies(c);}}
    else if(kind==H2_FRAME_PING){if(stream!=0||n!=8){tlsFail(c,"malformed HTTP/2 PING");return;}if((flags&H2_FLAG_ACK)==0)controls.append(h2Frame(H2_FRAME_PING,H2_FLAG_ACK,0,payload),17);}
    else if(kind==H2_FRAME_HEADERS){let s=h2StreamFind(c,stream);if(stream==0||s==null){tlsFail(c,"HTTP/2 HEADERS used an unknown stream");return;}let target=tabById(s.tabId);if(target==null){tlsFail(c,"HTTP/2 stream owner disappeared");return;}if(target.firstByteAt==0)target.firstByteAt=now_ms();let p:i32=0,pad:i32=0;if((flags&H2_FLAG_PADDED)!=0){if(n<1){tlsFail(c,"malformed padded HEADERS");return;}pad=payload[p++];}if((flags&H2_FLAG_PRIORITY)!=0){if(p+5>n){tlsFail(c,"malformed prioritized HEADERS");return;}p+=5;}if(p+pad>n||!s.headers.append(bytesSlice(payload,p,n-pad),n-pad-p)){tlsFail(c,"HTTP/2 header block exceeded policy");return;}s.endOnHeaders=(flags&H2_FLAG_END_STREAM)!=0;if((flags&H2_FLAG_END_HEADERS)!=0){if(!h2ApplyHeaders(target,c,s.headers.slice(0,s.headers.length))){tlsFail(c,"invalid HPACK response header block");return;}s.headers.clear();if(s.endOnHeaders)h2FinishStream(c,s);}else c.h2HeaderStream=stream;}
    else if(kind==H2_FRAME_CONTINUATION){let s=h2StreamFind(c,stream);let target=h2StreamTab(s);if(c.h2HeaderStream==0||stream!=c.h2HeaderStream||s==null||target==null||!s.headers.append(payload,payload.length)){tlsFail(c,"invalid HTTP/2 CONTINUATION");return;}if((flags&H2_FLAG_END_HEADERS)!=0){c.h2HeaderStream=0;if(!h2ApplyHeaders(target,c,s.headers.slice(0,s.headers.length))){tlsFail(c,"invalid continued HPACK block");return;}s.headers.clear();if(s.endOnHeaders)h2FinishStream(c,s);}}
    else if(kind==H2_FRAME_DATA){let s=h2StreamFind(c,stream);let target=h2StreamTab(s);if(stream==0||s==null||target==null||target.statusCode==0){tlsFail(c,"HTTP/2 DATA arrived on an invalid stream or before response headers");return;}let p:i32=0,pad:i32=0;if((flags&H2_FLAG_PADDED)!=0){if(n<1){tlsFail(c,"malformed padded DATA");return;}pad=payload[p++];}if(p+pad>n||!target.response.append(bytesSlice(payload,p,n-pad),n-pad-p)){h2FailStream(c,s,"HTTP/2 response exceeded document policy");continue;}target.bytesReceived+=n-pad-p;let inc=new TlsWriter();inc.u32(<u32>n);controls.append(h2Frame(H2_FRAME_WINDOW_UPDATE,0,0,inc.out()),13);controls.append(h2Frame(H2_FRAME_WINDOW_UPDATE,0,stream,inc.out()),13);if((flags&H2_FLAG_END_STREAM)!=0)h2FinishStream(c,s);}
    else if(kind==H2_FRAME_RST_STREAM){if(n!=4||stream==0){tlsFail(c,"malformed HTTP/2 RST_STREAM");return;}let s=h2StreamFind(c,stream);if(s!=null)h2FailStream(c,s,"HTTP/2 stream reset by peer ("+be32(payload,0).toString()+")");}
    else if(kind==H2_FRAME_PUSH_PROMISE){tlsFail(c,"server push received after SETTINGS_ENABLE_PUSH=0");return;}
    else if(kind==H2_FRAME_GOAWAY){if(n<8||stream!=0){tlsFail(c,"malformed HTTP/2 GOAWAY");return;}c.h2Goaway=true;c.h2GoawayLast=<i32>(be32(payload,0)&0x7fffffff);for(let i:i32=c.h2Streams.length-1;i>=0;i--)if(c.h2Streams[i].id>c.h2GoawayLast&&!h2RetryStream(c,c.h2Streams[i]))h2FailStream(c,c.h2Streams[i],"HTTP/2 stream was not processed before GOAWAY");}
    else if(kind==H2_FRAME_WINDOW_UPDATE){if(n!=4){tlsFail(c,"malformed HTTP/2 WINDOW_UPDATE");return;}let delta=<i32>(be32(payload,0)&0x7fffffff);if(delta==0){tlsFail(c,"zero HTTP/2 WINDOW_UPDATE increment");return;}if(stream==0){if(c.h2ConnSendWindow>0x7fffffff-delta){tlsFail(c,"HTTP/2 connection flow-control window overflow");return;}c.h2ConnSendWindow+=delta;}else{let s=h2StreamFind(c,stream);if(s!=null){if(s.sendWindow>0x7fffffff-delta){tlsFail(c,"HTTP/2 stream flow-control window overflow");return;}s.sendWindow+=delta;}}h2FlushBodies(c);}
  }if(controls.length)tlsQueueApp(c,controls.slice(0,controls.length));tlsPumpOutbound(carrier,c);}

function tlsParseServerHello(c:TlsConnection,msg:Uint8Array):bool{if(msg.length<44)return false;let p:i32=4;if(be16(msg,p)!=0x0303)return false;p+=2;p+=32;let sid:i32=msg[p++];if(p+sid+5>msg.length)return false;p+=sid;if(be16(msg,p)!=0x1301)return false;p+=2;if(msg[p++]!=0)return false;let el=be16(msg,p);p+=2;if(p+el!=msg.length)return false;let end=p+el,versionOk=false,pskSelected=false,share=new Uint8Array(0);while(p<end){if(p+4>end)return false;let kind=be16(msg,p),n=be16(msg,p+2);p+=4;if(p+n>end)return false;if(kind==43){if(n!=2||be16(msg,p)!=0x0304)return false;versionOk=true;}else if(kind==51){if(n<4||be16(msg,p)!=0x0017)return false;let q=be16(msg,p+2);if(q!=65||q+4!=n)return false;share=bytesSlice(msg,p+4,p+4+q);}else if(kind==41){if(n!=2||be16(msg,p)!=0||c.offeredPsk.length!=32)return false;pskSelected=true;}p+=n;}if(!versionOk||share.length!=65)return false;c.resumed=pskSelected;tlsAppendTranscript(c,msg);let op=host_crypto_p256_derive(c.keyId,share.dataStart,share.length);if(op<0)return false;c.opId=op;c.opKind=TLS_OP_DERIVE;c.phase=TLS_PHASE_DERIVE;return true;}
function tlsParseEncryptedExtensions(c:TlsConnection,msg:Uint8Array):bool{if(msg.length<6)return false;let p:i32=4,n=be16(msg,p);p+=2;if(p+n!=msg.length)return false;let end=p+n,alpnSeen=false;while(p<end){if(p+4>end)return false;let k=be16(msg,p),l=be16(msg,p+2);p+=4;if(p+l>end)return false;if(k==16){if(alpnSeen||l<3)return false;let q=p,all=be16(msg,q);q+=2;if(all+2!=l||q>=p+l)return false;let one=msg[q++];if(q+one!=p+l)return false;c.protocol=String.UTF8.decode(bytesSlice(msg,q,q+one).buffer);if(c.protocol!="h2"&&c.protocol!="http/1.1")return false;alpnSeen=true;}p+=l;}return true;}
function tlsSignatureScheme(s:i32):i32{if(s==0x0804||s==0x0809)return 1;if(s==0x0403)return 2;if(s==0x0805||s==0x080a)return 4;if(s==0x0503)return 5;if(s==0x0806||s==0x080b)return 8;if(s==0x0603)return 9;return 0;}
function tlsProcessHandshake(c:TlsConnection,msg:Uint8Array):void{
  let t=tabById(c.tabId);if(!t)return;let kind:i32=msg[0];
  if(kind==2&&c.phase==TLS_PHASE_SERVER_HELLO){if(!tlsParseServerHello(c,msg))tlsFail(c,"invalid or unsupported ServerHello");return;}
  if(!c.encrypted){tlsFail(c,"unexpected plaintext handshake message "+kind.toString());return;}
  if(kind==8){if(c.phase!=TLS_PHASE_SERVER_FLIGHT||c.eeSeen||!tlsParseEncryptedExtensions(c,msg)){tlsFail(c,"malformed EncryptedExtensions");return;}c.eeSeen=true;tlsAppendTranscript(c,msg);statusMessage="TLS 1.3 · encrypted extensions · "+c.protocol;return;}
  if(kind==11){if(c.phase!=TLS_PHASE_SERVER_FLIGHT||!c.eeSeen||c.resumed||c.certs.length!=0||!tlsParseCertificateMessage(c,msg)){tlsFail(c,"malformed X.509 Certificate message");return;}tlsAppendTranscript(c,msg);tlsStartChainValidation(c);return;}
  if(kind==15){if(c.phase!=TLS_PHASE_SERVER_FLIGHT||c.signatureChecked||c.resumed||!c.chainTrusted||c.certs.length==0||msg.length<8){tlsFail(c,"CertificateVerify arrived before a trusted certificate path");return;}let scheme=be16(msg,4),sl=be16(msg,6);if(8+sl!=msg.length){tlsFail(c,"malformed CertificateVerify");return;}let alg=tlsSignatureScheme(scheme);if(alg==0){tlsFail(c,"unsupported TLS CertificateVerify signature scheme");return;}let prefix=new Uint8Array(64);prefix.fill(0x20);let context=utf8Bytes("TLS 1.3, server CertificateVerify"),zero=new Uint8Array(1),th=sha256(c.transcript.slice(0,c.transcript.length)),signed=bytesCat3(prefix,bytesCat(context,zero),th);c.pendingHandshake=msg;c.phase=TLS_PHASE_CERT_VERIFY;tlsStartVerify(c,TLS_OP_VERIFY_CERT,alg,c.certs[0].spki,bytesSlice(msg,8,msg.length),signed);return;}
  if(kind==20){if(!tlsMayFinish(c)||msg.length!=36){tlsFail(c,"malformed server Finished");return;}let fk=hkdfLabel(c.serverHsSecret,"finished",new Uint8Array(0),32),expected=hmac256(fk,sha256(c.transcript.slice(0,c.transcript.length)));if(!bytesEq(expected,bytesSlice(msg,4,36))){tlsFail(c,"server Finished transcript authentication failed");return;}tlsAppendTranscript(c,msg);tlsDeriveApplicationSecrets(c);let cfk=hkdfLabel(c.clientHsSecret,"finished",new Uint8Array(0),32),verify=hmac256(cfk,sha256(c.transcript.slice(0,c.transcript.length))),clientMsg=tlsHandshakeMessage(20,verify);tlsAppendTranscript(c,clientMsg);c.resumptionMasterSecret=deriveSecret(c.masterSecret,"res master",c.transcript.slice(0,c.transcript.length));c.phase=TLS_PHASE_CLIENT_FINISHED;if(!tlsStartEncrypt(c,TLS_OP_ENCRYPT_FINISHED,clientMsg,22,c.writeKey,c.writeIv,c.writeSeq))return;c.writeSeq++;c.readKey=hkdfLabel(c.serverAppSecret,"key",new Uint8Array(0),16);c.readIv=hkdfLabel(c.serverAppSecret,"iv",new Uint8Array(0),12);c.readSeq=0;return;}
  if(kind==4&&c.phase>=TLS_PHASE_ESTABLISHED){if(!storeSessionTicket(c,msg)){tlsFail(c,"malformed TLS NewSessionTicket");return;}statusMessage="TLS 1.3 session ticket stored in volatile WASM memory";return;}
  if(kind==24&&c.phase>=TLS_PHASE_ESTABLISHED){if(msg.length!=5||msg[4]>1){tlsFail(c,"malformed TLS KeyUpdate");return;}let requested=msg[4];tlsUpdateReadKeys(c);if(requested==1){let response=tlsHandshakeMessage(24,new Uint8Array(1));if(!tlsStartEncrypt(c,TLS_OP_ENCRYPT_KEY_UPDATE,response,22,c.writeKey,c.writeIv,c.writeSeq))return;c.writeSeq++;}return;}
  tlsFail(c,"unexpected TLS handshake message "+kind.toString());
}
function tlsDrainHandshake(c:TlsConnection):void{while(c.phase!=TLS_PHASE_FAILED&&c.opId<0&&!c.aiaFetching&&!c.crlFetching&&c.handshake.length>=4){let n=be24(c.handshake.data,1);if(n<0||n>TLS_MAX_HANDSHAKE){tlsFail(c,"handshake message exceeds policy limit");return;}if(c.handshake.length<4+n)return;let msg=c.handshake.slice(0,4+n),rest=c.handshake.slice(4+n,c.handshake.length);c.handshake.data=rest;c.handshake.length=rest.length;tlsProcessHandshake(c,msg);}}
function tlsConsumeHttp(t:BrowserTab,c:TlsConnection,plain:Uint8Array):void{if(plain.length==0)return;if(t.firstByteAt==0)t.firstByteAt=now_ms();if(!t.response.append(plain,plain.length)){tlsFail(c,"HTTPS response exceeded document policy limit");return;}t.bytesReceived+=plain.length;if(t.headerEnd<0){t.headerEnd=findHeaderEnd(t.response.data,t.response.length);if(t.headerEnd>=0)parseHeaders(t);}if(t.headerEnd>=0){if(!t.chunked&&t.contentLength>=0&&t.response.length-t.headerEnd>=t.contentLength){host_tcp_close(t.socketId);t.socketId=-1;finalizeResponse(t);return;}if(t.chunked){let tail=t.response.text(maxI(t.headerEnd,t.response.length-12),t.response.length);if(tail.endsWith("0\r\n\r\n")){host_tcp_close(t.socketId);t.socketId=-1;finalizeResponse(t);return;}}}}
function tlsHandlePlaintext(t:BrowserTab,c:TlsConnection,plain:Uint8Array):void{let p=plain.length-1;while(p>=0&&plain[p]==0)p--;if(p<0){tlsFail(c,"TLSInnerPlaintext lacks content type");return;}let kind=plain[p],content=bytesSlice(plain,0,p);if(kind==22){if(!c.handshake.append(content,content.length)){tlsFail(c,"handshake buffer overflow");return;}tlsDrainHandshake(c);}else if(kind==23){if(c.phase<TLS_PHASE_ESTABLISHED){tlsFail(c,"application data before Finished");return;}if(t.isWebSocketRequest)webSocketConsume(t,content);else if(c.protocol=="h2")h2Consume(t,c,content);else tlsConsumeHttp(t,c,content);}else if(kind==21){if(content.length>=2&&content[1]==0){c.h2Goaway=true;if(t.isWebSocketRequest){let w=webSocketByNetworkTab(t.id);if(w!=null)webSocketRemove(w,1000,"TLS close_notify",true);}else if(c.protocol=="h2"&&c.h2Streams.length>0)h2AbortAll(c,"HTTP/2 peer closed the TLS connection with active streams");else if(t.headerEnd>=0&&t.state==PAGE_RECEIVING)finalizeResponse(t);}else tlsFail(c,"peer sent a fatal TLS alert");}else if(kind!=20)tlsFail(c,"unsupported TLS inner content type");}
function tlsConsumeWire(t:BrowserTab,c:TlsConnection):void{while(c.opId<0&&c.wire.length>=5){let kind=c.wire.data[0],ver=be16(c.wire.data,1),n=be16(c.wire.data,3);if(ver!=0x0303&&ver!=0x0301){tlsFail(c,"invalid TLS record version");return;}if(n<0||n>TLS_MAX_RECORD){tlsFail(c,"TLS record length exceeds policy");return;}if(c.wire.length<5+n)return;let header=c.wire.slice(0,5),payload=c.wire.slice(5,5+n),rest=c.wire.slice(5+n,c.wire.length);c.wire.data=rest;c.wire.length=rest.length;if(kind==20){continue;}if(kind==21&&!c.encrypted){tlsFail(c,"plaintext TLS alert from peer");return;}if(kind==22&&!c.encrypted){if(!c.handshake.append(payload,payload.length)){tlsFail(c,"handshake buffer overflow");return;}tlsDrainHandshake(c);continue;}if(kind==23&&c.encrypted){tlsStartDecrypt(c,payload,header);return;}tlsFail(c,"unexpected TLS record content type "+kind.toString());return;}}

function tlsPump(t:BrowserTab,c:TlsConnection):void{if(c.phase==TLS_PHASE_FAILED||t.socketId<0)return;let st=host_tcp_state(t.socketId);if(st<0){tlsFail(c,"raw TCP transport failed");return;}if(st==1&&c.phase==TLS_PHASE_CLIENT_HELLO&&c.publicKey.length==65){let rec=tlsBuildClientHello(c);if(rec.length==0){tlsFail(c,"CSPRNG or ClientHello construction failed");return;}let n=host_tcp_send(t.socketId,rec.dataStart,rec.length);if(n!=rec.length){tlsFail(c,"ClientHello TCP write was incomplete");return;}t.bytesSent+=n;c.phase=TLS_PHASE_SERVER_HELLO;statusMessage="TLS 1.3 ClientHello sent · P-256 · AES-128-GCM";}if(c.opId<0&&c.handshake.length>=4)tlsDrainHandshake(c);if(c.opId<0&&c.wire.length>=5)tlsConsumeWire(t,c);if(c.opId>=0||t.state==PAGE_ERROR)return;
  let loops:i32=0;while(c.opId<0&&host_tcp_pending(t.socketId)>0&&loops<32){let n=host_tcp_receive(t.socketId,rxScratch.dataStart,rxScratch.length);if(n<=0)break;if(!c.wire.append(rxScratch,n)){tlsFail(c,"TLS wire buffer overflow");return;}tlsConsumeWire(t,c);loops++;}
  if(st==3&&t.socketId>=0){t.socketId=-1;c.h2Goaway=true;if(c.protocol=="h2"){if(c.h2Streams.length>0)h2AbortAll(c,"HTTP/2 transport closed with active streams");return;}if(c.phase>=TLS_PHASE_ESTABLISHED&&t.headerEnd>=0&&t.state==PAGE_RECEIVING)finalizeResponse(t);else if(t.state!=PAGE_READY)tlsFail(c,"TCP closed before secure response completed");}}

export function cryptoEvent(opId:i32,state:i32,resultBytes:i32):void{for(let i:i32=0;i<tlsConnections.length;i++){let c=tlsConnections[i];if(c.opId!=opId)continue;let t=tabById(c.tabId);if(!t)return;if(state<0){let e=tlsCryptoError(opId);host_crypto_op_release(opId);c.opId=-1;tlsFail(c,e);return;}if(state==0)return;let result=tlsCryptoResult(opId),kind=c.opKind;host_crypto_op_release(opId);c.opId=-1;c.opKind=TLS_OP_NONE;
    if(kind==TLS_OP_KEYGEN){if(result.length!=69){tlsFail(c,"invalid P-256 key generation result");return;}c.keyId=<i32>be32(result,0);c.publicKey=bytesSlice(result,4,result.length);c.phase=TLS_PHASE_CLIENT_HELLO;tlsPump(t,c);return;}
    if(kind==TLS_OP_DERIVE){if(result.length!=32){tlsFail(c,"invalid ECDH shared secret size");return;}c.shared=result;tlsDeriveHandshakeSecrets(c);tlsPump(t,c);return;}
    if(kind==TLS_OP_DECRYPT){if(result.length==0){tlsFail(c,"empty authenticated TLS record");return;}tlsHandlePlaintext(t,c,result);tlsPump(t,c);return;}
    if(kind==TLS_OP_VERIFY_CHAIN){let ok=result.length==1&&result[0]==1;if(!ok){if(c.verifyAnchor){c.verifyAnchor=false;c.anchorCert=null;tlsContinueChain(c);}else if(c.aiaCandidate&&c.certs.length>1&&c.chainIndex==c.certs.length-2){c.certs.pop();c.aiaCandidate=false;c.anchorIndex=0;if(!aiaTryNext(c))tlsFail(c,"all alternate AIA issuer signatures were rejected");}else tlsFail(c,"certificate chain signature verification failed");return;}if(c.verifyAnchor){c.chainTrusted=true;c.verifyAnchor=false;tlsBeginTrustChecks(c);}else{c.aiaCandidate=false;c.chainIndex++;tlsContinueChain(c);}return;}
    if(kind==TLS_OP_VERIFY_OCSP){if(result.length!=1||result[0]!=1){tlsFail(c,"stapled OCSP signature verification failed");return;}tlsTrustReady(c);return;}
    if(kind==TLS_OP_VERIFY_CRL){if(result.length!=1||result[0]!=1){if(crlTryNext(c))return;crlSoftFail(c);return;}if(c.pendingRevoked){tlsFail(c,"certificate serial is present in a signed current CRL");return;}tlsTrustReady(c);return;}
    if(kind==TLS_OP_VERIFY_CT){if(result.length==1&&result[0]==1){let s=c.ctQueue[c.ctIndex-1];c.ctValid++;if(!ctOperatorSeen(c,s.operator))c.ctOperators.push(s.operator);}ctNext(c);return;}
    if(kind==TLS_OP_VERIFY_CERT){if(result.length!=1||result[0]!=1){tlsFail(c,"TLS CertificateVerify signature failed");return;}c.signatureChecked=true;tlsAppendTranscript(c,c.pendingHandshake);c.pendingHandshake=new Uint8Array(0);c.phase=TLS_PHASE_SERVER_FLIGHT;tlsPump(t,c);return;}
    if(kind==TLS_OP_ENCRYPT_FINISHED){if(!tlsSendCipherRecord(t,c,result))return;c.writeKey=hkdfLabel(c.clientAppSecret,"key",new Uint8Array(0),16);c.writeIv=hkdfLabel(c.clientAppSecret,"iv",new Uint8Array(0),12);c.writeSeq=0;c.phase=TLS_PHASE_HTTP_ENCRYPT;let b=new Uint8Array(0);if(c.protocol=="h2"&&!t.isWebSocketRequest)b=h2Initial(t,c);else{let u=parseUrl(t.url),req=t.isWebSocketRequest?buildWebSocketRequest(t):buildRequest(u,t.isResourceRequest?t.resourceKind:0,t),head=utf8Bytes(req);b=t.requestBody.length?bytesCat(head,t.requestBody):head;t.requestHeaders=req;}if(!tlsStartHttpPayload(c,b))return;c.writeSeq++;return;}
    if(kind==TLS_OP_ENCRYPT_HTTP){if(!tlsSendCipherRecord(t,c,result))return;c.phase=TLS_PHASE_ESTABLISHED;t.state=PAGE_RECEIVING;c.h2Started=c.protocol=="h2";if(t.isResourceRequest&&c.protocol=="h2")t.h2PoolCarrier=true;if(!t.isResourceRequest)statusMessage="TLS 1.3 secure · "+c.protocol+" · waiting for HTTPS response";needsRender=true;tlsPumpOutbound(t,c);tlsPump(t,c);return;}
    if(kind==TLS_OP_ENCRYPT_APP){if(!tlsSendCipherRecord(t,c,result))return;tlsPumpOutbound(t,c);tlsPump(t,c);return;}
    if(kind==TLS_OP_ENCRYPT_KEY_UPDATE){if(!tlsSendCipherRecord(t,c,result))return;tlsUpdateWriteKeys(c);statusMessage="TLS 1.3 traffic keys updated";tlsPump(t,c);return;}
  }}
const tabs=new Array<BrowserTab>();

function tabNow():BrowserTab{return tabs[activeTab];}
function addTab(url:string=""):void{
  if(tabs.length>=MAX_TABS){statusMessage="Maximum tabs reached";return;}
  let t=new BrowserTab();t.id=nextTabId++;tabs.push(t);activeTab=tabs.length-1;addressFocused=true;addressDraft=url;
  if(url.length)navigate(t,url,true);else{t.elements=homeElements();t.state=PAGE_READY;t.title="New Tab";}
  needsRender=true;
}
function closeTab(index:i32):void{
  if(index<0||index>=tabs.length)return;let t=tabs[index];cancelPageResources(t);if(t.socketId>=0)host_tcp_close(t.socketId);tlsRemove(t.id);tabs.splice(index,1);if(tabs.length==0)addTab("");activeTab=clampI(activeTab,0,tabs.length-1);addressDraft=tabNow().url;needsRender=true;
}

function pushHistory(t:BrowserTab,url:string):void{
  if(t.historyIndex>=0&&t.historyIndex<t.history.length-1){while(t.history.length-1>t.historyIndex)t.history.pop();}
  if(t.history.length==0||t.history[t.history.length-1]!=url){t.history.push(url);if(t.history.length>200)t.history.shift();}
  t.historyIndex=t.history.length-1;
}
function goHistory(delta:i32):void{let t=tabNow();let ni=t.historyIndex+delta;if(ni<0||ni>=t.history.length)return;t.historyIndex=ni;navigate(t,t.history[ni],false);}

function resetRequest(t:BrowserTab):void{
  if(!t.isResourceRequest)cancelPageResources(t);
  if(t.socketId>=0){host_tcp_close(t.socketId);t.socketId=-1;}tlsRemove(t.id);t.response.clear();t.body=new Uint8Array(0);t.elements=new Array<PageElement>();t.error="";t.statusCode=0;t.contentType="";t.contentLength=-1;t.chunked=false;t.headerEnd=-1;t.bytesReceived=0;t.bytesSent=0;t.firstByteAt=0;t.completedAt=0;t.requestHeaders="";t.responseHeaders="";t.scrollY=0;t.maxScroll=0;
}

function navigate(t:BrowserTab,input:string,addHist:bool=true):void{
  let explicitScheme=lower(trim(input)).startsWith("http://")||lower(trim(input)).startsWith("https://");
  let u=t.isResourceRequest?parseUrl(input,t.url):navigationUrl(input,t.url);if(!u.valid){t.state=PAGE_ERROR;t.error="Invalid URL or search query";needsRender=true;return;}
  resetRequest(t);if(!t.isResourceRequest){t.requestMethod="GET";t.requestExtraHeaders="";t.requestBody=new Uint8Array(0);t.requestMode="navigate";t.requestCredentials="include";t.requestOrigin="";t.requestDestination="document";t.navigationInput=input;t.autoHttps=!explicitScheme&&u.secure;t.httpFallbackTried=false;}
  t.url=u.raw;t.displayUrl=u.raw;t.title=u.host;t.requestStarted=now_ms();if(addHist&&!t.isResourceRequest)pushHistory(t,u.raw);if(!t.isResourceRequest)addressDraft=u.raw;
  transportMask=host_net_transport_capabilities();
  if((transportMask&1)==0){t.state=PAGE_ERROR;t.error="RAW TCP unavailable. Install/run WASM OS as an IWA with Direct Sockets or attach the native socket bridge.";needsRender=true;return;}
  t.socketId=tcpConnectString(u.host,u.port,3);if(t.socketId<0){t.state=PAGE_ERROR;t.error="Raw TCP connect rejected: "+t.socketId.toString();needsRender=true;return;}
  if(u.secure){let caps=host_crypto_capabilities();if((caps&31)!=31){host_tcp_close(t.socketId);t.socketId=-1;t.state=PAGE_TLS_REQUIRED;t.error="The host lacks one or more protocol-neutral primitives required by the in-WASM TLS 1.3 engine.";needsRender=true;return;}let c=new TlsConnection();c.tabId=t.id;c.host=u.host;c.port=u.port;c.poolOwnerId=t.isResourceRequest?t.resourceOwnerTabId:t.id;c.forceHttp1=t.isWebSocketRequest;c.phase=TLS_PHASE_KEYGEN;c.opKind=TLS_OP_KEYGEN;c.opId=host_crypto_p256_generate();if(c.opId<0){host_tcp_close(t.socketId);t.socketId=-1;t.state=PAGE_ERROR;t.error="P-256 key generation was rejected";return;}tlsConnections.push(c);t.state=PAGE_TLS_HANDSHAKE;if(!t.isResourceRequest)statusMessage="Connecting securely to "+u.host+" · TLS 1.3 packet-owned handshake";}else{t.state=PAGE_CONNECTING;if(!t.isResourceRequest)statusMessage="Connecting directly to "+u.host+":"+u.port.toString();}needsRender=true;
}

function tryHttpFallback(t:BrowserTab,reason:string):bool{
  if(t.isResourceRequest||!t.autoHttps||t.httpFallbackTried)return false;let u=parseUrl(t.url);if(!u.valid||!u.secure)return false;
  t.httpFallbackTried=true;let target="http://"+authorityHost(u.host)+(u.port!=443&&u.port!=80?":"+u.port.toString():"")+u.path;
  statusMessage="HTTPS transport unavailable · retrying HTTP for "+u.host;devConsole(t,"HTTPS transport fallback to HTTP: "+reason,1);
  let keepAuto=t.autoHttps,original=t.navigationInput;navigate(t,target,false);t.autoHttps=keepAuto;t.httpFallbackTried=true;t.navigationInput=original;if(t.historyIndex>=0&&t.historyIndex<t.history.length)t.history[t.historyIndex]=t.url;return true;
}

function tcpConnectString(host:string,port:i32,flags:i32):i32{let b=String.UTF8.encode(host);let id=host_tcp_connect(changetype<usize>(b),b.byteLength,port,flags);if(id>=0)host_tcp_set_receive_limit(id,4*1024*1024);return id;}
function refreshTransportInfo():void{let n=host_net_transport_info_size();if(n<=0||n>8192){transportInfo="";return;}let b=new Uint8Array(n);let r=host_net_transport_info_read(b.dataStart,n);transportInfo=r>0?String.UTF8.decode(b.buffer):"";}

function beginTcp(t:BrowserTab,u:BrowserUrl):void{
  t.socketId=tcpConnectString(u.host,u.port,3);
}

function safeHttp1ExtraHeaders(raw:string):string{let out="",lines=raw.split("\n");for(let i:i32=0;i<lines.length&&i<64;i++){let line=trim(lines[i]),p=line.indexOf(":");if(p<=0)continue;let name=lower(trim(line.substring(0,p))),value=trim(line.substring(p+1));if(name.length==0||value.length>8192||forbiddenRequestHeader(name)||value.includes("\r")||value.includes("\n"))continue;out+=name+": "+value+"\r\n";}return out;}
function buildRequest(u:BrowserUrl,kind:i32=0,t:BrowserTab|null=null):string{
  let method=t!=null&&t.requestMethod.length?t.requestMethod.toUpperCase():"GET",ck=t==null||requestSendsCookies(t,u)?cookieHeader(u):"";let req=method+" "+u.path+" HTTP/1.1\r\n";
  req+="Host: "+u.host+(((u.secure&&u.port!=443)||(!u.secure&&u.port!=80))?":"+u.port.toString():"")+"\r\n";
  req+="User-Agent: WASM-OS-Browser/5.1 PacketOwned-TLS13\r\n";
  req+="Accept: "+resourceAccept(kind)+"\r\n";
  req+="Accept-Language: en-US,en;q=0.9,he;q=0.8\r\n";
  req+="Accept-Encoding: identity\r\n";
  req+="Cache-Control: no-cache\r\n";
  if(t!=null&&t.requestOrigin.length)req+="Origin: "+t.requestOrigin+"\r\n";
  if(t!=null&&t.requestBody.length>0)req+="Content-Length: "+t.requestBody.length.toString()+"\r\n";
  if(t!=null)req+=safeHttp1ExtraHeaders(t.requestExtraHeaders);
  req+="Connection: close\r\n";
  if(ck.length)req+="Cookie: "+ck+"\r\n";
  req+="\r\n";return req;
}

function buildWebSocketRequest(t:BrowserTab):string{let u=parseUrl(t.url),w=webSocketByNetworkTab(t.id);if(w==null)return"";let authority=authorityHost(u.host)+(((u.secure&&u.port!=443)||(!u.secure&&u.port!=80))?":"+u.port.toString():"");let req="GET "+u.path+" HTTP/1.1\r\nHost: "+authority+"\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: "+w.key+"\r\nSec-WebSocket-Version: 13\r\nOrigin: "+urlOrigin(parseUrl(tabById(w.ownerTabId)!=null?tabById(w.ownerTabId)!.url:t.url))+"\r\nUser-Agent: WASM-OS-Browser/6.0 PacketOwned-TLS13\r\n";if(w.protocols.length&&!w.protocols.includes("\r")&&!w.protocols.includes("\n"))req+="Sec-WebSocket-Protocol: "+w.protocols+"\r\n";return req+="\r\n";}
function webSocketFrame(opcode:i32,payload:Uint8Array):Uint8Array{let header:i32=payload.length<126?2:(payload.length<=65535?4:10),out=new Uint8Array(header+4+payload.length),p:i32=0;out[p++]=<u8>(0x80|(opcode&15));if(payload.length<126)out[p++]=<u8>(0x80|payload.length);else if(payload.length<=65535){out[p++]=0xfe;out[p++]=<u8>(payload.length>>8);out[p++]=<u8>payload.length;}else{out[p++]=0xff;for(let i:i32=0;i<4;i++)out[p++]=0;out[p++]=<u8>(payload.length>>24);out[p++]=<u8>(payload.length>>16);out[p++]=<u8>(payload.length>>8);out[p++]=<u8>payload.length;}let mask=new Uint8Array(4);if(host_crypto_random(mask.dataStart,4)!=4)return new Uint8Array(0);for(let i:i32=0;i<4;i++)out[p++]=mask[i];for(let i:i32=0;i<payload.length;i++)out[p+i]=payload[i]^mask[i&3];return out;}
function webSocketWrite(w:WebSocketChannel,opcode:i32,payload:Uint8Array):bool{if(w.state!=1&&opcode!=8)return false;if(payload.length>16*1024*1024)return false;let frame=webSocketFrame(opcode,payload);if(frame.length==0)return false;let t=tabById(w.networkTabId);if(t==null||t.socketId<0)return false;let c=tlsFind(t.id);if(c!=null){tlsQueueApp(c,frame);tlsPumpOutbound(t,c);return true;}return host_tcp_send(t.socketId,frame.dataStart,frame.length)==frame.length;}
function webSocketProtocolAllowed(requested:string,selected:string):bool{if(selected.length==0)return true;let parts=requested.split(",");for(let i:i32=0;i<parts.length;i++)if(trim(parts[i])==selected)return true;return false;}
function webSocketConsume(t:BrowserTab,bytes:Uint8Array):void{let w=webSocketByNetworkTab(t.id);if(w==null)return;if(w.state==0){if(!t.response.append(bytes,bytes.length)){webSocketRemove(w,1009,"handshake exceeds limit");return;}let end=findHeaderEnd(t.response.data,t.response.length);if(end<0)return;let headers=t.response.text(0,end),accept=headerValue(headers,"sec-websocket-accept"),expected=base64Encode(sha1(utf8Bytes(w.key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))),selected=trim(headerValue(headers,"sec-websocket-protocol"));if(parseStatus(headers)!=101||!headerTokenContains(headerValue(headers,"upgrade"),"websocket")||!headerTokenContains(headerValue(headers,"connection"),"upgrade")||accept!=expected||!webSocketProtocolAllowed(w.protocols,selected)){webSocketDispatch(w,"websocket-error");webSocketRemove(w,1006,"invalid RFC 6455 handshake");return;}w.protocol=selected;w.state=1;t.state=PAGE_RECEIVING;webSocketDispatch(w,"websocket-open",new Uint8Array(0),",\"protocol\":\""+jsonEscapeText(selected)+"\"");let rest=t.response.slice(end,t.response.length);t.response.clear();if(rest.length)webSocketConsume(t,rest);return;}if(!w.incoming.append(bytes,bytes.length)){webSocketRemove(w,1009,"frame buffer limit");return;}while(w.incoming.length>=2){let b=w.incoming.data,fin=(b[0]&0x80)!=0,opcode=<i32>(b[0]&15),masked=(b[1]&0x80)!=0,len:i32=<i32>(b[1]&127),p:i32=2;if(masked){webSocketRemove(w,1002,"masked server frame");return;}if(len==126){if(w.incoming.length<4)return;len=be16(b,2);p=4;}else if(len==127){if(w.incoming.length<10)return;if(be32(b,2)!=0){webSocketRemove(w,1009,"frame too large");return;}let n:u32=be32(b,6);if(n>16*1024*1024){webSocketRemove(w,1009,"frame too large");return;}len=<i32>n;p=10;}if((opcode&8)!=0&&(!fin||len>125)){webSocketRemove(w,1002,"invalid control frame");return;}if(w.incoming.length<p+len)return;let payload=w.incoming.slice(p,p+len),rest=w.incoming.slice(p+len,w.incoming.length);w.incoming.data=rest;w.incoming.length=rest.length;if(opcode==8){let code=len>=2?be16(payload,0):1000,reason=len>2?String.UTF8.decode(bytesSlice(payload,2,payload.length).buffer):"";if(w.state==1)webSocketWrite(w,8,payload);webSocketRemove(w,code,reason,true);return;}if(opcode==9){webSocketWrite(w,10,payload);continue;}if(opcode==10)continue;if(opcode==0){if(w.fragmentOpcode==0||!w.fragment.append(payload,payload.length)){webSocketRemove(w,1002,"invalid continuation");return;}if(fin){let complete=w.fragment.slice(0,w.fragment.length),binary=w.fragmentOpcode==2;w.fragment.clear();w.fragmentOpcode=0;webSocketDispatch(w,"websocket-message",complete,",\"binary\":"+(binary?"1":"0"));}continue;}if(opcode!=1&&opcode!=2){webSocketRemove(w,1002,"unsupported opcode");return;}if(fin)webSocketDispatch(w,"websocket-message",payload,",\"binary\":"+(opcode==2?"1":"0"));else{w.fragment.clear();if(!w.fragment.append(payload,payload.length)){webSocketRemove(w,1009,"fragment buffer limit");return;}w.fragmentOpcode=opcode;}}}
function openRendererWebSocket(owner:BrowserTab,rendererId:i32,socketId:i32,rawUrl:string,protocols:string,serviceRequestId:i32=0):void{let normalized=rawUrl;if(lower(normalized).startsWith("wss://"))normalized="https://"+normalized.substring(6);else if(lower(normalized).startsWith("ws://"))normalized="http://"+normalized.substring(5);else{let resolved=resolveRelative(owner.url,normalized);normalized=resolved.raw;}let u=parseUrl(normalized);if(!u.valid||(parseUrl(owner.url).secure&&!u.secure)){let dummy=new WebSocketChannel();dummy.rendererId=rendererId;dummy.rendererSocketId=socketId;dummy.serviceRequestId=serviceRequestId;webSocketDispatch(dummy,"websocket-error");webSocketDispatch(dummy,"websocket-close",new Uint8Array(0),",\"code\":1006,\"reason\":\"invalid or mixed-content WebSocket URL\",\"clean\":false");return;}let random=new Uint8Array(16);if(host_crypto_random(random.dataStart,16)!=16){if(serviceRequestId>0)OsService.respondJson(serviceRequestId,503,"{\"ok\":false,\"error\":\"CSPRNG unavailable\"}");return;}let w=new WebSocketChannel();w.rendererSocketId=socketId;w.rendererId=rendererId;w.ownerTabId=owner.id;w.serviceRequestId=serviceRequestId;w.key=base64Encode(random);w.protocols=protocols;let req=new BrowserTab();req.id=nextResourceRequestId++;req.isResourceRequest=true;req.isWebSocketRequest=true;req.webSocketId=socketId;req.resourceOwnerTabId=owner.id;req.title="WebSocket";w.networkTabId=req.id;webSocketChannels.push(w);resourceRequests.push(req);navigate(req,u.raw,false);if(req.state==PAGE_ERROR||req.state==PAGE_TLS_REQUIRED){webSocketDispatch(w,"websocket-error");webSocketRemove(w,1006,req.error);}}

function sendHttpRequest(t:BrowserTab):void{
  let u=parseUrl(t.url);if(!u.valid)return;let req=t.isWebSocketRequest?buildWebSocketRequest(t):buildRequest(u,t.isResourceRequest?t.resourceKind:0,t),head=utf8Bytes(req),wire=t.requestBody.length?bytesCat(head,t.requestBody):head;let n=host_tcp_send(t.socketId,wire.dataStart,wire.length);if(n<0){t.state=PAGE_ERROR;t.error="TCP send failed";return;}t.bytesSent+=n;t.requestHeaders=req;t.state=PAGE_RECEIVING;if(!t.isResourceRequest)statusMessage="Request sent; waiting for raw response bytes";
}

function findHeaderEnd(b:Uint8Array,n:i32):i32{for(let i=3;i<n;i++)if(b[i-3]==13&&b[i-2]==10&&b[i-1]==13&&b[i]==10)return i+1;return-1;}
function headerValue(headers:string,name:string):string{
  let lines=headers.split("\r\n");let nl=lower(name)+":";for(let i=1;i<lines.length;i++){let l=lines[i];if(lower(l).startsWith(nl))return trim(l.substring(l.indexOf(":")+1));}return"";
}
function parseStatus(headers:string):i32{let e=headers.indexOf("\r\n");let l=e>=0?headers.substring(0,e):headers;let p=l.split(" ");return p.length>=2?I32.parseInt(p[1]):0;}
function parseHeaders(t:BrowserTab):void{
  if(t.headerEnd<0)return;let h=t.response.text(0,t.headerEnd);t.responseHeaders=h;t.statusCode=parseStatus(h);t.contentType=lower(headerValue(h,"content-type"));let cl=headerValue(h,"content-length");if(cl.length)t.contentLength=I32.parseInt(cl);t.chunked=lower(headerValue(h,"transfer-encoding")).includes("chunked");
  let lines=h.split("\r\n");let u=parseUrl(t.url);if(requestSendsCookies(t,u))for(let i=1;i<lines.length;i++)if(lower(lines[i]).startsWith("set-cookie:"))setCookie(u.host,u.path,trim(lines[i].substring(lines[i].indexOf(":")+1)));
}
function parseHex(s:string):i32{let v:i32=0;for(let i=0;i<s.length;i++){let c=s.charCodeAt(i);if(c==59)break;let d:i32=-1;if(c>=48&&c<=57)d=c-48;else if(c>=65&&c<=70)d=c-55;else if(c>=97&&c<=102)d=c-87;else if(c==32||c==9)continue;else return-1;v=(v<<4)|d;}return v;}
function decodeChunked(src:Uint8Array):Uint8Array{
  let out=new ByteAccumulator();let p:i32=0;
  while(p<src.length){let lineEnd:i32=-1;for(let i=p+1;i<src.length;i++)if(src[i-1]==13&&src[i]==10){lineEnd=i-1;break;}if(lineEnd<0)break;let lb=new Uint8Array(lineEnd-p);if(lb.length)memory.copy(lb.dataStart,src.dataStart+p,<usize>lb.length);let len=parseHex(String.UTF8.decode(lb.buffer));if(len<=0)break;p=lineEnd+2;if(p+len>src.length)break;let chunk=new Uint8Array(len);if(len)memory.copy(chunk.dataStart,src.dataStart+p,<usize>len);out.append(chunk,len);p+=len;if(p+1<src.length&&src[p]==13&&src[p+1]==10)p+=2;}
  return out.slice(0,out.length);
}

function finalizeResponse(t:BrowserTab):void{
  if(t.headerEnd<0){t.state=PAGE_ERROR;t.error="Connection closed before HTTP headers completed";return;}
  parseHeaders(t);let raw=t.response.slice(t.headerEnd,t.response.length);t.body=t.chunked?decodeChunked(raw):raw;t.completedAt=now_ms();
  finalizeDecodedResponse(t);
}
function finalizeDecodedResponse(t:BrowserTab):void{
  t.completedAt=now_ms();
  let loc=headerValue(t.responseHeaders,"location");if(t.statusCode>=300&&t.statusCode<400&&loc.length&&t.redirects<MAX_REDIRECTS){t.redirects++;let r=resolveRelative(t.url,loc);if(r.valid){if(t.statusCode==303||((t.statusCode==301||t.statusCode==302)&&t.requestMethod=="POST")){t.requestMethod="GET";t.requestBody=new Uint8Array(0);t.requestExtraHeaders="";}navigate(t,r.raw,false);return;}}
  if(t.isServiceRequest){finishHttpServiceRequest(t);return;}
  if(t.isResourceRequest){finalizeResourceRequest(t);return;}
  t.state=PAGE_PARSING;
  if(t.contentType.includes("text/html")||t.contentType.length==0){parseHtmlDocument(t,String.UTF8.decode(t.body.buffer));t.state=PAGE_READY;}
  else if(t.contentType.includes("text/plain")||t.contentType.includes("application/json")||t.contentType.includes("xml")){parsePlainDocument(t,String.UTF8.decode(t.body.buffer));t.state=PAGE_READY;}
  else{downloadResponse(t);t.elements=new Array<PageElement>();let e=new PageElement();e.kind=E_H2;e.text="Downloaded "+t.body.length.toString()+" bytes ("+t.contentType+")";t.elements.push(e);t.state=PAGE_READY;}
  statusMessage="HTTP "+t.statusCode.toString()+" · "+t.bytesReceived.toString()+" bytes · "+formatMs(t.completedAt-t.requestStarted);needsRender=true;
}

function resourceById(owner:BrowserTab,id:i32):BrowserResource|null{for(let i=0;i<owner.resources.length;i++)if(owner.resources[i].id==id)return owner.resources[i];return null;}
function resourceKindName(kind:i32):string{return kind==RESOURCE_CSS?"stylesheet":(kind==RESOURCE_SCRIPT?"script":(kind==RESOURCE_IMAGE?"image":(kind==RESOURCE_FONT?"font":"resource")));}
function queuePageResource(owner:BrowserTab,rawUrl:string,kind:i32):i32{
  rawUrl=trim(rawUrl);if(!rawUrl.length||rawUrl.startsWith("data:")||rawUrl.startsWith("blob:")||rawUrl.startsWith("javascript:"))return-1;
  let resolved=resolveRelative(owner.url,rawUrl);if(!resolved.valid)return-2;let page=parseUrl(owner.url),target=parseUrl(resolved.raw);
  if(page.secure&&!target.secure){devConsole(owner,"Blocked mixed-content "+resourceKindName(kind)+": "+resolved.raw,2);owner.resourcesFailed++;return-3;}
  for(let i=0;i<owner.resources.length;i++)if(owner.resources[i].url==resolved.raw)return owner.resources[i].id;
  if(owner.resources.length>=RESOURCE_MAX_PER_PAGE){devConsole(owner,"Resource limit reached; skipped "+resolved.raw,1);return-4;}
  let r=new BrowserResource();r.id=owner.resources.length+1;r.ownerTabId=owner.id;r.kind=kind;r.url=resolved.raw;r.cacheKey="GET "+resolved.raw;owner.resources.push(r);return r.id;
}
function corsUnsafeHeaderNames(raw:string):string{let out="",lines=raw.split("\n");for(let i:i32=0;i<lines.length;i++){let line=trim(lines[i]),p=line.indexOf(":");if(p<=0)continue;let n=lower(trim(line.substring(0,p))),v=lower(trim(line.substring(p+1))),safe=n=="accept"||n=="accept-language"||n=="content-language"||(n=="content-type"&&(v.startsWith("application/x-www-form-urlencoded")||v.startsWith("multipart/form-data")||v.startsWith("text/plain")));if(!safe&&!forbiddenRequestHeader(n)){if(out.length)out+=", ";out+=n;}}return out;}
function corsNeedsPreflight(method:string,headers:string):bool{let m=method.toUpperCase();return (m!="GET"&&m!="HEAD"&&m!="POST")||corsUnsafeHeaderNames(headers).length>0;}
function headerTokenContains(raw:string,needle:string):bool{let parts=lower(raw).split(","),n=lower(trim(needle));for(let i:i32=0;i<parts.length;i++)if(trim(parts[i])==n||trim(parts[i])=="*")return true;return false;}
function queueDynamicResource(owner:BrowserTab,rawUrl:string,requestId:i32,method:string,headers:string,body:Uint8Array,mode:string,credentials:string,destination:string):i32{
  let resolved=resolveRelative(owner.url,rawUrl);if(!resolved.valid||owner.resources.length>=RESOURCE_MAX_PER_PAGE)return-1;let page=parseUrl(owner.url),target=parseUrl(resolved.raw);if(page.secure&&!target.secure)return-2;
  let cross=!sameOrigin(page,target),origin=urlOrigin(page);if(mode=="same-origin"&&cross)return-3;let r=new BrowserResource();r.id=owner.resources.length+1;r.ownerTabId=owner.id;r.kind=RESOURCE_OTHER;r.url=resolved.raw;r.requestMethod=method.toUpperCase();r.requestMode=mode.length?mode:"cors";r.requestCredentials=credentials.length?credentials:"same-origin";r.requestOrigin=cross&&r.requestMode!="no-cors"?origin:"";r.requestDestination=destination.length?destination:"fetch";r.corsRequired=cross&&r.requestDestination!="resource"&&r.requestMode!="no-cors";r.requestHeaders=headers;r.requestBody=body;r.cacheKey=r.requestMethod+" "+resolved.raw+" #"+requestId.toString();r.fetchIds.push(requestId);owner.resources.push(r);if(r.corsRequired&&corsNeedsPreflight(r.requestMethod,headers)){r.state=RESOURCE_WAITING;let p=new BrowserResource();p.id=owner.resources.length+1;p.ownerTabId=owner.id;p.kind=RESOURCE_OTHER;p.url=r.url;p.requestMethod="OPTIONS";p.requestMode="cors";p.requestCredentials="omit";p.requestOrigin=origin;p.requestDestination="preflight";p.preflightForId=r.id;p.preflightHeaderNames=corsUnsafeHeaderNames(headers);p.requestHeaders="access-control-request-method: "+r.requestMethod+"\n"+(p.preflightHeaderNames.length?"access-control-request-headers: "+p.preflightHeaderNames+"\n":"");p.cacheKey="PREFLIGHT "+r.requestMethod+" "+r.url;owner.resources.push(p);}return r.id;
}
function cancelPageResources(owner:BrowserTab):void{
  for(let i=resourceRequests.length-1;i>=0;i--){let req=resourceRequests[i];if(req.resourceOwnerTabId==owner.id){h2DetachTab(req.id);if(req.socketId>=0)host_tcp_close(req.socketId);tlsRemove(req.id);resourceRequests.splice(i,1);}}
  if(owner.jsRealmId>=0){host_js_realm_destroy(owner.jsRealmId);owner.jsRealmId=-1;}if(owner.rendererId>=0){host_web_renderer_destroy(owner.rendererId);owner.rendererId=-1;owner.rendererCommitted=false;}for(let i=0;i<owner.resources.length;i++)if(owner.resources[i].imageHandle>=0)host_image_release(owner.resources[i].imageHandle);owner.resources.length=0;owner.cssRules.length=0;owner.resourceBytes=0;owner.resourcesReady=0;owner.resourcesFailed=0;
}
function resourceRequestActive(req:BrowserTab):bool{return req.state==PAGE_CONNECTING||req.state==PAGE_TLS_HANDSHAKE||req.state==PAGE_RECEIVING;}
function activeResourceCount(ownerId:i32):i32{let n=0;for(let i=0;i<resourceRequests.length;i++)if(resourceRequests[i].resourceOwnerTabId==ownerId&&resourceRequestActive(resourceRequests[i]))n++;return n;}
function activeResourceOrigin(ownerId:i32,url:string):i32{let target=parseUrl(url),n:i32=0;if(!target.valid)return 0;for(let i=0;i<resourceRequests.length;i++){let req=resourceRequests[i];if(req.resourceOwnerTabId!=ownerId||!resourceRequestActive(req))continue;let u=parseUrl(req.url);if(u.valid&&u.host==target.host&&u.port==target.port&&u.secure==target.secure)n++;}return n;}
function pumpResourceScheduler(owner:BrowserTab):void{
  let active=activeResourceCount(owner.id);
  for(let i=0;i<owner.resources.length&&active<RESOURCE_MAX_PARALLEL;i++){let r=owner.resources[i];if(r.state!=RESOURCE_QUEUED)continue;let u=parseUrl(r.url),pool=u.valid&&u.secure?h2PoolFor(owner.id,u):null,originLimit:i32=(u.valid&&u.secure&&!trustCacheHostReady(u.host)&&pool==null)?1:RESOURCE_MAX_PARALLEL;if(activeResourceOrigin(owner.id,r.url)>=originLimit)continue;let req=new BrowserTab();req.id=nextResourceRequestId++;req.isResourceRequest=true;req.resourceId=r.id;req.resourceOwnerTabId=owner.id;req.resourceKind=r.kind;req.requestMethod=r.requestMethod;req.requestExtraHeaders=r.requestHeaders;req.requestBody=r.requestBody;req.requestMode=r.requestMode;req.requestCredentials=r.requestCredentials;req.requestOrigin=r.requestOrigin;req.requestDestination=r.requestDestination;req.title=resourceKindName(r.kind);req.url=r.url;req.displayUrl=r.url;req.requestStarted=now_ms();r.requestTabId=req.id;r.state=RESOURCE_LOADING;r.startedAt=now_ms();resourceRequests.push(req);if(pool!=null&&h2AttachRequest(pool,req))devConsole(owner,"HTTP/2 stream multiplexed on shared "+u.host+" connection",0);else navigate(req,r.url,false);if(req.state==PAGE_ERROR||req.state==PAGE_TLS_REQUIRED){r.state=RESOURCE_FAILED;r.error=req.error;r.completedAt=now_ms();owner.resourcesFailed++;resourceRequests.pop();}else active++;}
}
function removeResourceRequest(req:BrowserTab):void{let c=tlsFind(req.id);if(req.h2PoolCarrier&&c!=null&&c.protocol=="h2"&&!c.h2Goaway&&req.socketId>=0){req.state=PAGE_READY;return;}if(req.socketId>=0){host_tcp_close(req.socketId);req.socketId=-1;}tlsRemove(req.id);for(let i=resourceRequests.length-1;i>=0;i--)if(resourceRequests[i].id==req.id){resourceRequests.splice(i,1);break;}}
function failResourceRequest(req:BrowserTab):void{if(req.isServiceRequest&&req.serviceRequestId>0){OsService.respondJson(req.serviceRequestId,502,"{\"ok\":false,\"error\":\""+jsonEscapeText(req.error.length?req.error:"network request failed")+"\"}");removeResourceRequest(req);return;}let owner=tabById(req.resourceOwnerTabId);if(owner!=null&&!owner.isResourceRequest){let r=resourceById(owner,req.resourceId);if(r!=null&&r.state==RESOURCE_LOADING){rendererFetchRespond(owner,r,0,new Uint8Array(0));r.state=RESOURCE_FAILED;r.error=req.error.length?req.error:"resource transport failed";r.completedAt=now_ms();owner.resourcesFailed++;devConsole(owner,"Failed "+resourceKindName(r.kind)+": "+r.url+" · "+r.error,2);}}removeResourceRequest(req);needsRender=true;}
function scanCssResourceUrls(owner:BrowserTab,css:string,baseUrl:string):void{let p=0,lc=lower(css);while(p<css.length){let a=lc.indexOf("url(",p);if(a<0)break;let e=css.indexOf(")",a+4);if(e<0)break;let raw=trim(css.substring(a+4,e)).replace("\"","").replace("'","");let kind=lower(raw).includes(".woff")||lower(raw).includes(".ttf")||lower(raw).includes(".otf")?RESOURCE_FONT:RESOURCE_IMAGE;let absolute=resolveRelative(baseUrl,raw);if(absolute.valid)queuePageResource(owner,absolute.raw,kind);p=e+1;}p=0;while(p<css.length){let a=lc.indexOf("@import",p);if(a<0)break;let q=a+7;while(q<css.length&&css.charCodeAt(q)<=32)q++;if(lc.substring(q,minI(css.length,q+4))=="url(")q+=4;while(q<css.length&&(css.charCodeAt(q)<=32||css.charAt(q)=="\""||css.charAt(q)=="'"))q++;let e=q;while(e<css.length&&css.charAt(e)!="\""&&css.charAt(e)!="'"&&css.charAt(e)!=")"&&css.charCodeAt(e)>32)e++;let raw=css.substring(q,e),u=resolveRelative(baseUrl,raw);if(u.valid)queuePageResource(owner,u.raw,RESOURCE_CSS);p=e+1;}}
function queueSrcSet(owner:BrowserTab,value:string):void{let items=value.split(",");for(let i=0;i<items.length;i++){let raw=trim(items[i]).split(" ")[0];if(raw.length)queuePageResource(owner,raw,RESOURCE_IMAGE);}}
function scanModuleImports(owner:BrowserTab,code:string,baseUrl:string):void{let patterns:string[]=[" from ","import(","import "];for(let pi=0;pi<patterns.length;pi++){let p:i32=0;while(p<code.length){let at=code.indexOf(patterns[pi],p);if(at<0)break;let q:i32=at+patterns[pi].length;while(q<code.length&&(code.charCodeAt(q)<=32||code.charAt(q)=="("))q++;if(q>=code.length||(code.charAt(q)!="\""&&code.charAt(q)!="'")){p=q+1;continue;}let quote=code.charAt(q),e=code.indexOf(quote,q+1);if(e<0)break;let raw=code.substring(q+1,e);if(raw.startsWith("./")||raw.startsWith("../")||raw.startsWith("/")||raw.startsWith("http://")||raw.startsWith("https://")){let u=resolveRelative(baseUrl,raw);if(u.valid)queuePageResource(owner,u.raw,RESOURCE_SCRIPT);}p=e+1;}}}
function rendererMime(r:BrowserResource):string{if(r.contentType.length)return r.contentType;if(r.kind==RESOURCE_CSS)return"text/css";if(r.kind==RESOURCE_SCRIPT)return"text/javascript";if(r.kind==RESOURCE_FONT)return"font/woff2";if(r.kind==RESOURCE_IMAGE)return lower(r.url).includes(".svg")?"image/svg+xml":"image/png";return"application/octet-stream";}
function rendererPut(owner:BrowserTab,r:BrowserResource):void{if(owner.rendererId<0)return;let ub=String.UTF8.encode(r.url),mime=rendererMime(r),mb=String.UTF8.encode(mime);let ok=host_web_renderer_resource(owner.rendererId,changetype<usize>(ub),ub.byteLength,changetype<usize>(mb),mb.byteLength,r.body.dataStart,r.body.length,r.kind);if(ok<0)devConsole(owner,"Native renderer rejected resource: "+r.url,1);}
function rendererFetchRespond(owner:BrowserTab,r:BrowserResource,status:i32,body:Uint8Array):void{if(owner.rendererId<0||r.fetchIds.length==0)return;let mime=rendererMime(r),mb=String.UTF8.encode(mime);for(let i=0;i<r.fetchIds.length;i++)host_web_renderer_fetch_respond(owner.rendererId,r.fetchIds[i],status,changetype<usize>(mb),mb.byteLength,body.dataStart,body.length);r.fetchIds.length=0;}
function rendererQueueFetch(owner:BrowserTab,url:string,requestId:i32,method:string="GET",headers:string="",body:Uint8Array=new Uint8Array(0),mode:string="cors",credentials:string="same-origin",destination:string="fetch"):void{let resolved=resolveRelative(owner.url,url),m=method.toUpperCase();if(!resolved.valid||m.length==0){let empty=new Uint8Array(0),dummy=new BrowserResource();dummy.fetchIds.push(requestId);rendererFetchRespond(owner,dummy,0,empty);return;}if((m=="GET"||m=="HEAD")&&headers.length==0&&body.length==0&&destination=="resource")for(let i=0;i<owner.resources.length;i++)if(owner.resources[i].url==resolved.raw&&owner.resources[i].requestMethod=="GET"){let r=owner.resources[i];if(r.state==RESOURCE_READY){r.fetchIds.push(requestId);rendererFetchRespond(owner,r,r.statusCode>0?r.statusCode:200,m=="HEAD"?new Uint8Array(0):r.body);}else if(r.state==RESOURCE_FAILED){r.fetchIds.push(requestId);rendererFetchRespond(owner,r,0,new Uint8Array(0));}else r.fetchIds.push(requestId);return;}let id=queueDynamicResource(owner,resolved.raw,requestId,m,headers,body,mode,credentials,destination);if(id>=0)pumpResourceScheduler(owner);else{let dummy=new BrowserResource();dummy.fetchIds.push(requestId);rendererFetchRespond(owner,dummy,0,new Uint8Array(0));devConsole(owner,id==-3?"Blocked cross-origin request in same-origin mode":"Blocked invalid renderer request",1);}}
function rendererMaybeCommit(owner:BrowserTab):void{if(owner.rendererId<0||owner.rendererCommitted)return;let waitingCritical=false;for(let i=0;i<owner.resources.length;i++){let r=owner.resources[i];if((r.kind==RESOURCE_CSS||r.kind==RESOURCE_SCRIPT)&&(r.state==RESOURCE_QUEUED||r.state==RESOURCE_LOADING)){waitingCritical=true;break;}}if(waitingCritical&&now_ms()-owner.rendererCreatedAt<8000.0)return;let ok=host_web_renderer_commit(owner.rendererId);if(ok>0){owner.rendererCommitted=true;devConsole(owner,"Chromium progressive render committed; remaining assets stay WASM-routed.",0);}else if(ok<0)devConsole(owner,"Chromium renderer commit failed.",2);}
function finalizeResourceRequest(req:BrowserTab):void{
  let owner=tabById(req.resourceOwnerTabId);if(owner==null||owner.isResourceRequest){removeResourceRequest(req);return;}let r=resourceById(owner,req.resourceId);if(r==null){removeResourceRequest(req);return;}
  r.statusCode=req.statusCode;r.contentType=req.contentType;r.completedAt=now_ms();r.bytes=req.body.length;
  if(r.requestDestination=="preflight"){
    let target=resourceById(owner,r.preflightForId);if(target==null){r.state=RESOURCE_FAILED;removeResourceRequest(req);pumpResourceScheduler(owner);return;}
    let allowOrigin=trim(headerValue(req.responseHeaders,"access-control-allow-origin")),originOk=allowOrigin==r.requestOrigin||(allowOrigin=="*"&&target.requestCredentials!="include"),credentialOk=target.requestCredentials!="include"||lower(trim(headerValue(req.responseHeaders,"access-control-allow-credentials")))=="true",methodOk=headerTokenContains(headerValue(req.responseHeaders,"access-control-allow-methods"),target.requestMethod),headersOk=true;
    if(r.preflightHeaderNames.length){let requested=r.preflightHeaderNames.split(","),allowed=headerValue(req.responseHeaders,"access-control-allow-headers");for(let i:i32=0;i<requested.length;i++)if(!headerTokenContains(allowed,trim(requested[i]))){headersOk=false;break;}}
    if(req.statusCode>=200&&req.statusCode<300&&originOk&&credentialOk&&methodOk&&headersOk){r.state=RESOURCE_READY;target.state=RESOURCE_QUEUED;devConsole(owner,"CORS preflight accepted for "+target.requestMethod+" "+target.url,0);}else{r.state=RESOURCE_FAILED;target.state=RESOURCE_FAILED;target.error="CORS preflight rejected";rendererFetchRespond(owner,target,0,new Uint8Array(0));owner.resourcesFailed++;devConsole(owner,"Blocked cross-origin request · preflight rejected for "+target.url,2);}removeResourceRequest(req);pumpResourceScheduler(owner);return;
  }
  if(r.corsRequired){let allow=trim(headerValue(req.responseHeaders,"access-control-allow-origin")),credentialOk=r.requestCredentials!="include"||lower(trim(headerValue(req.responseHeaders,"access-control-allow-credentials")))=="true",ok=(allow==r.requestOrigin||(allow=="*"&&r.requestCredentials!="include"))&&credentialOk;if(!ok){rendererFetchRespond(owner,r,0,new Uint8Array(0));r.state=RESOURCE_FAILED;r.error="CORS origin policy rejected response";owner.resourcesFailed++;devConsole(owner,"Blocked cross-origin response from "+r.url+" · CORS did not authorize "+r.requestOrigin,2);removeResourceRequest(req);pumpResourceScheduler(owner);return;}}
  if(req.statusCode<200||req.statusCode>=300){r.body=req.body;r.contentType=req.contentType;rendererFetchRespond(owner,r,req.statusCode,r.body);r.state=RESOURCE_FAILED;r.error="HTTP "+req.statusCode.toString();owner.resourcesFailed++;devConsole(owner,"Failed "+resourceKindName(r.kind)+": "+r.url+" · "+r.error,2);removeResourceRequest(req);pumpResourceScheduler(owner);return;}
  if(owner.resourceBytes+req.body.length>RESOURCE_CACHE_LIMIT){rendererFetchRespond(owner,r,0,new Uint8Array(0));r.state=RESOURCE_FAILED;r.error="page resource cache limit exceeded";owner.resourcesFailed++;devConsole(owner,"Blocked "+r.url+" · cache limit",2);removeResourceRequest(req);return;}
  r.body=req.body;r.state=RESOURCE_READY;owner.resourceBytes+=r.body.length;owner.resourcesReady++;rendererPut(owner,r);rendererFetchRespond(owner,r,req.statusCode,r.body);
  if(r.kind==RESOURCE_CSS){let css=String.UTF8.decode(r.body.buffer),rules=parseCssStylesheet(css);for(let i=0;i<rules.length;i++){rules[i].order=owner.cssRules.length;owner.cssRules.push(rules[i]);}owner.cssRuleCount=owner.cssRules.length;scanCssResourceUrls(owner,css,r.url);computeDomStyles(owner.rootDom,owner.cssRules,null);layoutDocument(owner);devConsole(owner,"Loaded stylesheet: "+r.url+" ("+rules.length.toString()+" rules)",0);}
  else if(r.kind==RESOURCE_SCRIPT){let js=String.UTF8.decode(r.body.buffer);scanModuleImports(owner,js,r.url);executeBrowserScript(owner,js,owner.rootDom,r.url);}
  else if(r.kind==RESOURCE_IMAGE&&owner.rendererId<0){let mime=r.contentType.length?r.contentType:(lower(r.url).includes(".svg")?"image/svg+xml":"image/png"),mb=String.UTF8.encode(mime);r.imageHandle=host_image_decode(r.body.dataStart,r.body.length,changetype<usize>(mb),mb.byteLength);if(r.imageHandle<0)devConsole(owner,"Image decoder rejected: "+r.url,1);else devConsole(owner,"Decoding image: "+r.url,0);}
  else devConsole(owner,"Loaded "+resourceKindName(r.kind)+": "+r.url+" ("+r.body.length.toString()+" B)",0);
  removeResourceRequest(req);pumpResourceScheduler(owner);rendererMaybeCommit(owner);needsRender=true;
}
function pumpResourceRequests():void{
  for(let i:i32=webSocketChannels.length-1;i>=0;i--){let w=webSocketChannels[i];if(w.state==2&&w.closeStarted>0&&now_ms()-w.closeStarted>5000.0)webSocketRemove(w,1006,"close handshake timeout",false);}
  for(let i=resourceRequests.length-1;i>=0;i--){let req=resourceRequests[i];if(req.state==PAGE_CONNECTING||req.state==PAGE_RECEIVING||req.state==PAGE_TLS_HANDSHAKE)pumpNetwork(req);if(req.state==PAGE_ERROR||req.state==PAGE_TLS_REQUIRED)failResourceRequest(req);}
  for(let i=0;i<tlsConnections.length;i++){let c=tlsConnections[i];if(c.protocol!="h2"||c.phase<TLS_PHASE_ESTABLISHED||c.h2Goaway)continue;let carrier=h2Carrier(c);if(carrier!=null&&carrier.socketId>=0)tlsPump(carrier,c);}
  for(let i=0;i<tabs.length;i++)if(tabs[i].state==PAGE_READY){pumpResourceScheduler(tabs[i]);rendererMaybeCommit(tabs[i]);}
}

function downloadResponse(t:BrowserTab):void{
  let name="download.bin";let cd=headerValue(t.responseHeaders,"content-disposition");let fp=lower(cd).indexOf("filename=");if(fp>=0){name=trim(cd.substring(fp+9)).replace("\"","");}
  let nb=String.UTF8.encode(name),mb=String.UTF8.encode(t.contentType.length?t.contentType:"application/octet-stream");let id=host_download_begin(changetype<usize>(nb),nb.byteLength,changetype<usize>(mb),mb.byteLength);if(id>=0){host_download_write(id,t.body.dataStart,t.body.length);host_download_end(id);}
}

function pumpNetwork(t:BrowserTab):void{
  let secure=tlsFind(t.id);if(secure){tlsPump(t,secure);return;}
  if(t.socketId<0)return;let st=host_tcp_state(t.socketId);
  if(t.state==PAGE_CONNECTING&&st==1){sendHttpRequest(t);needsRender=true;}
  if(st<0){let n=host_tcp_error_size(t.socketId);let msg="TCP transport error";if(n>0&&n<4096){let b=new Uint8Array(n);let r=host_tcp_read_error(t.socketId,b.dataStart,n);if(r>0)msg=String.UTF8.decode(b.buffer);}if(tryHttpFallback(t,msg))return;t.state=PAGE_ERROR;t.error=msg;host_tcp_close(t.socketId);t.socketId=-1;needsRender=true;return;}
  if(t.state==PAGE_RECEIVING){
    let loops:i32=0;while(host_tcp_pending(t.socketId)>0&&loops<32){let n=host_tcp_receive(t.socketId,rxScratch.dataStart,rxScratch.length);if(n<=0)break;if(t.firstByteAt==0)t.firstByteAt=now_ms();t.bytesReceived+=n;if(t.isWebSocketRequest){webSocketConsume(t,bytesSlice(rxScratch,0,n));loops++;continue;}if(!t.response.append(rxScratch,n)){t.state=PAGE_ERROR;t.error="Response exceeded "+MAX_DOC_BYTES.toString()+" bytes";host_tcp_close(t.socketId);t.socketId=-1;return;}if(t.headerEnd<0){t.headerEnd=findHeaderEnd(t.response.data,t.response.length);if(t.headerEnd>=0)parseHeaders(t);}loops++;}
    if(t.headerEnd>=0&&!t.chunked&&t.contentLength>=0&&t.response.length-t.headerEnd>=t.contentLength){host_tcp_close(t.socketId);t.socketId=-1;finalizeResponse(t);return;}
    if(st==3){t.socketId=-1;if(t.isWebSocketRequest){let w=webSocketByNetworkTab(t.id);if(w!=null)webSocketRemove(w,1006,"TCP closed",false);}else finalizeResponse(t);return;}
  }
}

export function tcpEvent(socketId:i32,state:i32,newBytes:i32):void{
  for(let i:i32=0;i<aiaFetches.length;i++)if(aiaFetches[i].socketId==socketId){aiaPump(aiaFetches[i],state);needsRender=true;return;}
  for(let i:i32=0;i<crlFetches.length;i++)if(crlFetches[i].socketId==socketId){crlPump(crlFetches[i],state);needsRender=true;return;}
  for(let i=0;i<tabs.length;i++)if(tabs[i].socketId==socketId){if(state<0){let c=tlsFind(tabs[i].id);if(c){tlsFail(c,"raw TCP transport failure");needsRender=true;break;}}pumpNetwork(tabs[i]);needsRender=true;break;}
  for(let i=0;i<resourceRequests.length;i++)if(resourceRequests[i].socketId==socketId){let req=resourceRequests[i];if(state<0){let c=tlsFind(req.id);if(c)tlsFail(c,"raw TCP resource transport failure");else{req.state=PAGE_ERROR;req.error="Raw TCP resource transport failure";}}pumpNetwork(req);needsRender=true;break;}
}

function jsonIntValue(json:string,key:string):i32{let needle="\""+key+"\"",p=json.indexOf(needle);if(p<0)return 0;p=json.indexOf(":",p+needle.length);if(p<0)return 0;p++;while(p<json.length&&json.charCodeAt(p)<=32)p++;let e=p;while(e<json.length){let c=json.charCodeAt(e);if((c<48||c>57)&&c!=45)break;e++;}return e>p?I32.parseInt(json.substring(p,e)):0;}
function jsStyleProperty(name:string):string{let out="";for(let i=0;i<name.length;i++){let c=name.charCodeAt(i);if(c>=65&&c<=90){out+="-";out+=String.fromCharCode(c+32);}else out+=name.charAt(i);}return out;}
export function jsEvent(realmId:i32,pending:i32):void{
  let owner:BrowserTab|null=null;for(let i=0;i<tabs.length;i++)if(tabs[i].jsRealmId==realmId){owner=tabs[i];break;}if(owner==null)return;
  let loops:i32=0;while(loops++<64){let n=host_js_event_size(realmId);if(n<=0||n>1024*1024)break;let b=new Uint8Array(n),r=host_js_event_read(realmId,b.dataStart,n);if(r<=0)break;let json=String.UTF8.decode(b.buffer),kind=jsonField(json,"type");
    if(kind=="console"){let level=jsonField(json,"level"),message=jsonField(json,"message");devConsole(owner,message,level=="error"?2:(level=="warn"?1:0));}
    else if(kind=="error")devConsole(owner,jsonField(json,"message"),2);
    else if(kind=="complete")devConsole(owner,"Script job #"+jsonIntValue(json,"jobId").toString()+" completed",0);
    else if(kind=="mutation"){let uid=jsonIntValue(json,"uid"),node=findNodeByUid(owner.rootDom,uid),prop=jsonField(json,"property"),value=jsonField(json,"value");if(node==null&&prop=="append"){let parent=findNodeByUid(owner.rootDom,I32.parseInt(value));if(parent!=null){let child=new DomNode(jsonField(json,"tag"));child.uid=uid;child.id=jsonField(json,"id");parent.appendChild(child);owner.domNodeCount++;node=child;}}
      if(node!=null){if(prop=="textContent"||prop=="innerHTML")node.text=value;else if(prop.startsWith("style."))applyCssDeclaration(node.style,jsStyleProperty(prop.substring(6)),value);else if(prop.startsWith("attr.")){let attrName=prop.substring(5);if(attrName=="id")node.id=lower(value);else if(attrName=="href")node.href=value;}layoutDocument(owner);needsRender=true;}
    }
  }
}

export function imageEvent(handle:i32,state:i32,width:i32,height:i32):void{
  for(let ti=0;ti<tabs.length;ti++)for(let ri=0;ri<tabs[ti].resources.length;ri++){let r=tabs[ti].resources[ri];if(r.imageHandle!=handle)continue;if(state>0){r.imageW=width;r.imageH=height;devConsole(tabs[ti],"Decoded image: "+r.url+" ("+width.toString()+"x"+height.toString()+")",0);}else{host_image_release(handle);r.imageHandle=-1;r.error="image decode failed";devConsole(tabs[ti],"Image decode failed: "+r.url,1);}needsRender=true;return;}
}

export function webRendererEvent(rendererId:i32,pending:i32):void{
  let owner:BrowserTab|null=null;for(let i=0;i<tabs.length;i++)if(tabs[i].rendererId==rendererId){owner=tabs[i];break;}if(owner==null)return;
  let loops:i32=0;while(loops++<64){let n=host_web_renderer_event_size(rendererId);if(n<=0||n>1024*1024)break;let b=new Uint8Array(n),read=host_web_renderer_event_read(rendererId,b.dataStart,n);if(read<=0)break;let json=String.UTF8.decode(b.buffer),kind=jsonField(json,"type"),message=jsonField(json,"message"),url=jsonField(json,"url");
    if(kind=="console"){let level=jsonField(json,"level");devConsole(owner,message,level=="error"?2:(level=="warn"?1:0));}
    else if(kind=="error")devConsole(owner,message.length?message:"Native renderer script error",2);
    else if(kind=="network-request"&&url.length){let method=jsonField(json,"method"),headers=jsonField(json,"headers"),mode=jsonField(json,"mode"),credentials=jsonField(json,"credentials"),destination=jsonField(json,"destination"),requestId=jsonIntValue(json,"requestId"),bodySize=host_web_renderer_request_body_size(rendererId,requestId),body=new Uint8Array(0);if(bodySize>0&&bodySize<=4*1024*1024){body=new Uint8Array(bodySize);if(host_web_renderer_request_body_read(rendererId,requestId,body.dataStart,bodySize)!=bodySize)body=new Uint8Array(0);}if(method=="GET"||method=="HEAD"||method=="POST"||method=="PUT"||method=="PATCH"||method=="DELETE"||method=="OPTIONS")rendererQueueFetch(owner,url,requestId,method,headers,body,mode,credentials,destination);else{let dummy=new BrowserResource();dummy.fetchIds.push(requestId);rendererFetchRespond(owner,dummy,0,new Uint8Array(0));devConsole(owner,"Blocked unsupported renderer request method: "+method,1);}}
    else if(kind=="websocket-open"&&url.length){openRendererWebSocket(owner,rendererId,jsonIntValue(json,"socketId"),url,jsonField(json,"protocols"));devConsole(owner,"Opening packet-owned WebSocket: "+url,0);}
    else if(kind=="websocket-send"){let socketId=jsonIntValue(json,"socketId"),requestId=jsonIntValue(json,"requestId"),w=webSocketById(rendererId,socketId),bodySize=host_web_renderer_request_body_size(rendererId,requestId),body=new Uint8Array(0);if(bodySize>=0&&bodySize<=4*1024*1024){body=new Uint8Array(bodySize);if(bodySize>0&&host_web_renderer_request_body_read(rendererId,requestId,body.dataStart,bodySize)!=bodySize)body=new Uint8Array(0);}if(w==null||!webSocketWrite(w,jsonIntValue(json,"binary")!=0?2:1,body)){if(w!=null)webSocketDispatch(w,"websocket-error");devConsole(owner,"WebSocket send failed",2);}}
    else if(kind=="websocket-close"){let w=webSocketById(rendererId,jsonIntValue(json,"socketId"));if(w!=null){let code=jsonIntValue(json,"code"),reason=jsonField(json,"reason"),rb=utf8Bytes(reason),payload=new Uint8Array(2+rb.length);payload[0]=<u8>(code>>8);payload[1]=<u8>code;if(rb.length)memory.copy(payload.dataStart+2,rb.dataStart,<usize>rb.length);if(webSocketWrite(w,8,payload)){w.state=2;w.closeStarted=now_ms();}else webSocketRemove(w,1006,"close write failed",false);}}
    else if(kind=="blocked-network")devConsole(owner,"Blocked renderer network API: "+message+(url.length?" · "+url:""),1);
    else if(kind=="missing-resource")devConsole(owner,"Renderer resource unavailable: "+url,1);
    else if(kind=="service-worker")devConsole(owner,"Service Worker "+message+(url.length?" · "+url:""),0);
    else if(kind=="dom-ready"||kind=="load"||kind=="committed"||kind=="hydrated")devConsole(owner,"Renderer "+kind+(message.length?" · "+message:"")+(url.length?" · "+url:""),0);
    else if(kind=="navigate"&&url.length){let method=jsonField(json,"method");if(method.length&&method!="GET")devConsole(owner,"Form navigation "+method+" is routed as a document request in the next navigation stage.",1);navigate(owner,url,true);needsRender=true;return;}
  }
}

function decodeEntities(s:string):string{
  s=s.replace("&amp;","&").replace("&lt;","<").replace("&gt;",">").replace("&quot;","\"").replace("&#39;", "'").replace("&nbsp;"," ");return s;
}
function attr(tag:string,name:string):string{
  let l=lower(tag),needle=lower(name)+"=";let p=l.indexOf(needle);if(p<0)return"";p+=needle.length;if(p>=tag.length)return"";let q=tag.charAt(p);if(q=='"'||q=="'"){let e=tag.indexOf(q,p+1);return e>=0?tag.substring(p+1,e):tag.substring(p+1);}let e=p;while(e<tag.length){let c=tag.charCodeAt(e);if(c<=32||c==62)break;e++;}return tag.substring(p,e);
}
function pushElement(list:Array<PageElement>,kind:i32,text:string,href:string=""):void{
  text=decodeEntities(text).trim();if(text.length==0&&kind!=E_RULE)return;if(list.length>=MAX_ELEMENTS)return;let e=new PageElement();e.kind=kind;e.text=text.length>4000?text.substring(0,4000):text;e.href=href;list.push(e);
}
function stripBlock(html:string,tag:string):string{
  let l=lower(html),open="<"+tag,close="</"+tag+">";let p=l.indexOf(open);while(p>=0){let e=l.indexOf(close,p);if(e<0)return html.substring(0,p);let n=e+close.length;html=html.substring(0,p)+html.substring(n);l=lower(html);p=l.indexOf(open);}return html;
}
function extractTitle(html:string):string{let l=lower(html),p=l.indexOf("<title");if(p<0)return"";p=html.indexOf(">",p);if(p<0)return"";let e=l.indexOf("</title>",p);return e<0?"":decodeEntities(html.substring(p+1,e).trim());}

function parseCssColor(val: string): u32 {
  let s = trim(lower(val));
  if (s == "white") return rgba(255, 255, 255);
  if (s == "black") return rgba(10, 13, 20);
  if (s == "red") return rgba(220, 53, 69);
  if (s == "green") return rgba(40, 167, 69);
  if (s == "blue") return rgba(0, 123, 255);
  if (s == "cyan") return rgba(0, 243, 255);
  if (s == "gray" || s == "grey") return rgba(128, 128, 128);
  if (s == "yellow") return rgba(255, 193, 7);
  if (s == "orange") return rgba(253, 126, 20);
  if (s == "purple") return rgba(111, 66, 193);
  if (s == "transparent") return 0;

  if (s.startsWith("#")) {
    let hex = s.substring(1);
    if (hex.length == 3) {
      let r = hexNibble(hex.charCodeAt(0)) * 17;
      let g = hexNibble(hex.charCodeAt(1)) * 17;
      let b = hexNibble(hex.charCodeAt(2)) * 17;
      return rgba(<u32>r, <u32>g, <u32>b);
    } else if (hex.length >= 6) {
      let r = (hexNibble(hex.charCodeAt(0)) << 4) | hexNibble(hex.charCodeAt(1));
      let g = (hexNibble(hex.charCodeAt(2)) << 4) | hexNibble(hex.charCodeAt(3));
      let b = (hexNibble(hex.charCodeAt(4)) << 4) | hexNibble(hex.charCodeAt(5));
      return rgba(<u32>r, <u32>g, <u32>b);
    }
  }

  if (s.startsWith("rgb")) {
    let p1 = s.indexOf("("), p2 = s.indexOf(")");
    if (p1 >= 0 && p2 > p1) {
      let parts = s.substring(p1 + 1, p2).split(",");
      if (parts.length >= 3) {
        return rgba(<u32>I32.parseInt(trim(parts[0])), <u32>I32.parseInt(trim(parts[1])), <u32>I32.parseInt(trim(parts[2])));
      }
    }
  }
  return rgba(32, 33, 36);
}

function parseCssDeclarations(cssText: string): Array<CssDeclaration> {
  let out = new Array<CssDeclaration>();
  let pairs = cssText.split(";");
  for (let i = 0; i < pairs.length; i++) {
    let pair = trim(pairs[i]);
    let colon = pair.indexOf(":");
    if (colon > 0) {
      out.push(new CssDeclaration(pair.substring(0, colon), pair.substring(colon + 1)));
    }
  }
  return out;
}

function parseCssStylesheet(cssText: string): Array<CssRule> {
  let rules = new Array<CssRule>();
  while(cssText.includes("/*")){
    let a=cssText.indexOf("/*"),b=cssText.indexOf("*/",a+2);
    cssText=b>=0?cssText.substring(0,a)+cssText.substring(b+2):cssText.substring(0,a);
  }
  let pos = 0;
  let order = 0;
  while (pos < cssText.length) {
    let openBrace = cssText.indexOf("{", pos);
    if (openBrace < 0) break;
    let closeBrace = cssText.indexOf("}", openBrace);
    if (closeBrace < 0) break;
    let sel = trim(cssText.substring(pos, openBrace));
    let body = cssText.substring(openBrace + 1, closeBrace);
    // Nested at-rules need a media/query engine. Ignore their wrapper instead
    // of applying it as a selector, and record normal comma-separated rules.
    if(!sel.startsWith("@")){
      let selectors=sel.split(",");
      for(let si=0;si<selectors.length;si++){
        let selector=trim(selectors[si]);if(!selector.length)continue;
        let rule = new CssRule(selector);
        rule.declarations = parseCssDeclarations(body);
        rule.order=order++;
        rule.specificity=cssSpecificity(selector);
        rules.push(rule);
      }
    }
    pos = closeBrace + 1;
  }
  return rules;
}

function cssSpecificity(selector:string):i32{
  let score:i32=0,tagPending:bool=true;
  for(let i=0;i<selector.length;i++){
    let c=selector.charCodeAt(i);
    if(c==35){score+=100;tagPending=false;}
    else if(c==46||c==91||c==58){score+=10;tagPending=false;}
    else if((c>=97&&c<=122)&&(i==0||selector.charCodeAt(i-1)==32||selector.charCodeAt(i-1)==62)){score+=1;tagPending=true;}
    else if(c==32||c==62)tagPending=true;
  }
  return score;
}

function compoundSelectorMatches(node:DomNode,selector:string):bool{
  selector=trim(lower(selector));if(!selector.length||selector=="*")return true;
  let pseudo=selector.indexOf(":");if(pseudo>=0)selector=selector.substring(0,pseudo);
  let attrPos=selector.indexOf("[");if(attrPos>=0)selector=selector.substring(0,attrPos);
  let stop=selector.length;let hash=selector.indexOf("#"),dot=selector.indexOf(".");
  if(hash>=0&&hash<stop)stop=hash;if(dot>=0&&dot<stop)stop=dot;
  let tag=selector.substring(0,stop);if(tag.length&&tag!="*"&&tag!=node.tagName)return false;
  let i=stop;
  while(i<selector.length){
    let marker=selector.charCodeAt(i++),end=i;
    while(end<selector.length&&selector.charCodeAt(end)!=35&&selector.charCodeAt(end)!=46)end++;
    let token=selector.substring(i,end);
    if(marker==35&&node.id!=token)return false;
    if(marker==46&&!node.hasClass(token))return false;
    i=end;
  }
  return true;
}

function selectorMatches(node:DomNode,selector:string):bool{
  selector=selector.replace(">"," > ");let raw=selector.split(" "),parts=new Array<string>();
  for(let i=0;i<raw.length;i++){let p=trim(raw[i]);if(p.length)parts.push(p);}
  if(parts.length==0||!compoundSelectorMatches(node,parts[parts.length-1]))return false;
  let current:DomNode|null=node.parent;let i=parts.length-2;
  while(i>=0){
    if(parts[i]==">"){
      i--;if(i<0||current==null||!compoundSelectorMatches(current,parts[i]))return false;
      current=current.parent;i--;continue;
    }
    let found:DomNode|null=null;
    while(current!=null){if(compoundSelectorMatches(current,parts[i])){found=current;break;}current=current.parent;}
    if(found==null)return false;current=found.parent;i--;
  }
  return true;
}

function applyMatchingCss(node:DomNode,rules:Array<CssRule>):void{
  let matches=new Array<CssRule>();
  for(let i=0;i<rules.length;i++)if(selectorMatches(node,rules[i].selector))matches.push(rules[i]);
  // Stable insertion sort: low specificity first, then source order. Later
  // declarations therefore win, matching the essential CSS cascade.
  for(let i=1;i<matches.length;i++){
    let key=matches[i],j=i-1;
    while(j>=0&&(matches[j].specificity>key.specificity||(matches[j].specificity==key.specificity&&matches[j].order>key.order))){matches[j+1]=matches[j];j--;}
    matches[j+1]=key;
  }
  for(let i=0;i<matches.length;i++)for(let d=0;d<matches[i].declarations.length;d++)applyCssDeclaration(node.style,matches[i].declarations[d].property,matches[i].declarations[d].value);
}

function applyCssDeclaration(st: DomStyle, prop: string, val: string): void {
  let numVal = cssLength(val,st.fontSize);
  if (prop == "color") st.color = parseCssColor(val);
  else if (prop == "background" || prop == "background-color") st.bgColor = parseCssColor(val);
  else if (prop == "border-color") st.borderColor = parseCssColor(val);
  else if (prop == "border-radius") st.borderRadius = maxI(0, numVal);
  else if (prop == "border-width" || prop == "border") { st.borderWidth = maxI(1, numVal); if (st.borderColor == 0) st.borderColor = rgba(100, 110, 130); }
  else if (prop == "font-size") { st.fontSize = maxI(9, numVal); st.lineHeight = <i32>(<f64>st.fontSize * 1.35); }
  else if (prop == "font-weight" && (val.includes("bold") || numVal >= 600)) st.isBold = true;
  else if (prop == "line-height") st.lineHeight = val.includes("px")?maxI(st.fontSize,numVal):maxI(st.fontSize,<i32>(<f64>st.fontSize*F64.parseFloat(val)));
  else if (prop == "font-family" && (val.includes("mono") || val.includes("consolas") || val.includes("courier"))) st.isMonospace = true;
  else if (prop == "white-space" && (val.includes("pre") || val.includes("break-spaces"))) st.whiteSpacePre = true;
  else if (prop == "padding") applyBoxValues(st,val,true);
  else if (prop == "padding-top") st.paddingTop = numVal;
  else if (prop == "padding-bottom") st.paddingBottom = numVal;
  else if (prop == "padding-left") st.paddingLeft = numVal;
  else if (prop == "padding-right") st.paddingRight = numVal;
  else if (prop == "margin") applyBoxValues(st,val,false);
  else if (prop == "margin-top") st.marginTop = numVal;
  else if (prop == "margin-bottom") st.marginBottom = numVal;
  else if (prop == "margin-left") st.marginLeft = numVal;
  else if (prop == "margin-right") st.marginRight = numVal;
  else if (prop == "gap") st.gap = maxI(0, numVal);
  else if (prop == "width") st.width = numVal;
  else if (prop == "height") st.height = numVal;
  else if (prop == "min-width") st.minWidth = maxI(0,numVal);
  else if (prop == "min-height") st.minHeight = maxI(0,numVal);
  else if (prop == "max-width") st.maxWidth = maxI(0,numVal);
  else if (prop == "max-height") st.maxHeight = maxI(0,numVal);
  else if (prop == "display") {
    if (val.includes("none")) st.display = 0;
    else if (val.includes("grid")) st.display = 4;
    else if (val.includes("flex")) st.display = 3;
    else if (val.includes("inline")) st.display = 2;
    else st.display = 1;
  } else if (prop == "flex-direction") {
    if (val.includes("column")) st.flexDirection = 1;
    else st.flexDirection = 0;
  } else if (prop == "text-align") {
    if (val.includes("center")) st.textAlign = 1;
    else if (val.includes("right")) st.textAlign = 2;
    else st.textAlign = 0;
  } else if (prop == "justify-content") {
    if(val.includes("space-between"))st.justifyContent=3;else if(val.includes("center"))st.justifyContent=1;else if(val.includes("end"))st.justifyContent=2;else st.justifyContent=0;
  } else if (prop == "align-items") {
    if(val.includes("center"))st.alignItems=1;else if(val.includes("end"))st.alignItems=2;else st.alignItems=0;
  }
}

function cssLength(value:string,fontSize:i32):i32{
  let s=trim(lower(value));if(s=="auto"||s.includes("%")||s.includes("calc("))return-1;
  let factor:f64=1.0;if(s.includes("rem"))factor=16.0;else if(s.includes("em"))factor=<f64>fontSize;
  let clean=s.replace("px","").replace("rem","").replace("em","");
  let parsed=F64.parseFloat(clean);if(isNaN(parsed))return 0;return <i32>(parsed*factor);
}

function applyBoxValues(st:DomStyle,value:string,padding:bool):void{
  let raw=value.split(" "),v=new Array<i32>();for(let i=0;i<raw.length;i++){let x=trim(raw[i]);if(x.length)v.push(maxI(0,cssLength(x,st.fontSize)));}
  if(v.length==0)return;let top=v[0],right=v.length>1?v[1]:top,bottom=v.length>2?v[2]:top,left=v.length>3?v[3]:right;
  if(padding){st.paddingTop=top;st.paddingRight=right;st.paddingBottom=bottom;st.paddingLeft=left;}
  else{st.marginTop=top;st.marginRight=right;st.marginBottom=bottom;st.marginLeft=left;}
}

function wrapLines(text:string,maxChars:i32):Array<string>{
  let out=new Array<string>();let src=text.replace("\r","");let paras=src.split("\n");
  for(let p=0;p<paras.length;p++){
    let s=paras[p].trim();if(s.length==0){out.push("");continue;}
    while(s.length>maxChars){
      let cut=maxChars;while(cut>maxChars/2&&s.charCodeAt(cut)!=32)cut--;
      if(cut<=maxChars/2)cut=maxChars;
      out.push(s.substring(0,cut).trim());s=s.substring(cut).trim();
    }
    out.push(s);
  }
  return out;
}

function layoutDomTree(node: DomNode, startX: i32, startY: i32, availableW: i32): i32 {
  if(node.style.display==0){node.x=startX;node.y=startY;node.w=0;node.h=0;return 0;}
  node.x = startX + node.style.marginLeft;
  node.y = startY + node.style.marginTop;
  node.w = node.style.width > 0 ? minI(node.style.width, availableW) : availableW - (node.style.marginLeft + node.style.marginRight);
  node.w=maxI(node.style.minWidth,node.w);if(node.style.maxWidth>0)node.w=minI(node.w,node.style.maxWidth);

  let innerX = node.x + node.style.paddingLeft + node.style.borderWidth;
  let innerY = node.y + node.style.paddingTop + node.style.borderWidth;
  let innerW = maxI(10, node.w - (node.style.paddingLeft + node.style.paddingRight + node.style.borderWidth * 2));

  let currentY = innerY;
  let currentX = innerX;

  if (node.text.length > 0) {
    let maxChars = maxI(12, innerW / (node.style.fontSize > 20 ? 14 : 8));
    let lines = wrapLines(node.text, maxChars);
    currentY += lines.length * node.style.lineHeight;
  }

  if ((node.style.display == 3 && node.style.flexDirection == 0)||node.style.display==4) {
    let childW = (innerW - (node.children.length - 1) * node.style.gap) / maxI(1, node.children.length);
    let maxChildH = 0;
    for (let i = 0; i < node.children.length; i++) {
      let child = node.children[i];
      let ch = layoutDomTree(child, currentX, innerY, childW);
      if (ch > maxChildH) maxChildH = ch;
      currentX += childW + node.style.gap;
    }
    currentY += maxChildH;
  } else {
    for (let i = 0; i < node.children.length; i++) {
      let child = node.children[i];
      let ch = layoutDomTree(child, innerX, currentY, innerW);
      currentY += ch + (node.style.display == 3 ? node.style.gap : 0);
    }
  }

  let totalH = (currentY - innerY) + node.style.paddingTop + node.style.paddingBottom + node.style.borderWidth * 2;
  node.h = node.style.height > 0 ? node.style.height : maxI(node.style.lineHeight, totalH);
  node.h=maxI(node.style.minHeight,node.h);if(node.style.maxHeight>0)node.h=minI(node.h,node.style.maxHeight);

  return node.h + node.style.marginTop + node.style.marginBottom;
}

function drawRoundedCard(x: i32, y: i32, w: i32, h: i32, radius: i32, bgColor: u32, borderColor: u32, borderWidth: i32): void {
  if (bgColor != 0) drawRect(x, y, w, h, bgColor);
  if (borderWidth > 0 && borderColor != 0) drawFrame(x, y, w, h, borderColor);
}

function renderDomNode(node: DomNode, scrollY: i32): void {
  if(node.style.display==0)return;
  let screenY = CONTENT_Y + node.y - scrollY;

  if (screenY + node.h >= CONTENT_Y && screenY <= CONTENT_Y + CONTENT_H) {
    if (node.style.bgColor != 0 || node.style.borderWidth > 0) {
      drawRoundedCard(node.x, screenY, node.w, node.h, node.style.borderRadius, node.style.bgColor, node.style.borderColor, node.style.borderWidth);
    }

    if(node.tagName=="img"&&node.resourceId>0&&tabs.length){let image=resourceById(tabNow(),node.resourceId);if(image!=null&&image.imageHandle>=0&&image.imageW>0)host_image_draw(image.imageHandle,pixels.dataStart,WIDTH,HEIGHT,node.x,screenY,node.w,node.h);}

    if (node.text.length > 0) {
      let textX = node.x + node.style.paddingLeft + node.style.borderWidth;
      let textY = screenY + node.style.paddingTop + node.style.borderWidth;
      let innerW = node.w - (node.style.paddingLeft + node.style.paddingRight + node.style.borderWidth * 2);
      let maxChars = maxI(12, innerW / (node.style.fontSize > 20 ? 14 : 8));
      let lines = wrapLines(node.text, maxChars);

      let flags = 16;
      if (node.style.isBold) flags |= 4;
      if (node.style.isMonospace) flags |= 8;

      for (let l = 0; l < lines.length; l++) {
        let drawX = textX;
        if (node.style.textAlign == 1) drawX += maxI(0, (innerW - lines[l].length * 8) / 2);
        drawUnicodeText(lines[l], drawX, textY + l * node.style.lineHeight, innerW, node.style.fontSize, node.style.color, flags);
      }
    }
  }

  for (let i = 0; i < node.children.length; i++) {
    renderDomNode(node.children[i], scrollY);
  }
}

function findNodeById(root: DomNode, id: string): DomNode | null {
  if (root.id == id) return root;
  for (let i = 0; i < root.children.length; i++) {
    let f = findNodeById(root.children[i], id);
    if (f != null) return f;
  }
  return null;
}

function findNodeByUid(root:DomNode,uid:i32):DomNode|null{if(root.uid==uid)return root;for(let i=0;i<root.children.length;i++){let n=findNodeByUid(root.children[i],uid);if(n!=null)return n;}return null;}
function jsonEscapeText(s:string):string{let out="";for(let i=0;i<s.length;i++){let c=s.charCodeAt(i);if(c==34)out+="\\\"";else if(c==92)out+="\\\\";else if(c==10)out+="\\n";else if(c==13)out+="\\r";else if(c==9)out+="\\t";else if(c<32)out+=" ";else out+=s.charAt(i);}return out;}
function appendJsDomNodes(node:DomNode,out:string):string{
  if(node.tagName!="#document"){if(out.length)out+=",";out+="{\"uid\":"+node.uid.toString()+",\"tag\":\""+jsonEscapeText(node.tagName=="#text"?"span":node.tagName)+"\",\"id\":\""+jsonEscapeText(node.id)+"\",\"className\":\"";for(let i=0;i<node.classList.length;i++){if(i)out+=" ";out+=jsonEscapeText(node.classList[i]);}out+="\",\"text\":\""+jsonEscapeText(node.text)+"\"}";}
  for(let i=0;i<node.children.length;i++)out=appendJsDomNodes(node.children[i],out);return out;
}
function prepareProductionRenderer(t:BrowserTab,html:string):void{if(t.rendererId>=0)host_web_renderer_destroy(t.rendererId);let ub=String.UTF8.encode(t.url),hb=String.UTF8.encode(html);t.rendererId=host_web_renderer_create(t.id,changetype<usize>(ub),ub.byteLength,changetype<usize>(hb),hb.byteLength,0,CONTENT_Y,WIDTH,CONTENT_H,WIDTH,HEIGHT);t.rendererCommitted=false;t.rendererCreatedAt=now_ms();if(t.rendererId>=0)devConsole(t,"Network-denied Chromium/WebView renderer created.",0);else devConsole(t,"Native Chromium renderer unavailable; using WASM framebuffer fallback.",1);}
function prepareJsRealm(t:BrowserTab):void{
  if(t.rendererId>=0)return;
  if(t.jsRealmId>=0)host_js_realm_destroy(t.jsRealmId);t.jsRealmId=host_js_realm_create(t.id);if(t.jsRealmId<0){devConsole(t,"Isolated ECMAScript realm unavailable; using compatibility evaluator.",1);return;}
  let json="{\"url\":\""+jsonEscapeText(t.url)+"\",\"nodes\":["+appendJsDomNodes(t.rootDom,"")+"]}",b=String.UTF8.encode(json);let ok=host_js_realm_set_dom(t.jsRealmId,changetype<usize>(b),b.byteLength);if(ok<0){host_js_realm_destroy(t.jsRealmId);t.jsRealmId=-1;devConsole(t,"Failed to initialize isolated DOM realm.",2);}else devConsole(t,"Network-denied ECMAScript realm initialized.",0);
}

function executeBrowserScript(t:BrowserTab,scriptText: string, rootNode: DomNode,source:string="inline-script.js"): void {
  if(t.rendererId>=0)return;
  if(t.jsRealmId>=0){let code=String.UTF8.encode(scriptText),name=String.UTF8.encode(source),job=host_js_realm_eval(t.jsRealmId,changetype<usize>(code),code.byteLength,changetype<usize>(name),name.byteLength);if(job>=0){devConsole(t,"Queued isolated script #"+job.toString()+": "+source,0);return;}devConsole(t,"Isolated script queue rejected; applying compatibility evaluator.",1);}
  let lines = scriptText.split("\n");
  let recognized:i32=0;
  for (let i = 0; i < lines.length; i++) {
    let line = trim(lines[i]);
    if (line.startsWith("//") || line.length == 0) continue;

    if (line.startsWith("console.log(")||line.startsWith("console.warn(")||line.startsWith("console.error(")) {
      let p1 = line.indexOf("("), p2 = line.lastIndexOf(")");
      if (p1 >= 0 && p2 > p1) {
        let kind=line.startsWith("console.error")?2:(line.startsWith("console.warn")?1:0);
        let message=line.substring(p1 + 1, p2).replace("\"", "").replace("'", "");
        devConsole(t,message,kind);logLine("[JS Console] "+message);recognized++;
      }
    }

    if (line.includes("document.getElementById(")) {
      let p1 = line.indexOf("(\""), p2 = line.indexOf("\")");
      if (p1 < 0) { p1 = line.indexOf("('"); p2 = line.indexOf("')"); }
      if (p1 >= 0 && p2 > p1) {
        let id = line.substring(p1 + 2, p2);
        let target = findNodeById(rootNode, id);
        if (target != null) {
          if (line.includes(".textContent") || line.includes(".innerText")) {
            let eq = line.indexOf("=");
            if (eq > 0) target.text = trim(line.substring(eq + 1)).replace("\"", "").replace("'", "").replace(";", "");
          }
          if (line.includes(".style.")) {
            let styleProp = line.substring(line.indexOf(".style.") + 7, line.indexOf("=")).trim();
            let styleVal = trim(line.substring(line.indexOf("=") + 1)).replace("\"", "").replace("'", "").replace(";", "");
            applyCssDeclaration(target.style, styleProp, styleVal);
          }
          recognized++;
        }
      }
    }
  }
  if(scriptText.trim().length>0&&recognized==0)devConsole(t,"Script could not be represented by the compatibility evaluator.",1);
}

function isVoidElement(tag:string):bool{return tag=="area"||tag=="base"||tag=="br"||tag=="col"||tag=="embed"||tag=="hr"||tag=="img"||tag=="input"||tag=="link"||tag=="meta"||tag=="param"||tag=="source"||tag=="track"||tag=="wbr";}

function applyDefaultDomStyle(node:DomNode):void{
  let tag=node.tagName;
  if(tag=="#document"){node.style.bgColor=rgba(255,255,255);return;}
  if(tag=="head"||tag=="title"||tag=="meta"||tag=="link"||tag=="base"||tag=="template"){node.style.display=0;return;}
  if(tag=="h1"){node.style.fontSize=32;node.style.lineHeight=40;node.style.isBold=true;node.style.marginTop=14;node.style.marginBottom=12;}
  else if(tag=="h2"){node.style.fontSize=24;node.style.lineHeight=32;node.style.isBold=true;node.style.marginTop=12;node.style.marginBottom=8;}
  else if(tag=="h3"){node.style.fontSize=19;node.style.lineHeight=27;node.style.isBold=true;node.style.marginTop=10;node.style.marginBottom=6;}
  else if(tag=="p"){node.style.marginBottom=10;}
  else if(tag=="a"){node.style.color=rgba(0,102,204);node.style.display=2;}
  else if(tag=="strong"||tag=="b"){node.style.isBold=true;node.style.display=2;}
  else if(tag=="span"||tag=="em"||tag=="i"||tag=="label"){node.style.display=2;}
  else if(tag=="pre"||tag=="code"){node.style.isMonospace=true;node.style.whiteSpacePre=true;if(tag=="pre"){node.style.bgColor=rgba(246,248,250);node.style.paddingTop=node.style.paddingBottom=12;node.style.paddingLeft=node.style.paddingRight=14;}}
  else if(tag=="button"||tag=="input") {node.style.bgColor=rgba(240,243,246);node.style.borderColor=rgba(190,197,207);node.style.borderWidth=1;node.style.borderRadius=6;node.style.paddingTop=node.style.paddingBottom=8;node.style.paddingLeft=node.style.paddingRight=14;node.style.display=2;}
  else if(tag=="img"){node.style.display=2;node.style.width=300;node.style.height=150;}
  else if(tag=="hr"){node.style.borderColor=rgba(220,225,230);node.style.borderWidth=1;node.style.marginTop=node.style.marginBottom=12;node.style.height=1;}
  else if(tag=="ul"||tag=="ol"){node.style.paddingLeft=22;node.style.marginBottom=10;}
  else if(tag=="body"){node.style.paddingTop=node.style.paddingBottom=node.style.paddingLeft=node.style.paddingRight=20;}
}

function computeDomStyles(node:DomNode,rules:Array<CssRule>,parent:DomNode|null):void{
  if(parent!=null){node.style.color=parent.style.color;node.style.fontSize=parent.style.fontSize;node.style.lineHeight=parent.style.lineHeight;node.style.isMonospace=parent.style.isMonospace;}
  applyDefaultDomStyle(node);applyMatchingCss(node,rules);
  for(let d=0;d<node.inlineStyles.length;d++)applyCssDeclaration(node.style,node.inlineStyles[d].property,node.inlineStyles[d].value);
  for(let i=0;i<node.children.length;i++)computeDomStyles(node.children[i],rules,node);
}

function appendDomText(t:BrowserTab,parent:DomNode,text:string):void{
  text=decodeEntities(text).replace("\r"," ").replace("\n"," ").trim();if(!text.length||t.domNodeCount>=MAX_ELEMENTS)return;
  let node=new DomNode("#text");node.uid=t.domNodeCount;node.text=text;node.style.display=2;parent.appendChild(node);t.domNodeCount++;
}

function parseHtmlDocument(t: BrowserTab, html: string): void {
  let parseStart=now_ms();
  t.rootDom = new DomNode("#document");t.rootDom.uid=0;t.hasDomTree=true;t.consoleLines.length=0;t.consoleKinds.length=0;t.domNodeCount=1;t.cssRuleCount=0;t.scriptCount=0;t.parseErrorCount=0;t.cssRules.length=0;
  let title=extractTitle(html);if(title.length)t.title=title;
  prepareProductionRenderer(t,html);
  let lowerHtml=lower(html),globalCss=new Array<CssRule>(),scripts=new Array<string>();

  let stylePos=0;
  while(stylePos<html.length){let sOpen=lowerHtml.indexOf("<style",stylePos);if(sOpen<0)break;let sClose=html.indexOf(">",sOpen),sEnd=lowerHtml.indexOf("</style>",sClose);if(sClose<0||sEnd<sClose){t.parseErrorCount++;break;}let cssText=html.substring(sClose+1,sEnd),parsed=parseCssStylesheet(cssText);scanCssResourceUrls(t,cssText,t.url);for(let r=0;r<parsed.length;r++)globalCss.push(parsed[r]);stylePos=sEnd+8;}
  t.cssRuleCount=globalCss.length;

  let scriptPos=0;
  while(scriptPos<html.length){let sOpen=lowerHtml.indexOf("<script",scriptPos);if(sOpen<0)break;let sClose=html.indexOf(">",sOpen),sEnd=lowerHtml.indexOf("</script>",sClose);if(sClose<0||sEnd<sClose){t.parseErrorCount++;break;}let openTag=html.substring(sOpen+1,sClose),scriptType=lower(attr(openTag,"type")),src=attr(openTag,"src");if(scriptType!="importmap"&&scriptType!="application/ld+json"&&scriptType!="application/json"){if(src.length)queuePageResource(t,src,RESOURCE_SCRIPT);else{let inlineJs=html.substring(sClose+1,sEnd);scripts.push(inlineJs);scanModuleImports(t,inlineJs,t.url);}t.scriptCount++;}scriptPos=sEnd+9;}

  let cleanHtml=stripBlock(stripBlock(html,"script"),"style"),pos=0,stack=new Array<DomNode>();stack.push(t.rootDom);
  while(pos<cleanHtml.length&&t.domNodeCount<MAX_ELEMENTS){
    let lt=cleanHtml.indexOf("<",pos);if(lt<0){appendDomText(t,stack[stack.length-1],cleanHtml.substring(pos));break;}
    if(lt>pos)appendDomText(t,stack[stack.length-1],cleanHtml.substring(pos,lt));
    if(cleanHtml.substring(lt,minI(cleanHtml.length,lt+4))=="<!--"){let ce=cleanHtml.indexOf("-->",lt+4);if(ce<0){t.parseErrorCount++;break;}pos=ce+3;continue;}
    let gt=cleanHtml.indexOf(">",lt+1);if(gt<0){t.parseErrorCount++;break;}
    let rawTag=trim(cleanHtml.substring(lt+1,gt)),tl=lower(rawTag);
    if(tl.startsWith("/")){
      let closing=trim(tl.substring(1)).split(" ")[0],matchIndex:i32=-1;
      for(let si:i32=stack.length-1;si>0;si--)if(stack[si].tagName==closing){matchIndex=si;break;}
      if(matchIndex<0)t.parseErrorCount++;else while(stack.length>matchIndex)stack.pop();
    }else if(!tl.startsWith("!")){let tagName=tl.split(" ")[0].replace("/","");if(tagName.length){
      let node=new DomNode(tagName);node.uid=t.domNodeCount;node.id=lower(attr(rawTag,"id"));node.href=attr(rawTag,"href");
      let classes=lower(attr(rawTag,"class")).split(" ");for(let c=0;c<classes.length;c++)if(classes[c].length)node.classList.push(classes[c]);
      let inlineStyle=attr(rawTag,"style");if(inlineStyle.length){node.inlineStyles=parseCssDeclarations(inlineStyle);scanCssResourceUrls(t,inlineStyle,t.url);}
      if(tagName=="img"){node.text=attr(rawTag,"alt");node.resourceId=queuePageResource(t,attr(rawTag,"src"),RESOURCE_IMAGE);queueSrcSet(t,attr(rawTag,"srcset"));let aw=attr(rawTag,"width"),ah=attr(rawTag,"height");if(aw.length)node.style.width=maxI(1,I32.parseInt(aw));if(ah.length)node.style.height=maxI(1,I32.parseInt(ah));}else if(tagName=="source"){queuePageResource(t,attr(rawTag,"src"),RESOURCE_OTHER);queueSrcSet(t,attr(rawTag,"srcset"));}else if(tagName=="video"||tagName=="audio"||tagName=="track")queuePageResource(t,attr(rawTag,"src"),RESOURCE_OTHER);else if(tagName=="input")node.text=attr(rawTag,"value");
      if(tagName=="video")queuePageResource(t,attr(rawTag,"poster"),RESOURCE_IMAGE);
      stack[stack.length-1].appendChild(node);t.domNodeCount++;
      if(tagName=="link"){let rel=lower(attr(rawTag,"rel")),asKind=lower(attr(rawTag,"as"));if(rel.includes("stylesheet"))queuePageResource(t,attr(rawTag,"href"),RESOURCE_CSS);else if(rel.includes("icon")||rel.includes("apple-touch-icon")||rel.includes("mask-icon"))queuePageResource(t,attr(rawTag,"href"),RESOURCE_IMAGE);else if(rel.includes("preload")||rel.includes("modulepreload")){let kind=asKind=="style"?RESOURCE_CSS:(asKind=="font"?RESOURCE_FONT:(asKind=="image"?RESOURCE_IMAGE:RESOURCE_SCRIPT));queuePageResource(t,attr(rawTag,"href"),kind);}}
      if((tagName=="use"||tagName=="image")&&attr(rawTag,"href").length)queuePageResource(t,attr(rawTag,"href"),RESOURCE_IMAGE);
      if(!isVoidElement(tagName)&&!tl.endsWith("/"))stack.push(node);
    }}
    pos=gt+1;
  }
  if(t.domNodeCount>=MAX_ELEMENTS)devConsole(t,"DOM node limit reached ("+MAX_ELEMENTS.toString()+")",2);
  if(stack.length>1)t.parseErrorCount+=stack.length-1;
  for(let r=0;r<globalCss.length;r++)t.cssRules.push(globalCss[r]);computeDomStyles(t.rootDom,t.cssRules,null);prepareJsRealm(t);
  for(let s=0;s<scripts.length;s++)executeBrowserScript(t,scripts[s],t.rootDom,"inline-script-"+(s+1).toString()+".js");
  if(t.parseErrorCount>0)devConsole(t,t.parseErrorCount.toString()+" HTML recovery event(s)",1);
  t.parseDurationMs=now_ms()-parseStart;layoutDocument(t);pumpResourceScheduler(t);rendererMaybeCommit(t);
}

function parsePlainDocument(t:BrowserTab,text:string):void{t.hasDomTree=false;t.elements=new Array<PageElement>();let lines=text.split("\n");for(let i=0;i<lines.length&&i<MAX_ELEMENTS;i++)pushElement(t.elements,E_PRE,lines[i]);layoutDocument(t);}
function homeElements():Array<PageElement>{let a=new Array<PageElement>();pushElement(a,E_H1,"WASM OS Browser 5.0");pushElement(a,E_TEXT,"Packet-owned browsing: HTTP, TLS 1.3, certificate validation and the complete subresource graph execute inside WebAssembly.");pushElement(a,E_TEXT,"Production HTML/CSS/JavaScript rendering uses the native Chromium/WebView engine in a network-denied surface fed only by WASM-owned bytes.");pushElement(a,E_H2,"Secure quick start");pushElement(a,E_LINK,"Example HTTPS","https://example.com/");pushElement(a,E_LINK,"Let's Encrypt test","https://valid-isrgrootx1.letsencrypt.org/");pushElement(a,E_LINK,"Example HTTP","http://example.com/");return a;}

function layoutDocument(t:BrowserTab):void{
  let layoutStarted=now_ms();
  let contentW:i32=WIDTH-80-(sidePanel?300:0);
  if(t.hasDomTree){
    let docH=layoutDomTree(t.rootDom,20,20,contentW);
    t.maxScroll=maxI(0,docH-CONTENT_H+40);
    t.scrollY=clampI(t.scrollY,0,t.maxScroll);
    t.layoutDurationMs=now_ms()-layoutStarted;
    return;
  }
  let y:i32=18;
  for(let i=0;i<t.elements.length;i++){
    let e=t.elements[i];let font:i32=15,lh:i32=24,indent:i32=0;
    if(e.kind==E_H1){font=30;lh=42;}
    else if(e.kind==E_H2){font=23;lh=34;}
    else if(e.kind==E_H3){font=18;lh=29;}
    else if(e.kind==E_LIST){indent=18;}
    else if(e.kind==E_PRE){font=14;lh=21;}
    else if(e.kind==E_RULE){e.x=36;e.y=y;e.w=contentW;e.h=12;y+=18;continue;}
    else if(e.kind==E_IMG){font=13;lh=22;}
    let maxChars=maxI(20,(contentW-indent)/(font>22?15:8));
    let lines=wrapLines(e.text,maxChars);
    e.x=36+indent;e.y=y;e.w=contentW-indent;e.h=maxI(lh,lines.length*lh);
    y+=e.h+6;
  }
  t.maxScroll=maxI(0,y-CONTENT_H+30);
  t.scrollY=clampI(t.scrollY,0,t.maxScroll);
  t.layoutDurationMs=now_ms()-layoutStarted;
}

function formatMs(v:f64):string{return v<1000?v.toString().substring(0,minI(6,v.toString().length))+"ms":(v/1000.0).toString().substring(0,minI(5,(v/1000.0).toString().length))+"s";}
function ellipsis(s:string,n:i32):string{return s.length<=n?s:s.substring(0,maxI(0,n-1))+"…";}

function drawButton(x:i32,y:i32,w:i32,h:i32,label:string,enabled:bool=true):void{let hov=hoverX>=x&&hoverX<x+w&&hoverY>=y&&hoverY<y+h;drawRect(x,y,w,h,hov?rgba(224,226,229):C_TOP);drawUnicodeText(label,x+(w-18)/2,y+7,w-8,18,enabled?C_TAB_TEXT:rgba(110,112,116),16);}

function drawChrome():void{
  drawRect(0,0,WIDTH,HEIGHT,C_WHITE);drawRect(0,0,WIDTH,TABBAR_H,C_TOP);
  let x:i32=8;for(let i=0;i<tabs.length;i++){let t=tabs[i];let w=minI(190,maxI(105,(WIDTH-80)/maxI(1,tabs.length)));let act=i==activeTab;drawRect(x,5,w,TABBAR_H-5,act?C_TAB_ACT:C_TAB);let col=act?C_TEXT:C_TAB_TEXT;drawUnicodeText(ellipsis(t.title,20),x+14,12,w-42,13,col,16);drawUnicodeText("×",x+w-25,10,18,16,col,16);x+=w+2;}drawButton(WIDTH-42,5,34,30,"+",true);
  drawRect(0,TABBAR_H,WIDTH,NAV_H,C_TAB_ACT);let y=TABBAR_H+7;drawButton(8,y,34,34,"‹",tabNow().historyIndex>0);drawButton(46,y,34,34,"›",tabNow().historyIndex>=0&&tabNow().historyIndex<tabNow().history.length-1);drawButton(84,y,34,34,"↻",true);drawButton(122,y,34,34,"⌂",true);
  let ax=166,aw=WIDTH-166-164;drawRect(ax,y,aw,34,rgba(232,234,237));if(addressFocused)drawFrame(ax,y,aw,34,C_BLUE);let addr=addressFocused?addressDraft:tabNow().displayUrl;let tc=tlsFind(tabNow().id),lock=tabNow().state==PAGE_TLS_REQUIRED?"! ":(tc&&tc.phase>=TLS_PHASE_ESTABLISHED?"● ":(tc?"◌ ":"◉ "));drawUnicodeText(lock+ellipsis(addr,100),ax+12,y+7,aw-24,14,C_TEXT,16);
  drawButton(WIDTH-154,y,34,34,bookmarkIndex(tabNow().url)>=0?"★":"☆",true);drawButton(WIDTH-116,y,34,34,"◷",true);drawButton(WIDTH-78,y,34,34,"⌁",true);drawButton(WIDTH-40,y,34,34,"☰",true);
  drawRect(0,TABBAR_H+NAV_H,WIDTH,BOOKMARK_H,C_TAB_ACT);drawUnicodeText("Packet-owned",14,TABBAR_H+NAV_H+6,100,11,C_GREEN,16);let activeTls=tlsFind(tabNow().id),wire=activeTls?("TLS 1.3 · "+(activeTls.protocol=="h2"?"HTTP/2":"HTTP/1.1")):"HTTP/1.1";drawUnicodeText(wire,118,TABBAR_H+NAV_H+6,150,11,activeTls?C_GREEN:C_MUTED,16);drawUnicodeText((transportMask&2)!=0?"IWA Direct Sockets":((transportMask&4)!=0?"Native raw socket":"RAW OFFLINE"),275,TABBAR_H+NAV_H+6,180,11,(transportMask&1)!=0?C_GREEN:C_RED,16);
}

function drawPage(t:BrowserTab):void{
  let right=sidePanel?WIDTH-300:WIDTH;drawRect(0,CONTENT_Y,right,CONTENT_H,C_WHITE);
  if(t.state==PAGE_CONNECTING||t.state==PAGE_SENDING||t.state==PAGE_RECEIVING||t.state==PAGE_PARSING||t.state==PAGE_TLS_HANDSHAKE){drawUnicodeText(t.state==PAGE_TLS_HANDSHAKE?"Establishing TLS 1.3…":"Loading…",36,CONTENT_Y+35,right-72,24,C_TEXT,16);drawUnicodeText(statusMessage,36,CONTENT_Y+72,right-72,13,C_MUTED,16);let pct=t.contentLength>0?minI(100,(t.bytesReceived*100)/maxI(1,t.contentLength)):((frameCounter/3)%100);drawRect(36,CONTENT_Y+105,right-72,4,rgba(232,234,237));drawRect(36,CONTENT_Y+105,((right-72)*pct)/100,4,C_BLUE);return;}
  if(t.state==PAGE_ERROR||t.state==PAGE_TLS_REQUIRED){drawUnicodeText(t.state==PAGE_TLS_REQUIRED?"TLS cryptographic substrate unavailable":"This page cannot be reached",48,CONTENT_Y+50,right-96,30,t.state==PAGE_TLS_REQUIRED?C_AMBER:C_RED,16);drawUnicodeText(t.error,48,CONTENT_Y+105,right-96,15,C_TEXT,18);if(t.state==PAGE_TLS_REQUIRED){drawUnicodeText("The Browser refused host-terminated TLS and did not use fetch, a proxy or a renderer network fallback.",48,CONTENT_Y+165,right-96,13,C_MUTED,16);}return;}
  if(t.hasDomTree){
    renderDomNode(t.rootDom, t.scrollY);
    return;
  }
  let sy=t.scrollY;for(let i=0;i<t.elements.length;i++){let e=t.elements[i];let yy=CONTENT_Y+e.y-sy;if(yy+e.h<CONTENT_Y||yy>CONTENT_Y+CONTENT_H)continue;if(e.kind==E_RULE){drawRect(e.x,yy,e.w,1,C_LINE);continue;}let font:i32=15,lh:i32=24,col=C_TEXT;if(e.kind==E_H1){font=30;lh=42;}else if(e.kind==E_H2){font=23;lh=34;}else if(e.kind==E_H3){font=18;lh=29;}else if(e.kind==E_LINK){col=C_LINK;}else if(e.kind==E_LIST){font=15;drawUnicodeText("•",e.x-16,yy,e.w,15,C_TEXT,16);}else if(e.kind==E_PRE){font=14;lh=21;drawRect(e.x-8,yy-4,e.w+16,e.h+8,C_CODE);}else if(e.kind==E_IMG){col=C_MUTED;font=13;}
    let maxChars=maxI(20,e.w/(font>22?15:8));let lines=wrapLines(e.text,maxChars);for(let l=0;l<lines.length;l++)drawUnicodeText(lines[l],e.x,yy+l*lh,e.w,font,col,e.kind==E_PRE?24:18);
  }
}

function clickDomNode(node: DomNode, x: i32, y: i32, scrollY: i32): string {
  let screenY = CONTENT_Y + node.y - scrollY;
  if (node.href.length > 0 && x >= node.x && x < node.x + node.w && y >= screenY && y < screenY + node.h) {
    return node.href;
  }
  for (let i = 0; i < node.children.length; i++) {
    let h = clickDomNode(node.children[i], x, y, scrollY);
    if (h.length > 0) return h;
  }
  return "";
}

function hitDomNode(node:DomNode,x:i32,y:i32,scrollY:i32):DomNode|null{
  let screenY=CONTENT_Y+node.y-scrollY;
  for(let i:i32=node.children.length-1;i>=0;i--){let hit=hitDomNode(node.children[i],x,y,scrollY);if(hit!=null)return hit;}
  return x>=node.x&&x<node.x+node.w&&y>=screenY&&y<screenY+node.h?node:null;
}

function clickPage(t:BrowserTab,x:i32,y:i32):void{
  if(t.hasDomTree){
    let hit=hitDomNode(t.rootDom,x,y,t.scrollY);
    if(hit!=null&&t.jsRealmId>=0){let eventName=String.UTF8.encode("click");host_js_realm_dispatch(t.jsRealmId,hit.uid,changetype<usize>(eventName),eventName.byteLength);}
    let href = clickDomNode(t.rootDom, x, y, t.scrollY);
    if (href.length > 0) {
      let u = resolveRelative(t.url, href);
      if (u.valid) navigate(t, u.raw, true);
      return;
    }
  }
  let cy=y-CONTENT_Y+t.scrollY;
  for(let i=0;i<t.elements.length;i++){
    let e=t.elements[i];
    if(e.kind==E_LINK&&x>=e.x&&x<e.x+e.w&&cy>=e.y&&cy<e.y+e.h){
      let u=resolveRelative(t.url,e.href);
      if(u.valid)navigate(t,u.raw,true);
      return;
    }
  }
}

function drawDomInspector(node:DomNode,x:i32,y:i32,depth:i32):i32{
  if(y>=HEIGHT-34||depth>6)return y;let label=node.tagName;if(node.id.length)label+="#"+node.id;if(node.classList.length)label+="."+node.classList[0];
  drawUnicodeText(ellipsis(label,34-depth*2),x+minI(72,depth*10),y,250-depth*10,10,node.tagName=="#text"?C_MUTED:C_BLUE,16);y+=15;
  for(let i=0;i<node.children.length&&y<HEIGHT-34;i++)y=drawDomInspector(node.children[i],x,y,depth+1);return y;
}

function drawSide(t:BrowserTab):void{
  if(sidePanel==0)return;let x=WIDTH-300;drawRect(x,CONTENT_Y,300,CONTENT_H,rgba(248,249,250));drawRect(x,CONTENT_Y,1,CONTENT_H,C_LINE);
  let title=sidePanel==1?"History":(sidePanel==2?"Bookmarks":(sidePanel==3?"Network":"Developer Tools"));drawUnicodeText(title,x+18,CONTENT_Y+18,260,20,C_TEXT,16);let y=CONTENT_Y+54;
  if(sidePanel==1){for(let i=t.history.length-1;i>=0&&y<HEIGHT-40;i--){drawUnicodeText(ellipsis(t.history[i],36),x+18,y,260,12,i==t.historyIndex?C_BLUE:C_TEXT,16);y+=24;}return;}
  if(sidePanel==2){for(let i=0;i<bookmarks.length&&y<HEIGHT-40;i++){drawUnicodeText(ellipsis(bookmarkTitles[i].length?bookmarkTitles[i]:bookmarks[i],34),x+18,y,260,12,C_LINK,16);drawUnicodeText(ellipsis(bookmarks[i],38),x+18,y+15,260,9,C_MUTED,16);y+=42;}if(bookmarks.length==0)drawUnicodeText("No bookmarks yet",x+18,y,260,12,C_MUTED,16);return;}
  if(sidePanel==3){let lines=new Array<string>(),tc=tlsFind(t.id);lines.push("State: "+t.state.toString());lines.push("Socket: "+t.socketId.toString());if(tc){lines.push("TLS: 1.3 / "+tc.cipher);lines.push("ALPN: "+tc.protocol);lines.push("Cert path: "+(tc.chainTrusted?"trusted":"validating"));lines.push("Peer: "+ellipsis(tc.peerSummary,34));}lines.push("Status: "+t.statusCode.toString());lines.push("Sent: "+t.bytesSent.toString()+" B");lines.push("Received: "+t.bytesReceived.toString()+" B");lines.push("Content: "+t.contentType);lines.push("Header bytes: "+t.headerEnd.toString());lines.push("TTFB: "+(t.firstByteAt>0?formatMs(t.firstByteAt-t.requestStarted):"-"));lines.push("Total: "+(t.completedAt>0?formatMs(t.completedAt-t.requestStarted):"-"));if(transportInfo.length)lines.push("Transport: "+ellipsis(transportInfo,42));for(let i=0;i<lines.length;i++){drawUnicodeText(lines[i],x+18,y,260,12,C_TEXT,16);y+=22;}y+=8;drawUnicodeText("REQUEST HEADERS",x+18,y,260,11,C_MUTED,16);y+=20;let q=wrapLines(t.requestHeaders,38);for(let i=0;i<q.length&&y<HEIGHT-40;i++){drawUnicodeText(q[i],x+18,y,260,10,C_MUTED,24);y+=17;}return;}
  let metrics=new Array<string>();metrics.push("DOM nodes: "+t.domNodeCount.toString());metrics.push("CSS rules: "+t.cssRuleCount.toString());metrics.push("Scripts: "+t.scriptCount.toString()+" · "+(t.rendererId>=0?(t.rendererCommitted?"Chromium committed":"Chromium staging"):(t.jsRealmId>=0?"isolated realm":"framebuffer fallback")));metrics.push("Resources: "+t.resourcesReady.toString()+" ready · "+activeResourceCount(t.id).toString()+" active · "+t.resourcesFailed.toString()+" failed");metrics.push("Resource cache: "+t.resourceBytes.toString()+" B");metrics.push("Trust cache: "+(trustCacheHostReady(parseUrl(t.url).host)?"hit":"miss"));metrics.push("HTML recovery: "+t.parseErrorCount.toString());metrics.push("Parse: "+formatMs(t.parseDurationMs));metrics.push("Layout: "+formatMs(t.layoutDurationMs));
  for(let i=0;i<metrics.length;i++){drawUnicodeText(metrics[i],x+18,y,260,11,C_TEXT,16);y+=18;}y+=6;drawUnicodeText("CONSOLE",x+18,y,260,11,C_MUTED,16);y+=18;
  let start=maxI(0,t.consoleLines.length-6);for(let i=start;i<t.consoleLines.length&&y<HEIGHT-220;i++){let color=t.consoleKinds[i]==2?C_RED:(t.consoleKinds[i]==1?C_AMBER:C_TEXT);let rows=wrapLines(t.consoleLines[i],38);for(let r=0;r<rows.length&&y<HEIGHT-220;r++){drawUnicodeText(rows[r],x+18,y,260,10,color,16);y+=15;}}
  y+=5;drawUnicodeText("ELEMENTS",x+18,y,260,11,C_MUTED,16);y+=18;drawDomInspector(t.rootDom,x+10,y,0);
}

function renderStatus(t:BrowserTab):void{drawRect(0,HEIGHT-STATUS_H,WIDTH,STATUS_H,C_TAB_ACT);drawRect(0,HEIGHT-STATUS_H,WIDTH,1,C_LINE);drawUnicodeText(ellipsis(statusMessage,130),10,HEIGHT-17,WIDTH-250,11,C_MUTED,16);drawUnicodeText("tabs "+tabs.length.toString()+" · cookies "+cookies.length.toString(),WIDTH-220,HEIGHT-17,210,11,C_MUTED,16);}

function syncNativeRenderers(updateBounds:bool):void{let pageWidth=sidePanel?WIDTH-300:WIDTH;for(let i=0;i<tabs.length;i++){let t=tabs[i];if(t.rendererId<0)continue;let visible=i==activeTab&&t.state==PAGE_READY&&t.rendererCommitted;host_web_renderer_show(t.rendererId,visible?1:0);if(visible&&updateBounds)host_web_renderer_set_bounds(t.rendererId,0,CONTENT_Y,pageWidth,CONTENT_H,WIDTH,HEIGHT);}}
function publishServiceLoad():void{let active:i32=0,queued:i32=0;for(let i:i32=0;i<resourceRequests.length;i++){let s=resourceRequests[i].state;if(s==PAGE_CONNECTING||s==PAGE_TLS_HANDSHAKE||s==PAGE_RECEIVING)active++;else if(s==PAGE_IDLE)queued++;}let ids:i32[]=[browserServiceId,urlServiceId,originServiceId,httpServiceId,tlsServiceId,resourceServiceId,tabsServiceId,bookmarksServiceId,cookiesServiceId,rendererServiceId,websocketServiceId];for(let i:i32=0;i<ids.length;i++)if(ids[i]>=0)OsService.load(ids[i],active,queued,32,0);}

export function renderFrame():i32{
  frameCounter++;if((frameCounter%30)==0)publishServiceLoad();for(let i=0;i<tabs.length;i++)if(tabs[i].state==PAGE_CONNECTING||tabs[i].state==PAGE_RECEIVING||tabs[i].state==PAGE_TLS_HANDSHAKE)pumpNetwork(tabs[i]);pumpResourceRequests();
  syncNativeRenderers(needsRender||(frameCounter%30)==0);
  if(!needsRender)return <i32>pixels.dataStart;needsRender=false;
  pixels.fill(C_WHITE);drawChrome();let t=tabNow();drawPage(t);drawSide(t);renderStatus(t);presentedFrameRevision++;return <i32>pixels.dataStart;
}
export function browserFrameRevision():i32{return presentedFrameRevision;}
export function browserProtocolSelfTest():i32{
  let c=new TlsConnection(),t=new BrowserTab();t.id=77;t.url="https://example.test/upload";t.requestMethod="POST";t.requestCredentials="omit";t.requestBody=new Uint8Array(70000);for(let i:i32=0;i<t.requestBody.length;i++)t.requestBody[i]=<u8>(i&255);
  let frames=h2RequestFrames(c,t,1),s=h2StreamFind(c,1);if(s==null)return 1;if(s.bodyOffset!=65535||s.localClosed||c.h2ConnSendWindow!=0)return 2;
  let p:i32=0,dataBytes:i32=0,sawHeaders=false;while(p<frames.length){if(p+9>frames.length)return 3;let n=be24(frames,p),kind=frames[p+3],stream=<i32>(be32(frames,p+5)&0x7fffffff);if(n>16384||p+9+n>frames.length||stream!=1)return 4;if(kind==H2_FRAME_HEADERS)sawHeaders=true;else if(kind==H2_FRAME_DATA)dataBytes+=n;p+=9+n;}if(p!=frames.length||!sawHeaders||dataBytes!=65535)return 5;
  c.h2ConnSendWindow=4465;s.sendWindow+=4465;let tail=new ByteAccumulator();h2AppendBody(c,s,t,tail);if(!s.localClosed||s.bodyOffset!=70000||tail.length<=9)return 6;
  if(!corsNeedsPreflight("PUT","")||!corsNeedsPreflight("POST","x-custom: 1\n")||corsNeedsPreflight("GET","accept: application/json\n"))return 7;
  let a=parseUrl("https://example.test/a"),b=parseUrl("https://example.test:443/b"),x=parseUrl("https://other.test/");if(!sameOrigin(a,b)||sameOrigin(a,x)||urlOrigin(a)!="https://example.test")return 8;
  return 0;
}

function hitTabIndex(x:i32,y:i32):i32{if(y<5||y>=TABBAR_H)return-1;let px=8;for(let i=0;i<tabs.length;i++){let w=minI(190,maxI(105,(WIDTH-80)/maxI(1,tabs.length)));if(x>=px&&x<px+w)return i;px+=w+2;}return-1;}

export function mouseMove(x:i32,y:i32,buttons:i32,mods:i32):void{if(x!=hoverX||y!=hoverY||buttons!=mouseButtons){hoverX=x;hoverY=y;mouseButtons=buttons;needsRender=true;}}
export function mouseDown(button:i32,x:i32,y:i32,mods:i32):void{
  if(button!=0)return;let ti=hitTabIndex(x,y);if(ti>=0){let px=8;for(let i=0;i<ti;i++)px+=minI(190,maxI(105,(WIDTH-80)/maxI(1,tabs.length)))+2;let w=minI(190,maxI(105,(WIDTH-80)/maxI(1,tabs.length)));if(x>px+w-34)closeTab(ti);else{activeTab=ti;addressDraft=tabNow().url;}needsRender=true;return;}
  if(y<TABBAR_H&&x>WIDTH-50){addTab("");return;}
  let ny=TABBAR_H+7;if(y>=ny&&y<ny+34){if(x>=8&&x<42){goHistory(-1);return;}if(x>=46&&x<80){goHistory(1);return;}if(x>=84&&x<118){let u=tabNow().url;if(u.length)navigate(tabNow(),u,false);return;}if(x>=122&&x<156){tabNow().elements=homeElements();tabNow().hasDomTree=false;tabNow().url="";tabNow().displayUrl="";tabNow().title="New Tab";tabNow().state=PAGE_READY;layoutDocument(tabNow());needsRender=true;return;}let ax=166,aw=WIDTH-166-164;if(x>=ax&&x<ax+aw){addressFocused=true;addressDraft=tabNow().url;needsRender=true;return;}if(x>=WIDTH-154&&x<WIDTH-120){toggleBookmark(tabNow());return;}if(x>=WIDTH-116&&x<WIDTH-82){sidePanel=sidePanel==1?0:1;layoutDocument(tabNow());needsRender=true;return;}if(x>=WIDTH-78&&x<WIDTH-44){sidePanel=sidePanel==3?0:3;layoutDocument(tabNow());needsRender=true;return;}if(x>=WIDTH-40){sidePanel=sidePanel==2?0:2;layoutDocument(tabNow());needsRender=true;return;}}
  addressFocused=false;if(sidePanel&&x>=WIDTH-300&&y>=CONTENT_Y&&y<HEIGHT-STATUS_H){let row=y-(CONTENT_Y+54);if(sidePanel==1&&row>=0){let idx=tabNow().history.length-1-(row/24);if(idx>=0&&idx<tabNow().history.length){tabNow().historyIndex=idx;navigate(tabNow(),tabNow().history[idx],false);return;}}else if(sidePanel==2&&row>=0){let idx=row/42;if(idx>=0&&idx<bookmarks.length){navigate(tabNow(),bookmarks[idx],true);return;}}}if(y>=CONTENT_Y&&y<HEIGHT-STATUS_H)clickPage(tabNow(),x,y);needsRender=true;
}
export function mouseUp(button:i32,x:i32,y:i32,mods:i32):void{}
export function mouseWheel(dx:i32,dy:i32,mods:i32):void{let t=tabNow();t.scrollY=clampI(t.scrollY+dy,0,t.maxScroll);needsRender=true;}

export function keyDown(keyCode:i32,mods:i32,repeat:i32):void{
  let ctrl=(mods&2)!=0;if(ctrl&&(mods&1)!=0&&keyCode==73){sidePanel=sidePanel==4?0:4;layoutDocument(tabNow());if(sidePanel==4&&tabNow().rendererId>=0)host_web_renderer_open_devtools(tabNow().rendererId);statusMessage=sidePanel==4?"Developer Tools opened · WebView2 inspector requested":"Developer Tools closed";needsRender=true;return;}if(ctrl&&keyCode==76){addressFocused=true;addressDraft=tabNow().url;needsRender=true;return;}if(ctrl&&keyCode==84){addTab("");return;}if(ctrl&&keyCode==87){closeTab(activeTab);return;}if(ctrl&&keyCode==82){let u=tabNow().url;if(u.length)navigate(tabNow(),u,false);return;}
  if(addressFocused){if(keyCode==8){if(addressDraft.length>0)addressDraft=addressDraft.substring(0,addressDraft.length-1);}else if(keyCode==13){addressFocused=false;let q=trim(addressDraft);if(q.length)navigate(tabNow(),q,true);}else if(keyCode==27){addressFocused=false;addressDraft=tabNow().url;}needsRender=true;return;}
  if(keyCode==37&&mods&8)goHistory(-1);else if(keyCode==39&&mods&8)goHistory(1);
}
export function keyUp(keyCode:i32,mods:i32):void{}
export function textInput(codepoint:i32):void{if(!addressFocused)return;if(codepoint>=32){addressDraft+=codePointString(codepoint);needsRender=true;}}

function codePointString(cp:i32):string{if(cp<=0xFFFF)return String.fromCharCode(cp);let x=cp-0x10000;return String.fromCharCode(0xD800+(x>>10))+String.fromCharCode(0xDC00+(x&0x3FF));}

function readRequestString(requestId:i32,which:i32):string{let n=which==0?host_svc_request_method_size(requestId):host_svc_request_payload_size(requestId);if(n<=0||n>1048576)return"";let b=new Uint8Array(n);let r=which==0?host_svc_request_read_method(requestId,b.dataStart,n):host_svc_request_read_payload(requestId,b.dataStart,n);return r>0?String.UTF8.decode(b.buffer):"";}
function jsonField(json:string,key:string):string{let needle="\""+key+"\"";let p=json.indexOf(needle);if(p<0)return"";p=json.indexOf(":",p+needle.length);if(p<0)return"";p++;while(p<json.length&&json.charCodeAt(p)<=32)p++;if(p>=json.length||json.charAt(p)!="\"")return"";p++;let out="";while(p<json.length){let c=json.charAt(p++);if(c=="\"")break;if(c=="\\"&&p<json.length){let e=json.charAt(p++);if(e=="n")out+="\n";else if(e=="r")out+="\r";else if(e=="t")out+="\t";else out+=e;}else out+=c;}return out;}
function base64Encode(src:Uint8Array,start:i32=0,end:i32=-1):string{let alpha="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",out="";if(end<0||end>src.length)end=src.length;start=maxI(0,start);for(let i:i32=start;i<end;i+=3){let a=<i32>src[i],hasB=i+1<end,hasC=i+2<end,b=hasB?<i32>src[i+1]:0,c=hasC?<i32>src[i+2]:0,v=(a<<16)|(b<<8)|c;out+=alpha.charAt((v>>18)&63)+alpha.charAt((v>>12)&63)+(hasB?alpha.charAt((v>>6)&63):"=")+(hasC?alpha.charAt(v&63):"=");}return out;}
function base64Value(c:i32):i32{if(c>=65&&c<=90)return c-65;if(c>=97&&c<=122)return c-71;if(c>=48&&c<=57)return c+4;if(c==43)return 62;if(c==47)return 63;return-1;}
function base64Decode(text:string):Uint8Array{let clean="";for(let i:i32=0;i<text.length;i++){let c=text.charCodeAt(i);if(base64Value(c)>=0||c==61)clean+=text.charAt(i);}if(clean.length==0||clean.length%4!=0)return new Uint8Array(0);let pad=(clean.endsWith("==")?2:(clean.endsWith("=")?1:0)),out=new Uint8Array((clean.length/4)*3-pad),p:i32=0;for(let i:i32=0;i<clean.length;i+=4){let a=base64Value(clean.charCodeAt(i)),b=base64Value(clean.charCodeAt(i+1)),c=clean.charCodeAt(i+2)==61?0:base64Value(clean.charCodeAt(i+2)),d=clean.charCodeAt(i+3)==61?0:base64Value(clean.charCodeAt(i+3));if(a<0||b<0||c<0||d<0)return new Uint8Array(0);let v=(a<<18)|(b<<12)|(c<<6)|d;if(p<out.length)out[p++]=<u8>(v>>16);if(p<out.length)out[p++]=<u8>(v>>8);if(p<out.length)out[p++]=<u8>v;}return out;}
function serviceHealth(requestId:i32,name:string):void{OsService.respondJson(requestId,200,"{\"ok\":true,\"service\":\""+name+"\",\"owner\":\"wasmos.system.browser\",\"packetOwned\":true}");}
function tabsJson():string{let out="{\"ok\":true,\"active\":"+activeTab.toString()+",\"tabs\":[";for(let i=0;i<tabs.length;i++){if(i)out+=",";out+="{\"id\":"+tabs[i].id.toString()+",\"title\":\""+jsonEscapeText(tabs[i].title)+"\",\"url\":\""+jsonEscapeText(tabs[i].url)+"\",\"state\":"+tabs[i].state.toString()+",\"rendererId\":"+tabs[i].rendererId.toString()+"}";}return out+"]}";}
function startHttpServiceRequest(requestId:i32,payload:string):void{let raw=jsonField(payload,"url"),method=jsonField(payload,"method").toUpperCase(),headers=jsonField(payload,"headers"),credentials=jsonField(payload,"credentials"),bodyText=jsonField(payload,"bodyBase64");if(method.length==0)method="GET";let u=parseUrl(raw);if(!u.valid){OsService.respondJson(requestId,400,"{\"ok\":false,\"error\":\"absolute http/https url required\"}");return;}if(method!="GET"&&method!="HEAD"&&method!="POST"&&method!="PUT"&&method!="PATCH"&&method!="DELETE"&&method!="OPTIONS"){OsService.respondJson(requestId,405,"{\"ok\":false,\"error\":\"unsupported method\"}");return;}let body=base64Decode(bodyText);if(body.length>4*1024*1024){OsService.respondJson(requestId,413,"{\"ok\":false,\"error\":\"request body exceeds 4 MiB\"}");return;}let req=new BrowserTab();req.id=nextResourceRequestId++;req.isResourceRequest=true;req.isServiceRequest=true;req.serviceRequestId=requestId;req.resourceOwnerTabId=tabs.length?tabNow().id:0;req.resourceKind=RESOURCE_OTHER;req.requestMethod=method;req.requestExtraHeaders=headers;req.requestBody=body;req.requestMode="service";req.requestCredentials=credentials=="include"?"include":"omit";req.requestDestination="service";req.title="Service HTTP request";resourceRequests.push(req);navigate(req,u.raw,false);if(req.state==PAGE_ERROR||req.state==PAGE_TLS_REQUIRED)failResourceRequest(req);}
function finishHttpServiceRequest(req:BrowserTab):void{let id=req.serviceRequestId;if(id<=0){removeResourceRequest(req);return;}let streamed=req.body.length>512*1024;if(streamed){let seq:i32=0;for(let p:i32=0;p<req.body.length;p+=48*1024){let end=minI(req.body.length,p+48*1024);OsService.streamJson(id,0,"{\"sequence\":"+(seq++).toString()+",\"bodyBase64\":\""+base64Encode(req.body,p,end)+"\"}");}}let out="{\"ok\":true,\"url\":\""+jsonEscapeText(req.url)+"\",\"status\":"+req.statusCode.toString()+",\"contentType\":\""+jsonEscapeText(req.contentType)+"\",\"headers\":\""+jsonEscapeText(req.responseHeaders)+"\",\"bodyBytes\":"+req.body.length.toString()+",\"streamed\":"+(streamed?"true":"false");if(!streamed)out+=",\"bodyBase64\":\""+base64Encode(req.body)+"\"";out+="}";req.serviceRequestId=0;OsService.respondJson(id,req.statusCode>0?req.statusCode:200,out);removeResourceRequest(req);}
export function serviceRequest(requestId:i32,serviceId:i32,methodBytes:i32,payloadBytes:i32):void{
  let method=readRequestString(requestId,0),payload=readRequestString(requestId,1);
  if(method=="health"){if(serviceId==browserServiceId){OsService.respondJson(requestId,200,"{\"ok\":true,\"engine\":\"packet-owned-tls13\",\"tabs\":"+tabs.length.toString()+",\"rawTransport\":"+(((transportMask&1)!=0)?"true":"false")+",\"tls13\":"+(((host_crypto_capabilities()&31)==31)?"true":"false")+",\"trustAnchors\":"+host_trust_anchor_count().toString()+",\"serviceWorkers\":\"native-origin-bridge\",\"webSocket\":true,\"webTransport\":false,\"webRTC\":false}");return;}serviceHealth(requestId,serviceId==urlServiceId?"os.url":(serviceId==originServiceId?"os.origin.policy":(serviceId==httpServiceId?"os.http.client":(serviceId==tlsServiceId?"os.tls.client":(serviceId==resourceServiceId?"os.web.resource":(serviceId==tabsServiceId?"os.browser.tabs":(serviceId==bookmarksServiceId?"os.browser.bookmarks":(serviceId==cookiesServiceId?"os.cookie.jar":(serviceId==rendererServiceId?"os.web.renderer":(serviceId==websocketServiceId?"os.websocket.client":"unknown"))))))))));return;}
  if(serviceId==browserServiceId||serviceId==tabsServiceId){if(method=="navigate"||method=="newTab"){let url=jsonField(payload,"url");if(url.length==0){OsService.respondJson(requestId,400,"{\"ok\":false,\"error\":\"url required\"}");return;}if(method=="newTab")addTab(url);else navigate(tabNow(),url,true);OsService.respondJson(requestId,202,"{\"ok\":true,\"accepted\":true}");return;}if(method=="tabs"||method=="list"){OsService.respondJson(requestId,200,tabsJson());return;}}
  if(serviceId==urlServiceId&&(method=="normalize"||method=="resolve")){let input=jsonField(payload,"input"),base=jsonField(payload,"base"),u=method=="normalize"?navigationUrl(input,base):resolveRelative(base,input);if(!u.valid){OsService.respondJson(requestId,400,"{\"ok\":false,\"error\":\"invalid url\"}");return;}OsService.respondJson(requestId,200,"{\"ok\":true,\"url\":\""+jsonEscapeText(u.raw)+"\",\"scheme\":\""+u.scheme+"\",\"host\":\""+jsonEscapeText(u.host)+"\",\"port\":"+u.port.toString()+",\"path\":\""+jsonEscapeText(u.path)+"\",\"secure\":"+(u.secure?"true":"false")+"}");return;}
  if(serviceId==originServiceId&&method=="sameOrigin"){let a=parseUrl(jsonField(payload,"a")),b=parseUrl(jsonField(payload,"b"));OsService.respondJson(requestId,200,"{\"ok\":true,\"sameOrigin\":"+(sameOrigin(a,b)?"true":"false")+",\"aOrigin\":\""+(a.valid?jsonEscapeText(urlOrigin(a)):"")+"\",\"bOrigin\":\""+(b.valid?jsonEscapeText(urlOrigin(b)):"")+"\"}");return;}
  if((serviceId==httpServiceId||serviceId==resourceServiceId)&&method=="fetch"){startHttpServiceRequest(requestId,payload);return;}
  if(serviceId==tlsServiceId&&method=="sessions"){OsService.respondJson(requestId,200,"{\"ok\":true,\"active\":"+tlsConnections.length.toString()+",\"tickets\":"+sessionTickets.length.toString()+",\"trustCache\":"+trustCache.length.toString()+",\"trustAnchors\":"+host_trust_anchor_count().toString()+",\"ctLogs\":"+host_ct_log_count().toString()+"}");return;}
  if(serviceId==bookmarksServiceId){if(method=="list"){let out="{\"ok\":true,\"bookmarks\":[";for(let i:i32=0;i<bookmarks.length;i++){if(i)out+=",";out+="{\"url\":\""+jsonEscapeText(bookmarks[i])+"\",\"title\":\""+jsonEscapeText(bookmarkTitles[i])+"\"}";}OsService.respondJson(requestId,200,out+"]}");return;}let url=jsonField(payload,"url");if(method=="add"&&url.length){let title=jsonField(payload,"title"),i=bookmarkIndex(url);if(i<0){bookmarks.push(url);bookmarkTitles.push(title.length?title:url);}else bookmarkTitles[i]=title.length?title:bookmarkTitles[i];saveBookmarks();OsService.respondJson(requestId,200,"{\"ok\":true}");return;}if(method=="remove"&&url.length){let i=bookmarkIndex(url);if(i>=0){bookmarks.splice(i,1);bookmarkTitles.splice(i,1);saveBookmarks();}OsService.respondJson(requestId,200,"{\"ok\":true}");return;}}
  if(serviceId==cookiesServiceId){let u=parseUrl(jsonField(payload,"url"));if(method=="header"&&u.valid){OsService.respondJson(requestId,200,"{\"ok\":true,\"cookie\":\""+jsonEscapeText(cookieHeader(u))+"\"}");return;}if(method=="clear"){cookies.length=0;OsService.respondJson(requestId,200,"{\"ok\":true}");return;}}
  if(serviceId==rendererServiceId&&method=="status"){OsService.respondJson(requestId,200,tabsJson());return;}
  if(serviceId==websocketServiceId){if(method=="open"){let url=jsonField(payload,"url");if(!tabs.length||url.length==0){OsService.respondJson(requestId,400,"{\"ok\":false,\"error\":\"url required\"}");return;}let id=nextServiceWebSocketId++;openRendererWebSocket(tabNow(),-1,id,url,jsonField(payload,"protocols"),requestId);return;}let id=jsonIntValue(payload,"socketId"),w=webSocketById(-1,id);if(w==null){OsService.respondJson(requestId,404,"{\"ok\":false,\"error\":\"socket not found\"}");return;}if(method=="send"){let body=base64Decode(jsonField(payload,"bodyBase64")),binary=jsonIntValue(payload,"binary")!=0;if(webSocketWrite(w,binary?2:1,body))OsService.respondJson(requestId,202,"{\"ok\":true,\"accepted\":true}");else OsService.respondJson(requestId,409,"{\"ok\":false,\"error\":\"socket not open\"}");return;}if(method=="close"){let code=jsonIntValue(payload,"code");if(code==0)code=1000;let reason=jsonField(payload,"reason"),rb=utf8Bytes(reason),frame=new Uint8Array(2+rb.length);frame[0]=<u8>(code>>8);frame[1]=<u8>code;if(rb.length)memory.copy(frame.dataStart+2,rb.dataStart,<usize>rb.length);if(webSocketWrite(w,8,frame)){w.state=2;w.closeStarted=now_ms();OsService.respondJson(requestId,202,"{\"ok\":true,\"accepted\":true}");}else OsService.respondJson(requestId,409,"{\"ok\":false,\"error\":\"close failed\"}");return;}}
  OsService.respondJson(requestId,404,"{\"ok\":false,\"error\":\"unknown method\"}");
}
export function serviceCancelled(requestId:i32,reason:i32):void{for(let i:i32=resourceRequests.length-1;i>=0;i--){let req=resourceRequests[i];if(req.isServiceRequest&&req.serviceRequestId==requestId){req.serviceRequestId=0;removeResourceRequest(req);return;}}for(let i:i32=webSocketChannels.length-1;i>=0;i--){let w=webSocketChannels[i];if(w.serviceRequestId==requestId){w.serviceRequestId=0;webSocketRemove(w,1001,"service request cancelled",true);return;}}}

function publishService(name:string,version:string,summary:string,methods:string):i32{let id=OsService.register(name,version,1);if(id>=0){OsService.manifest(id,"{\"schema\":\"wasmos.service.manifest/1\",\"owner\":\"wasmos.system.browser\",\"summary\":\""+jsonEscapeText(summary)+"\",\"networkOwner\":\"wasm\",\"lifecycle\":\"dynamic-runtime\"}");OsService.contract(id,"{\"schema\":\"wasmos.service/1\",\"service\":\""+name+"\",\"version\":\""+version+"\",\"summary\":\""+jsonEscapeText(summary)+"\",\"methods\":"+methods+",\"access\":{\"visibility\":\"public\",\"allowApps\":[],\"denyApps\":[]}}");}return id;}
function publishSystemContract():void{
  let io="\"input\":{\"contentType\":\"application/json\"},\"output\":{\"contentType\":\"application/json\"}";
  browserServiceId=publishService("os.browser.engine","4.0.0","Packet-owned browser orchestration and navigation","[{\"name\":\"health\","+io+"},{\"name\":\"navigate\","+io+"},{\"name\":\"newTab\","+io+"},{\"name\":\"tabs\","+io+"}]");
  urlServiceId=publishService("os.url","1.0.0","URL parsing, resolution, HTTPS completion and search fallback","[{\"name\":\"health\","+io+"},{\"name\":\"normalize\","+io+"},{\"name\":\"resolve\","+io+"}]");
  originServiceId=publishService("os.origin.policy","1.0.0","Origin comparison and browser CORS policy primitives","[{\"name\":\"health\","+io+"},{\"name\":\"sameOrigin\","+io+"}]");
  httpServiceId=publishService("os.http.client","2.0.0","WASM-owned HTTP/1.1 and pooled HTTP/2 client over raw transport","[{\"name\":\"health\","+io+"},{\"name\":\"fetch\","+io+",\"stream\":{\"contentType\":\"application/json\",\"backpressure\":true}}]");
  tlsServiceId=publishService("os.tls.client","2.0.0","TLS 1.3, X.509 path, AIA, OCSP, CRL, CT, resumption and KeyUpdate telemetry", "[{\"name\":\"health\","+io+"},{\"name\":\"sessions\","+io+"}]");
  resourceServiceId=publishService("os.web.resource","1.0.0","Parallel packet-owned web resource retrieval", "[{\"name\":\"health\","+io+"},{\"name\":\"fetch\","+io+",\"stream\":{\"contentType\":\"application/json\",\"backpressure\":true}}]");
  tabsServiceId=publishService("os.browser.tabs","1.0.0","Browser tab lifecycle and navigation", "[{\"name\":\"health\","+io+"},{\"name\":\"list\","+io+"},{\"name\":\"navigate\","+io+"},{\"name\":\"newTab\","+io+"}]");
  bookmarksServiceId=publishService("os.browser.bookmarks","1.0.0","Persistent bookmark catalog", "[{\"name\":\"health\","+io+"},{\"name\":\"list\","+io+"},{\"name\":\"add\","+io+"},{\"name\":\"remove\","+io+"}]");
  cookiesServiceId=publishService("os.cookie.jar","1.0.0","WASM-owned HTTP cookie jar", "[{\"name\":\"health\","+io+"},{\"name\":\"header\","+io+"},{\"name\":\"clear\","+io+"}]");
  rendererServiceId=publishService("os.web.renderer","2.0.0","Isolated native-origin Chromium renderer with WASM-routed network", "[{\"name\":\"health\","+io+"},{\"name\":\"status\","+io+"}]");
  websocketServiceId=publishService("os.websocket.client","1.0.0","WASM-owned RFC 6455 client with Service Fabric events", "[{\"name\":\"health\","+io+"},{\"name\":\"open\","+io+",\"events\":[\"socket.*\"]},{\"name\":\"send\","+io+"},{\"name\":\"close\","+io+"}]");
}
function publishFinalAppManifest():void{OsApp.publishManifest("{\"schema\":\"wasmos.app/1\",\"id\":\"wasmos.system.browser\",\"name\":\"Browser\",\"version\":\"6.0.0\",\"kind\":\"application\",\"role\":\"Packet-owned browser and reusable web platform provider\",\"summary\":\"WASM owns TLS 1.3, X.509, HTTP/1.1, pooled HTTP/2, CORS, resources and RFC 6455; Tauri supplies networkless native origin partitions and Chromium rendering.\",\"permissions\":{\"required\":[{\"name\":\"network.raw\",\"scopes\":{\"hosts\":[\"*\"],\"ports\":[80,443]}},{\"name\":\"crypto.primitives\"},{\"name\":\"service.publish\"}],\"optional\":[\"download\"]},\"provides\":{\"atoms\":[\"web.open\",\"http2.pool.multiplexed\",\"web.origin.cors\",\"web.renderer.native-origin\",\"web.storage.origin-persistent\",\"web.service-worker\",\"websocket.rfc6455.packet-owned\"],\"services\":[{\"name\":\"os.browser.engine\",\"version\":\"4.0.0\"},{\"name\":\"os.url\",\"version\":\"1.0.0\"},{\"name\":\"os.origin.policy\",\"version\":\"1.0.0\"},{\"name\":\"os.http.client\",\"version\":\"2.0.0\"},{\"name\":\"os.tls.client\",\"version\":\"2.0.0\"},{\"name\":\"os.web.resource\",\"version\":\"1.0.0\"},{\"name\":\"os.browser.tabs\",\"version\":\"1.0.0\"},{\"name\":\"os.browser.bookmarks\",\"version\":\"1.0.0\"},{\"name\":\"os.cookie.jar\",\"version\":\"1.0.0\"},{\"name\":\"os.web.renderer\",\"version\":\"2.0.0\"},{\"name\":\"os.websocket.client\",\"version\":\"1.0.0\"}]},\"limitations\":[\"WebTransport unavailable until a WASM QUIC stack exists\",\"WebRTC unavailable until WASM ICE, DTLS, SRTP, SCTP and media pipelines exist\"],\"requires\":{\"services\":[]},\"ui\":{\"headless\":false,\"settings\":true},\"lifecycle\":{\"restart\":\"on-failure\"}}");}

export function appInit(w:i32,h:i32,dpr:f64):void{}
export function appStart():void{
  let wt=String.UTF8.encode("Browser");host_set_window_title(changetype<usize>(wt),wt.byteLength);loadBookmarks();
  transportMask=host_net_transport_capabilities();refreshTransportInfo();OsApp.restartPolicy(1,3,60000);OsApp.health(1,0,"Browser TLS 1.3 booting");publishFinalAppManifest();publishSystemContract();addTab("");OsApp.health(1,0,"Browser TLS 1.3 ready");OsApp.ready(1);statusMessage=(transportMask&1)!=0?"Raw transport + packet-owned TLS 1.3 ready":"Raw transport unavailable in this host context";logLine("started; socket capabilities="+transportMask.toString()+" crypto="+host_crypto_capabilities().toString()+" roots="+host_trust_anchor_count().toString());
}
export function appStop():void{while(webSocketChannels.length){let w=webSocketChannels[webSocketChannels.length-1];webSocketRemove(w,1001,"browser stopping",true);}for(let i=0;i<tabs.length;i++){cancelPageResources(tabs[i]);if(tabs[i].socketId>=0)host_tcp_close(tabs[i].socketId);tlsRemove(tabs[i].id);}for(let i=resourceRequests.length-1;i>=0;i--)removeResourceRequest(resourceRequests[i]);}
export function focusChanged(focused:i32):void{}
export function visibilityChanged(visible:i32):void{}

// Deterministic, secret-free diagnostics for hardware/runtime validation.
export function browserDebugState():i32{return tabs.length?tabNow().state:PAGE_IDLE;}
export function browserDebugStatusCode():i32{return tabs.length?tabNow().statusCode:0;}
export function browserDebugTlsPhase():i32{if(!tabs.length)return 0;let c=tlsFind(tabNow().id);return c?c.phase:0;}
export function browserDebugTlsOp():i32{if(!tabs.length)return-1;let c=tlsFind(tabNow().id);return c?c.opId:-1;}
export function browserDebugTlsWireBytes():i32{if(!tabs.length)return 0;let c=tlsFind(tabNow().id);return c?c.wire.length:0;}
export function browserDebugTlsHandshakeBytes():i32{if(!tabs.length)return 0;let c=tlsFind(tabNow().id);return c?c.handshake.length:0;}
export function browserDebugTlsCerts():i32{if(!tabs.length)return 0;let c=tlsFind(tabNow().id);return c?c.certs.length:0;}
export function browserDebugTlsTrusted():i32{if(!tabs.length)return 0;let c=tlsFind(tabNow().id);return c&&c.chainTrusted?1:0;}
export function browserDebugTlsResumed():i32{if(!tabs.length)return 0;let c=tlsFind(tabNow().id);return c&&c.resumed?1:0;}
export function browserDebugSessionTickets():i32{return sessionTickets.length;}
export function browserDebugBodySize():i32{return tabs.length?tabNow().body.length:0;}
export function browserDebugDomNodes():i32{return tabs.length?tabNow().domNodeCount:0;}
export function browserDebugCssRules():i32{return tabs.length?tabNow().cssRuleCount:0;}
export function browserDebugScriptCount():i32{return tabs.length?tabNow().scriptCount:0;}
export function browserDebugParseErrors():i32{return tabs.length?tabNow().parseErrorCount:0;}
export function browserDebugTrustCache():i32{trustCachePrune();return trustCache.length;}
export function browserDebugRendererId():i32{return tabs.length?tabNow().rendererId:-1;}
export function browserDebugRendererCommitted():i32{return tabs.length&&tabNow().rendererCommitted?1:0;}
export function browserDebugWebSocketSelfTest():i32{let key="dGhlIHNhbXBsZSBub25jZQ==",accept=base64Encode(sha1(utf8Bytes(key+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));if(accept!="s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")return 0;let sample=utf8Bytes("RFC6455"),round=base64Decode(base64Encode(sample));return bytesEq(sample,round)?1:0;}
export function browserDebugOmniboxSelfTest():i32{
  let host=navigationUrl("example.com"),explicit=navigationUrl("http://example.com/path"),search=navigationUrl("modern browser test");
  if(!host.valid||host.raw!="https://example.com/")return 0;
  if(!explicit.valid||explicit.raw!="http://example.com/path")return 0;
  if(!search.valid||!search.raw.startsWith("https://www.google.com/search?q=modern+browser+test"))return 0;
  return 1;
}
export function browserDebugParserSelfTest():i32{
  let t=new BrowserTab();parseHtmlDocument(t,"<!doctype html><html><head><style>section .card{color:#ff0000;padding:4px 8px}#target{font-weight:700}</style></head><body><section><div id='target' class='card'><span>Hello</span></div></section></body></html>");
  let node=findNodeById(t.rootDom,"target");if(node==null)return 0;let parent=node.parent;if(parent==null||parent.tagName!="section")return 0;if(node.style.color!=rgba(255,0,0)||!node.style.isBold||node.style.paddingLeft!=8)return 0;return t.parseErrorCount==0?1:0;
}
let browserDebugErrorBuffer:ArrayBuffer=new ArrayBuffer(0);
export function browserDebugErrorPtr():i32{browserDebugErrorBuffer=String.UTF8.encode(tabs.length?tabNow().error:"");return <i32>changetype<usize>(browserDebugErrorBuffer);}
export function browserDebugErrorSize():i32{return browserDebugErrorBuffer.byteLength;}
