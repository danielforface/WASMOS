/* This bootstrap is serialized into an opaque iframe. All privileged operations use its private port. */
function packagePanelClient(){
  let port,resolvePort,seq=0;const ready=new Promise(r=>resolvePort=r),waiting=new Map(),handlers=new Map();
  const api={
    async call(op,value){await ready;return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{waiting.delete(id);reject(Error('Host request timed out'));},20000);
      waiting.set(id,{resolve,reject,timer});port.postMessage({id,op,value});});},
    async provide(name,fn){handlers.set(name,fn);await api.call('publish',name);},
    ready
  };
  Object.defineProperty(globalThis,'wasmos',{value:Object.freeze(api)});
  function attach(e){if(e.source!==parent||e.data!=='wasmos.package.port/1'||e.ports.length!==1)return;
    removeEventListener('message',attach);port=e.ports[0];port.onmessage=async({data})=>{
      if(data.kind==='media'){dispatchEvent(new CustomEvent('package-media',{detail:data}));return;}
      if(data.kind==='request'){try{const fn=handlers.get(data.name);if(!fn)throw Error('service unavailable');const value=await fn(data.method,data.payload);port.postMessage({op:'respond',value:{request:data.request,status:200,body:value}});}
        catch(e){port.postMessage({op:'respond',value:{request:data.request,status:400,body:{ok:false,error:e.message}}});}return;}
      const p=waiting.get(data.id);if(!p)return;waiting.delete(data.id);clearTimeout(p.timer);if(data.error)p.reject(Error(data.error));else p.resolve(data.value);
    };port.start();resolvePort();}
  addEventListener('message',attach);
}
function openPackagePanel(r){
  const grants=new Set(r.capabilities),published=new Map(),channel=new MessageChannel(),port=channel.port1;
  const session={id:'package-panel-'+r.id,running:false,tab:{name:r.name,osAppId:r.id},safeCall(method,args){
    if(method!=='serviceRequest')return;const q=GLOBAL_APP_SERVICE_FABRIC.requests.get(args[0]);if(!q || q.provider!==session)return;
    try{if(q.payload.length>65536)throw Error('request too large');const m=packageText(q.method);if(!r.services.find(s=>s.name===q.name)?.methods.includes(m))throw Error('unknown method');
      port.postMessage({kind:'request',name:q.name,method:m,payload:q.payload.length?JSON.parse(packageText(q.payload)):{},request:q.id});
    }catch(e){GLOBAL_APP_SERVICE_FABRIC.respond(session,q.id,400,osUtf8({ok:false,error:e.message}));}
  }};
  let closed=false,loaded=false,stream=null,recorder=null,preview=null,interval=0,prompting=false,epoch=0,mediaType='';
  function stopMedia(){epoch++;clearInterval(interval);if(recorder?.state==='recording')recorder.stop();for(const track of stream?.getTracks()||[])track.stop();if(preview){preview.pause();preview.srcObject=null;}preview=null;stream=null;mediaType='';}
  const win=new FloatingWindow('pkg:'+r.id,r.name,'<div data-host-controls></div><div data-frame-area style="height:92%"></div>',{width:800,height:570,onClose(){
    closed=true;session.running=false;stopMedia();GLOBAL_APP_SERVICE_FABRIC.cleanupSession(session);for(const id of published.values())OS_SERVICE_CONTRACTS.contracts.delete(id);port.close();channel.port2.close();packagePanels.delete(r.id);renderDesktopIcons();
  }});
  const controls=win.element.querySelector('[data-host-controls]');
  async function startMedia(type){
    if(closed||prompting)return;stopMedia();const current=epoch;prompting=true;
    try{const input=await navigator.mediaDevices.getUserMedia({video:type==='camera',audio:type==='microphone'});
      if(closed||epoch!==current){input.getTracks().forEach(t=>t.stop());return;}stream=input;mediaType=type;
      if(type==='camera'){const video=document.createElement('video');preview=video;video.muted=true;video.playsInline=true;video.srcObject=input;await video.play();const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');let busy=false;
        interval=setInterval(()=>{if(busy||closed||current!==epoch)return;busy=true;ctx.drawImage(video,0,0,640,360);canvas.toBlob(blob=>{busy=false;if(!closed&&current===epoch&&blob)port.postMessage({kind:'media',type:'frame',blob});},'image/jpeg',0.75);},150);
      }else{const rec=new MediaRecorder(input),chunks=[];let total=0;recorder=rec;rec.ondataavailable=e=>{if(total<16*1024*1024 && e.data.size){chunks.push(e.data);total+=e.data.size;}if(total>=16*1024*1024&&rec.state==='recording')stopMedia();};
        rec.onstop=()=>{if(!closed)port.postMessage({kind:'media',type:'audio',blob:new Blob(chunks,{type:rec.mimeType})});};rec.start(1000);}
    }catch(e){stopMedia();packageProblem(e);}finally{prompting=false;}
  }
  for(const [cap,label] of [['camera','הפעל מצלמה'],['microphone','התחל הקלטה']])if(grants.has(cap)){
    const b=pkgButton(label,()=>startMedia(cap));controls.append(b,pkgButton('עצור',stopMedia));}
  function requireCap(c){if(!grants.has(c))throw Error('Capability not granted: '+c);}
  port.onmessage=async({data:d})=>{if(closed||!d||typeof d.op!=='string')return;
    try{let value=null;switch(d.op){
      case 'graph':requireCap('graph');value=OS_SYSTEM_GRAPH.snapshot();break;
      case 'files':requireCap('files');value=[...GLOBAL_SHARED_VFS.entries()].filter(([p])=>p==='/shared'||p.startsWith('/shared/')).slice(0,2048).map(([path,n])=>({path,kind:n.type||'file',bytes:n.data?.length||0}));break;
      case 'manage':{
        requireCap('manage');const target=d.value?.id,action=d.value?.action;
        const t=fileTabs.find(t=>t.osAppId===target && t.osManifest?.kind==='microservice'),live=t&&sessionByTab.get(t.id);
        if(!live?.running)throw Error('No running microservice with that ID');
        if(action==='remove'&&officialTabs.has(t.id)){value=await removeRepoPackage(officialTabs.get(t.id).id);break;}
        if(action==='remove'){uninstallMicroserviceWithImpact(live);value=!fileTabs.includes(t);break;}
        if(action!=='stop')throw Error('Unknown management operation');
        if(confirm('לעצור את '+t.name+' ואת השירותים שהוא מספק?')){live.stop('user requested stop');value=true;}break;
      }
      case 'publish':{requireCap('service');const def=r.services.find(s=>s.name===d.value);if(!def)throw Error('Undeclared service');if(!published.has(def.name)){
        const sid=GLOBAL_APP_SERVICE_FABRIC.register(session,def.name,def.version,1);published.set(def.name,sid);const contract={schema:WASM_OS_SERVICE_CONTRACT_SCHEMA,service:def.name,version:def.version,methods:def.methods.map(name=>({name,input:{contentType:'application/json'},output:{contentType:'application/json'}}))};
        OS_SERVICE_CONTRACTS.contracts.set(sid,contract);GLOBAL_APP_SERVICE_FABRIC.setManifest(session,sid,osUtf8(contract));}value=true;break;}
      case 'respond':{requireCap('service');const v=d.value,q=GLOBAL_APP_SERVICE_FABRIC.requests.get(v?.request);if(!q||q.provider!==session)throw Error('Wrong service recipient');
        const buf=osUtf8(v.body);if(buf.length>65536)throw Error('Response too large');GLOBAL_APP_SERVICE_FABRIC.respond(session,q.id,v.status===200?200:400,buf);return;}
      default:throw Error('Unknown operation');
    }port.postMessage({id:d.id,value});}catch(e){port.postMessage({id:d.id,error:String(e.message)});}
  };
  const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';frame.title=r.name;
  frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'");frame.style.cssText='border:0;width:100%;height:100%;background:#101925';
  const csp="default-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; connect-src 'none'; script-src 'unsafe-inline'"+(grants.has('wasm')?" 'wasm-unsafe-eval'":"")+"; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:;";
  frame.addEventListener('load',()=>{if(closed)return;if(loaded){win.close();return;}loaded=true;session.running=true;frame.contentWindow.postMessage('wasmos.package.port/1','*',[channel.port2]);renderDesktopIcons();});
  frame.srcdoc='<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+csp+'"><meta name="viewport" content="width=device-width"><style>html{color-scheme:dark}body{margin:1rem;background:#101925;color:#e5edf5;font:15px system-ui}button,input,select{font:inherit;padding:.5rem;margin:.2rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}img,video{max-width:100%}section{margin:1rem 0}</style><script>('+packagePanelClient.toString()+')();<'+ '/script>'+packageText(r.payload);
  packagePanels.set(r.id,{window:win,session});win.element.querySelector('[data-frame-area]').append(frame);
}
