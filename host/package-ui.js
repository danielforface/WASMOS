/* Lives inside the shell closure; UI inputs are never used as repository URLs. */
const packageManager=new OfficialPackageStore(),officialTabs=new Map(),packagePanels=new Map(),pendingPackageOpen=new Map();
let packageStartup=null,packageStatus='',packageBusy=0;
function packageDisplayMetadata(r){return {id:r.id,name:r.name,version:r.version,group:r.group,format:r.format,revision:r.revision};}
function packageGraphNodes(){
  return packageManager.list().filter(r=>!fileTabs.some(t=>officialTabs.get(t.id)?.id===r.id)).map(r=>{
    const panel=packagePanels.get(r.id);return {appId:r.id,name:r.name,kind:'application',role:r.group,version:r.version,running:!!panel?.session.running,ready:panel?.session.running?1:0,services:panel?[...GLOBAL_APP_SERVICE_FABRIC.services.values()].filter(s=>s.session===panel.session).map(s=>({name:s.name,version:s.version})):[]};
  });
}
function initRepoPackages(){if(!packageStartup)packageStartup=packageManager.restore().then(w=>{if(w.length)packageStatus=w.join('; ');renderDesktopIcons();}).catch(e=>{packageStatus='אחסון ההתקנות אינו זמין: '+e.message;renderDesktopIcons();packageStartup=null;throw e;});return packageStartup;}
function pkgNode(tag,label,cls=''){const el=document.createElement(tag);if(label!==undefined)el.textContent=label;if(cls)el.className=cls;return el;}
function pkgButton(label,action){const b=pkgNode('button',label,'px-3 py-2 rounded border border-slate-700 bg-slate-900 text-cyan-300 hover:bg-slate-800 text-xs');b.type='button';b.onclick=()=>Promise.resolve().then(action).catch(packageProblem);return b;}
function packageProblem(e){packageStatus='לא הושלם: '+(e?.message||e);logConsole(packageStatus,'error');renderDesktopIcons();}
async function packageAction(label,op){await initRepoPackages();packageBusy++;packageStatus=label;renderDesktopIcons();try{return await op();}finally{packageBusy--;renderDesktopIcons();}}
async function installRepoBase(){return packageAction('טוען את חבילת הבסיס מהריפו…',async()=>{const n=await packageManager.installBase();packageStatus='חבילת הבסיס מוכנה · '+n+' יישומים';return n;});}
function renderPackageDesktop(){
  const grid=document.getElementById('desktopIconsGrid');if(!grid)return;
  let bar=document.getElementById('package-desktop-bar');if(!bar){bar=pkgNode('div',undefined,'flex flex-wrap gap-2 mb-2 items-center');bar.id='package-desktop-bar';grid.before(bar);}
  const records=packageManager.list();
  for(const el of [bar,...document.querySelectorAll('[data-package-controls]')]){
    const base=pkgButton(records.some(p=>p.group==='base')?'טעינה / עדכון יישומי הבסיס':'טעינת יישומי הבסיס מהריפו',installRepoBase),extras=pkgButton('התקנת יישומים נוספים',browseRepoExtras);base.dataset.installBase='';extras.dataset.browseExtras='';base.disabled=extras.disabled=!!packageBusy;
    const status=pkgNode('span',packageStatus,'text-xs text-slate-400');status.setAttribute('role','status');el.replaceChildren(base,extras,status);
  }
  for(const p of records){
    const tile=pkgNode('div',undefined,'os-desktop-icon group');tile.dataset.packageId=p.id;
    const open=pkgButton(p.name,()=>openRepoPackage(p.id));open.title=p.name+' · '+p.version;
    const remove=pkgButton('הסרה',()=>removeRepoPackage(p.id));remove.setAttribute('aria-label','הסרה: '+p.name);
    tile.append(open,pkgNode('small',(p.group==='base'?'בסיס':'תוספת')+' · '+p.version,'text-slate-400'),remove);grid.append(tile);
  }
  const badge=document.getElementById('desktopAppCount');if(badge)badge.textContent=(records.length+fileTabs.filter(t=>!officialTabs.has(t.id)).length)+' APPS';
}
async function browseRepoExtras(){
  await initRepoPackages();const key='official-extras',ex=floatingWindows.get(key);if(ex){ex.bringToFront();return;}
  const w=new FloatingWindow(key,'התקנת יישומים נוספים','<div data-catalog-list class="p-4 space-y-3 overflow-auto h-full"></div>',{width:560,height:560});
  const box=w.element.querySelector('[data-catalog-list]');
  async function refresh(){box.replaceChildren(pkgNode('p','קורא קטלוג רשמי…'));try{
    const snap=await packageManager.catalog(),selected=new Set(),form=pkgNode('div',undefined,'grid gap-2');
    for(const r of snap.entries.filter(x=>x.group==='extra')){
      const label=pkgNode('label',undefined,'flex gap-2 items-center'),check=pkgNode('input');check.type='checkbox';check.value=r.id;
      const local=packageManager.records.get(r.id);check.disabled=!!local && local.sha256===r.sha256 && local.version===r.version && JSON.stringify(local.capabilities)===JSON.stringify(r.capabilities) && JSON.stringify(local.services)===JSON.stringify(r.services);
      check.onchange=()=>{if(check.checked)selected.add(r.id);else selected.delete(r.id);submit.disabled=!selected.size;};
      label.append(check,pkgNode('span',r.name+' · '+r.version+(check.disabled?' · מותקן':'')));form.append(label);
    }
    const submit=pkgButton('התקנת הבחירה',async()=>{submit.disabled=true;try{await packageAction('מתקין את הבחירה…',async()=>{const n=await packageManager.installExtras([...selected],snap.revision);packageStatus='הותקנו '+n+' יישומים נוספים';});w.close();}catch(e){packageProblem(e);box.replaceChildren(pkgNode('p',e.message),pkgButton('רענון הקטלוג',refresh));}});submit.disabled=true;
    box.replaceChildren(pkgNode('p','בחר רק את היישומים שברצונך להוסיף. מקור: WASMOS · '+snap.revision.slice(0,9)),form,submit);
  }catch(e){box.replaceChildren(pkgNode('p','הקטלוג אינו זמין. ההתקנה הקיימת לא השתנתה. '+e.message),pkgButton('ניסיון נוסף',refresh));}}
  await refresh();
}
async function openRepoPackage(id){
  await initRepoPackages();const r=packageManager.records.get(id);if(!r)throw Error('Package not installed');
  if(pendingPackageOpen.has(id))return pendingPackageOpen.get(id);
  const task=(async()=>{
    if(r.format==='panel'){const active=packagePanels.get(id);if(active){active.window.bringToFront();return;}return openPackagePanel(r);}
    let tab=fileTabs.find(t=>officialTabs.get(t.id)?.id===id),session=tab&&sessionByTab.get(tab.id);
    if(tab)ensureTabContentSaved(tab);
    if(tab && (officialTabs.get(tab.id).digest!==r.sha256 || (tab.kind==='source'&&tab.content!==officialTabs.get(tab.id).original))){detachPackageTab(tab);tab=null;session=null;}
    if(session?.running){if(session.window?.isMinimized)session.window.toggleMinimize();session.window?.bringToFront();return;}
    if(!tab){tab=createTabRecord({name:r.slug+(r.format==='wasm'?'.wasm':'.ts'),kind:r.format==='wasm'?'binary':'source',content:r.format==='assemblyscript'?stripAutoSdk(packageText(r.payload)):'',binary:r.format==='wasm'?r.payload.slice():null});
      tab.osAppId=r.id;tab.osInstallMeta={source:'official-repository',installedAt:Date.now(),revision:r.revision};fileTabs.push(tab);officialTabs.set(tab.id,{id,digest:r.sha256,original:tab.content});renderTabs();renderDesktopIcons();}
    const binary=await compileTab(tab,{log:true});
    if(packageManager.records.get(id)?.sha256!==r.sha256||!fileTabs.includes(tab))return;
    const runtime=new RuntimeSession(tab,binary,tab.content);await runtime.launch();if(packageManager.records.get(id)?.sha256!==r.sha256||!fileTabs.includes(tab))runtime.stop('package changed');renderDesktopIcons();
  })();pendingPackageOpen.set(id,task);try{return await task;}finally{pendingPackageOpen.delete(id);}
}
function detachPackageTab(tab){
  ensureTabContentSaved(tab);const original=officialTabs.get(tab.id);officialTabs.delete(tab.id);
  if(tab.kind==='source' && tab.content!==original?.original){sessionByTab.get(tab.id)?.stop('detached local edit');tab.osAppId='wasmos.local.'+crypto.randomUUID();tab.osInstallMeta={source:'local',trust:'user'};tab.name=tab.name.replace(/\.ts$/,'-local.ts');}
  else closeTab(tab.id);
}
async function removeRepoPackage(id){
  await initRepoPackages();const p=packageManager.records.get(id);if(!p)return;
  if(!confirm('להסיר את '+p.name+'? נתוני המשתמש לא יימחקו.'))return false;
  await packageManager.remove(id);packagePanels.get(id)?.window.close();
  for(const t of [...fileTabs])if(officialTabs.get(t.id)?.id===id)detachPackageTab(t);
  packageStatus='הוסר: '+p.name;renderDesktopIcons();return true;
}
