import * as loader from "@assemblyscript/loader";
import "./style.css";

type Kind = "file" | "dir";
interface VItem {
  path: string;
  name: string;
  parent: string;
  kind: Kind;
  mime: string;
  size: number;
  created: number;
  modified: number;
  deletedFrom: string;
}
interface Stats { files:number; dirs:number; bytes:number; trash:number; undo:number; redo:number; }
interface SnapshotInfo { index:number; name:string; nodes:number; }

const app = document.querySelector<HTMLDivElement>("#app")!;

const wasmResult = await loader.instantiateStreaming(fetch("/vfs.wasm"), {});
const w = wasmResult.exports as any;
const sp = (value: string) => w.__newString(value);
const gs = (ptr: number) => w.__getString(ptr) as string;
const strCall = (name: string, ...args: Array<string|number>) => {
  const native = args.map(v => typeof v === "string" ? sp(v) : v);
  return gs(w[name](...native));
};
const numCall = (name: string, ...args: Array<string|number>) => {
  const native = args.map(v => typeof v === "string" ? sp(v) : v);
  return Number(w[name](...native));
};
const jsonCall = <T,>(name: string, ...args: Array<string|number>): T => JSON.parse(strCall(name, ...args));

w.initVfs();

const vfs = {
  current: () => strCall("getCurrentPath"),
  cd: (path:string) => !!numCall("cd", path),
  list: (path:string) => jsonCall<VItem[]>("list", path),
  listTrash: () => jsonCall<VItem[]>("listTrash"),
  stat: (path:string) => JSON.parse(strCall("stat", path)) as VItem | null,
  mkdir: (parent:string,name:string) => !!numCall("mkdir", parent,name),
  createFile: (parent:string,name:string,text="") => !!numCall("createFile", parent,name,text),
  readText: (path:string) => strCall("readText", path),
  writeText: (path:string,text:string) => !!numCall("writeText", path,text),
  rename: (path:string,name:string) => strCall("rename", path,name),
  copy: (paths:string[]) => numCall("copySelection", paths.join("\n")),
  cut: (paths:string[]) => numCall("cutSelection", paths.join("\n")),
  paste: (dest:string) => numCall("paste", dest),
  move: (paths:string[], dest:string) => numCall("move", paths.join("\n"), dest),
  trash: (paths:string[]) => numCall("deleteToTrash", paths.join("\n")),
  restore: (paths:string[]) => numCall("restoreTrash", paths.join("\n")),
  permanentDelete: (paths:string[]) => numCall("deletePermanent", paths.join("\n")),
  emptyTrash: () => numCall("emptyTrash"),
  search: (q:string,scope:string) => jsonCall<VItem[]>("search", q,scope),
  undo: () => !!numCall("undo"),
  redo: () => !!numCall("redo"),
  stats: () => jsonCall<Stats>("stats"),
  createSnapshot: (name:string) => numCall("createSnapshot", name),
  listSnapshots: () => jsonCall<SnapshotInfo[]>("listSnapshots"),
  restoreSnapshot: (i:number) => !!numCall("restoreNamedSnapshot", i),
  reset: () => !!numCall("resetDemo")
};

let path = vfs.current();
let trashMode = false;
let viewMode: "grid"|"list" = "grid";
let selection = new Set<string>();
let searchMode = false;
let searchResults: VItem[] = [];
let history = [path];
let historyIndex = 0;
let dragPaths: string[] = [];
let sortKey: "name"|"size"|"modified" = "name";
let sortDir: 1|-1 = 1;

const icons:Record<string,string> = {
  folder:`<svg viewBox="0 0 24 24"><path d="M3 6.5a2 2 0 0 1 2-2h5l2 2H19a2 2 0 0 1 2 2v8.8a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.3z"/></svg>`,
  file:`<svg viewBox="0 0 24 24"><path d="M6 2.8h8l4 4v14.4H6z"/><path class="stroke" d="M14 3v5h5"/></svg>`,
  code:`<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path class="stroke" d="m10 11-2 2 2 2m4-4 2 2-2 2m-1-5-2 6"/></svg>`,
  image:`<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path class="stroke" d="m5 17 5-5 4 4 2-2 3 3M15.5 9h.01"/></svg>`,
  audio:`<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>`,
  video:`<svg viewBox="0 0 24 24"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2z"/></svg>`,
  trash:`<svg viewBox="0 0 24 24"><path d="M7 7h10l-1 14H8z"/><path class="stroke" d="M5 7h14M9 7V4h6v3m-5 3v7m4-7v7"/></svg>`,
  home:`<svg viewBox="0 0 24 24"><path d="m3 11 9-8 9 8v10h-6v-6H9v6H3z"/></svg>`,
  disk:`<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path class="stroke" d="M7 9h10M7 14h4"/></svg>`
};

function iconFor(item:VItem){
  if(item.kind==="dir") return icons.folder;
  if(item.mime.startsWith("image/")) return icons.image;
  if(item.mime.startsWith("audio/")) return icons.audio;
  if(item.mime.startsWith("video/")) return icons.video;
  if(item.mime.includes("code") || /\.(ts|tsx|js|rs|c|cpp|json|html|css)$/i.test(item.name)) return icons.code;
  return icons.file;
}
function fmtBytes(n:number){
  if(n<1024) return `${n} B`;
  if(n<1024*1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(1)} MB`;
}
function fmtDate(n:number){ return new Date(n).toLocaleString([], {dateStyle:"medium", timeStyle:"short"}); }
function esc(s:string){ return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]!)); }
function parentOf(p:string){ if(p==="/") return "/"; const i=p.lastIndexOf("/"); return i<=0?"/":p.slice(0,i); }
function baseName(p:string){ return p==="/"?"/":p.slice(p.lastIndexOf("/")+1); }

app.innerHTML = `
<div class="aurora a1"></div><div class="aurora a2"></div><div class="aurora a3"></div>
<div class="shell">
  <header class="titlebar glass">
    <div class="brand"><div class="brand-orb"><span></span></div><div><strong>NEBULA</strong><small>WASM VIRTUAL DESKTOP</small></div></div>
    <div class="system-pills"><span id="memPill">WASM MEMORY</span><span class="live"><i></i> ENGINE LIVE</span></div>
    <div class="window-controls"><button>—</button><button>□</button><button>×</button></div>
  </header>

  <main class="workspace glass">
    <aside class="sidebar">
      <button class="new-primary" data-action="new-folder"><span>＋</span> New</button>
      <section><label>PLACES</label>
        <button class="nav-item" data-nav="/Home">${icons.home}<span>Home</span></button>
        <button class="nav-item" data-nav="/Home/Desktop">${icons.folder}<span>Desktop</span></button>
        <button class="nav-item" data-nav="/Home/Documents">${icons.folder}<span>Documents</span></button>
        <button class="nav-item" data-nav="/Home/Projects">${icons.folder}<span>Projects</span></button>
        <button class="nav-item" data-nav="/Home/Media">${icons.folder}<span>Media</span></button>
        <button class="nav-item" data-nav="/Home/Downloads">${icons.folder}<span>Downloads</span></button>
      </section>
      <section><label>SYSTEM</label>
        <button class="nav-item" data-nav="/System">${icons.disk}<span>System</span></button>
        <button class="nav-item" data-trash="1">${icons.trash}<span>Recycle Bin</span><b id="trashCount">0</b></button>
      </section>
      <div class="storage-card">
        <div class="storage-head"><span>Virtual volume</span><strong id="storageText">0 KB</strong></div>
        <div class="meter"><i id="storageMeter"></i></div>
        <small>WASM linear memory filesystem</small>
      </div>
    </aside>

    <section class="explorer">
      <div class="navrow">
        <div class="navcontrols">
          <button title="Back" data-action="back">←</button><button title="Forward" data-action="forward">→</button><button title="Up" data-action="up">↑</button><button title="Refresh" data-action="refresh">↻</button>
        </div>
        <div class="breadcrumbs" id="breadcrumbs"></div>
        <div class="searchbox"><span>⌕</span><input id="searchInput" placeholder="Search this virtual filesystem…"/><kbd>Ctrl K</kbd></div>
      </div>

      <div class="toolbar">
        <div class="toolgroup">
          <button data-action="new-folder">＋ Folder</button><button data-action="new-file">＋ File</button><i></i>
          <button data-action="cut">✂ Cut</button><button data-action="copy">▣ Copy</button><button data-action="paste">▤ Paste</button><i></i>
          <button data-action="rename">✎ Rename</button><button data-action="delete">⌫ Delete</button>
        </div>
        <div class="toolgroup right">
          <button data-action="undo">↶</button><button data-action="redo">↷</button>
          <button data-action="snapshot">◈ Snapshot</button>
          <button class="viewbtn active" data-view="grid">▦</button><button class="viewbtn" data-view="list">☷</button>
          <button data-action="palette">⌘</button>
        </div>
      </div>

      <div class="content-head"><div><h1 id="viewTitle">Documents</h1><p id="viewSubtitle"></p></div><div class="content-actions" id="contentActions"></div></div>
      <div id="fileArea" class="file-area grid"></div>
      <div id="emptyState" class="empty hidden"><div class="empty-orb">◇</div><h2>Nothing here</h2><p>Create a folder or file. Every item will exist inside WebAssembly memory.</p></div>
      <footer class="statusbar"><span id="statusLeft">Ready</span><span id="statusCenter"></span><span id="statusRight">NEBULA VFS 1.0</span></footer>
    </section>

    <aside class="inspector" id="inspector">
      <div class="inspector-idle"><div class="pulse-ring"><span>◇</span></div><h3>Inspector</h3><p>Select an item to inspect its live WASM inode metadata.</p></div>
    </aside>
  </main>
</div>
<div id="contextMenu" class="context-menu hidden"></div>
<div id="toastStack" class="toast-stack"></div>
<div id="modalRoot"></div>
<div id="palette" class="palette-overlay hidden">
  <div class="palette-card glass"><div class="palette-search"><span>⌘</span><input id="paletteInput" placeholder="Command or path…"/><kbd>Esc</kbd></div><div id="paletteResults" class="palette-results"></div><div class="terminal-line"><span>vfs ›</span><input id="terminalInput" placeholder="mkdir name · touch file.txt · cd /Home · snapshot name"/></div></div>
</div>`;

const $ = <T extends Element>(s:string) => document.querySelector<T>(s)!;
const fileArea = $("#fileArea") as HTMLDivElement;
const emptyState = $("#emptyState") as HTMLDivElement;
const searchInput = $("#searchInput") as HTMLInputElement;

function currentItems(){
  let items = searchMode ? [...searchResults] : trashMode ? vfs.listTrash() : vfs.list(path);
  items.sort((a,b)=>{
    if(sortKey==="name"){
      if(a.kind!==b.kind) return a.kind==="dir"?-1:1;
      return a.name.localeCompare(b.name)*sortDir;
    }
    return ((a[sortKey] as number)-(b[sortKey] as number))*sortDir;
  });
  return items;
}

function breadcrumbHtml(){
  if(trashMode) return `<button data-crumb="trash">${icons.trash}<span>Recycle Bin</span></button>`;
  const parts=path.split("/").filter(Boolean); let acc="";
  let html=`<button data-crumb="/">◇<span>Root</span></button>`;
  for(const p of parts){ acc += "/"+p; html += `<em>›</em><button data-crumb="${esc(acc)}"><span>${esc(p)}</span></button>`; }
  return html;
}

function render(){
  const items=currentItems();
  $("#breadcrumbs").innerHTML=breadcrumbHtml();
  $("#viewTitle").textContent = searchMode ? `Search: ${searchInput.value}` : trashMode ? "Recycle Bin" : baseName(path)==="/"?"Root":baseName(path);
  $("#viewSubtitle").textContent = searchMode ? `${items.length} matches across ${path}` : trashMode ? "Deleted items remain recoverable until permanently removed." : `${items.length} items · live in WASM memory`;
  fileArea.className=`file-area ${viewMode}`;
  fileArea.innerHTML = items.map(item=>viewMode==="grid"?gridCard(item):listRow(item)).join("");
  emptyState.classList.toggle("hidden",items.length>0);
  fileArea.classList.toggle("hidden",items.length===0);
  document.querySelectorAll(".viewbtn").forEach(b=>b.classList.toggle("active",(b as HTMLElement).dataset.view===viewMode));
  document.querySelectorAll(".nav-item").forEach(b=>{
    const e=b as HTMLElement;
    e.classList.toggle("active", (!trashMode && e.dataset.nav===path) || (trashMode && e.dataset.trash==="1"));
  });
  updateStatus(items);
  bindItems();
  renderInspector();
  renderContentActions();
}

function gridCard(item:VItem){
  const selected=selection.has(item.path);
  return `<article class="file-card ${selected?"selected":""}" draggable="true" data-path="${esc(item.path)}" data-kind="${item.kind}">
    <div class="select-dot">✓</div><div class="file-icon ${item.kind} ${item.mime.split("/")[0]}">${iconFor(item)}<i></i></div>
    <div class="file-meta"><strong title="${esc(item.name)}">${esc(item.name)}</strong><span>${item.kind==="dir"?`${item.size} nested items`:fmtBytes(item.size)}</span></div>
    <button class="more" data-more="${esc(item.path)}">•••</button>
  </article>`;
}

function listRow(item:VItem){
  return `<article class="file-row ${selection.has(item.path)?"selected":""}" draggable="true" data-path="${esc(item.path)}" data-kind="${item.kind}">
    <div class="row-name"><span class="mini-icon">${iconFor(item)}</span><strong>${esc(item.name)}</strong></div>
    <span>${item.kind==="dir"?"Folder":esc(item.mime)}</span><span>${item.kind==="dir"?"—":fmtBytes(item.size)}</span><span>${fmtDate(item.modified)}</span><button class="more" data-more="${esc(item.path)}">•••</button>
  </article>`;
}

function renderContentActions(){
  const box=$("#contentActions");
  if(trashMode){ box.innerHTML=`<button data-action="restore">↥ Restore</button><button class="danger" data-action="permanent-delete">Permanent delete</button><button data-action="empty-trash">Empty bin</button>`; }
  else if(searchMode){ box.innerHTML=`<button data-action="clear-search">× Clear search</button>`; }
  else box.innerHTML=`<button data-action="sort">⇅ ${sortKey}</button>`;
}

function updateStatus(items:VItem[]){
  const st=vfs.stats();
  $("#trashCount").textContent=String(st.trash);
  $("#storageText").textContent=fmtBytes(st.bytes);
  ($("#storageMeter") as HTMLElement).style.width=`${Math.min(100,Math.max(4,st.bytes/20000))}%`;
  $("#statusLeft").textContent = selection.size ? `${selection.size} selected` : `${items.length} items`;
  $("#statusCenter").textContent=`${st.files} files · ${st.dirs} folders · undo ${st.undo} / redo ${st.redo}`;
  const mem=(w.memory.buffer.byteLength/1024/1024).toFixed(1);
  $("#memPill").textContent=`${mem} MB WASM MEMORY`;
}

function renderInspector(){
  const box=$("#inspector");
  const p=[...selection][0];
  if(!p){ box.innerHTML=`<div class="inspector-idle"><div class="pulse-ring"><span>◇</span></div><h3>Inspector</h3><p>Select an item to inspect its live WASM inode metadata.</p></div>`; return; }
  const item=vfs.stat(p); if(!item) return;
  box.innerHTML=`<div class="inspect">
    <div class="inspect-hero"><div class="big-icon">${iconFor(item)}</div><h2>${esc(item.name)}</h2><span>${item.kind==="dir"?"Virtual directory":esc(item.mime)}</span></div>
    <div class="inspect-section"><label>LOCATION</label><code>${esc(item.path)}</code></div>
    <div class="inspect-grid"><div><label>SIZE</label><strong>${item.kind==="dir"?item.size+" descendants":fmtBytes(item.size)}</strong></div><div><label>TYPE</label><strong>${item.kind}</strong></div></div>
    <div class="inspect-section"><label>MODIFIED</label><strong>${fmtDate(item.modified)}</strong></div>
    <div class="inspect-section"><label>CREATED</label><strong>${fmtDate(item.created)}</strong></div>
    ${item.deletedFrom?`<div class="inspect-section"><label>ORIGINAL LOCATION</label><code>${esc(item.deletedFrom)}</code></div>`:""}
    <div class="inspect-actions"><button data-action="open">Open</button><button data-action="properties">Properties</button></div>
  </div>`;
}

function bindItems(){
  fileArea.querySelectorAll<HTMLElement>("[data-path]").forEach(el=>{
    const p=el.dataset.path!;
    el.addEventListener("click",e=>{
      if((e.target as HTMLElement).closest(".more")) return;
      if(!(e.ctrlKey||e.metaKey)) selection.clear();
      if(selection.has(p) && (e.ctrlKey||e.metaKey)) selection.delete(p); else selection.add(p);
      render();
    });
    el.addEventListener("dblclick",()=>openItem(p));
    el.addEventListener("contextmenu",e=>{e.preventDefault(); if(!selection.has(p)){selection.clear();selection.add(p);render();} showContext(e.clientX,e.clientY,p);});
    el.addEventListener("dragstart",e=>{ if(!selection.has(p)){selection.clear();selection.add(p);} dragPaths=[...selection]; e.dataTransfer?.setData("text/plain",dragPaths.join("\n")); el.classList.add("dragging"); });
    el.addEventListener("dragend",()=>el.classList.remove("dragging"));
    if(el.dataset.kind==="dir"){
      el.addEventListener("dragover",e=>{e.preventDefault();el.classList.add("drop-target")});
      el.addEventListener("dragleave",()=>el.classList.remove("drop-target"));
      el.addEventListener("drop",e=>{e.preventDefault();el.classList.remove("drop-target"); if(dragPaths.length){const moved=vfs.move(dragPaths,p); toast(`${moved} item${moved===1?"":"s"} moved`,"success"); selection.clear();render();}});
    }
  });
  fileArea.querySelectorAll<HTMLElement>("[data-more]").forEach(btn=>btn.addEventListener("click",e=>{e.stopPropagation();const r=btn.getBoundingClientRect();const p=btn.dataset.more!;if(!selection.has(p)){selection.clear();selection.add(p);render();}showContext(r.left,r.bottom+6,p);}));
}

function navigate(next:string,push=true){
  searchMode=false; searchInput.value=""; trashMode=false; selection.clear();
  if(!vfs.cd(next)){toast("Directory is unavailable","error");return;}
  path=vfs.current();
  if(push){history=history.slice(0,historyIndex+1);history.push(path);historyIndex=history.length-1;}
  render();
}
function openTrash(){trashMode=true;searchMode=false;selection.clear();searchInput.value="";render();}
function openItem(p:string){ const item=vfs.stat(p); if(!item)return; if(item.kind==="dir"){navigate(p);return;} editor(item); }

function showContext(x:number,y:number,p:string){
  const item=vfs.stat(p);if(!item)return;
  const menu=$("#contextMenu") as HTMLElement;
  const actions=trashMode?
    [["restore","↥","Restore"],["permanent-delete","⌫","Delete permanently"],["properties","ⓘ","Properties"]]:
    [["open","↗","Open"],["copy","▣","Copy"],["cut","✂","Cut"],["paste","▤","Paste here"],["rename","✎","Rename"],["delete","⌫","Move to Recycle Bin"],["properties","ⓘ","Properties"]];
  menu.innerHTML=actions.map(a=>`<button data-action="${a[0]}"><span>${a[1]}</span>${a[2]}</button>`).join("");
  menu.classList.remove("hidden");
  const mw=230,mh=actions.length*42+16; menu.style.left=Math.min(x,innerWidth-mw-12)+"px"; menu.style.top=Math.min(y,innerHeight-mh-12)+"px";
}
function hideContext(){ $("#contextMenu").classList.add("hidden"); }

document.addEventListener("click",e=>{ if(!(e.target as HTMLElement).closest("#contextMenu")) hideContext(); });

document.addEventListener("click",async e=>{
  const el=(e.target as HTMLElement).closest<HTMLElement>("[data-action]"); if(!el)return;
  const action=el.dataset.action!; hideContext(); await runAction(action);
});
document.addEventListener("click",e=>{ const el=(e.target as HTMLElement).closest<HTMLElement>("[data-nav]"); if(el)navigate(el.dataset.nav!); const tr=(e.target as HTMLElement).closest<HTMLElement>("[data-trash]");if(tr)openTrash(); const cr=(e.target as HTMLElement).closest<HTMLElement>("[data-crumb]");if(cr){const v=cr.dataset.crumb!;v==="trash"?openTrash():navigate(v);} });
document.addEventListener("click",e=>{const el=(e.target as HTMLElement).closest<HTMLElement>("[data-view]");if(el){viewMode=el.dataset.view as any;render();}});

async function runAction(action:string){
  const paths=[...selection];
  switch(action){
    case "new-folder": if(trashMode)return; {const name=await ask("New folder","Folder name","Untitled folder"); if(name){if(vfs.mkdir(path,name)){toast("Folder created","success");render();}else toast("Could not create folder","error");}} break;
    case "new-file": if(trashMode)return; {const name=await ask("New file","File name","untitled.txt"); if(name){if(vfs.createFile(path,name,"")){toast("File created","success");render();}else toast("Could not create file","error");}} break;
    case "open": if(paths[0])openItem(paths[0]); break;
    case "copy": if(paths.length){vfs.copy(paths);toast(`${paths.length} copied to virtual clipboard`);render();} break;
    case "cut": if(paths.length){vfs.cut(paths);toast(`${paths.length} cut to virtual clipboard`);render();} break;
    case "paste": if(!trashMode){const dest=paths.length===1&&vfs.stat(paths[0])?.kind==="dir"?paths[0]:path;const n=vfs.paste(dest);toast(n?`${n} item${n===1?"":"s"} pasted`:"Clipboard is empty",n?"success":"info");selection.clear();render();} break;
    case "rename": if(paths.length===1){const old=vfs.stat(paths[0])!;const name=await ask("Rename item","New name",old.name);if(name&&name!==old.name){const p=vfs.rename(old.path,name);if(p){selection=new Set([p]);toast("Renamed","success");render();}else toast("Rename failed","error");}} break;
    case "delete": if(paths.length){const ok=await confirmBox("Move to Recycle Bin?",`${paths.length} selected item${paths.length===1?"":"s"} will remain recoverable.`);if(ok){vfs.trash(paths);selection.clear();toast("Moved to Recycle Bin","success");render();}} break;
    case "restore": if(paths.length){const n=vfs.restore(paths);selection.clear();toast(`${n} restored`,`success`);render();} break;
    case "permanent-delete": if(paths.length){const ok=await confirmBox("Permanently delete?","This removes the selected virtual nodes and their contents. Undo can still recover the previous snapshot until history rolls over.");if(ok){vfs.permanentDelete(paths);selection.clear();toast("Permanently removed","success");render();}} break;
    case "empty-trash": {const ok=await confirmBox("Empty Recycle Bin?","All deleted virtual items will be removed.");if(ok){const n=vfs.emptyTrash();selection.clear();toast(`${n} items removed`,`success`);render();}} break;
    case "undo": if(vfs.undo()){path=vfs.current();selection.clear();toast("Undo complete");render();}else toast("Nothing to undo"); break;
    case "redo": if(vfs.redo()){path=vfs.current();selection.clear();toast("Redo complete");render();}else toast("Nothing to redo"); break;
    case "up": if(!trashMode)navigate(parentOf(path)); break;
    case "back": if(historyIndex>0){historyIndex--;navigate(history[historyIndex],false);} break;
    case "forward": if(historyIndex<history.length-1){historyIndex++;navigate(history[historyIndex],false);} break;
    case "refresh": render(); toast("View refreshed"); break;
    case "snapshot": snapshotsDialog(); break;
    case "properties": if(paths[0])properties(vfs.stat(paths[0])!); break;
    case "palette": openPalette(); break;
    case "clear-search": searchMode=false;searchInput.value="";selection.clear();render(); break;
    case "sort": {const next=sortKey==="name"?"modified":sortKey==="modified"?"size":"name";sortKey=next;render();} break;
  }
}

searchInput.addEventListener("input",()=>{
  const q=searchInput.value.trim();
  if(!q){searchMode=false;searchResults=[];render();return;}
  trashMode=false;searchMode=true;searchResults=vfs.search(q,path);selection.clear();render();
});

function modal(content:string){
  const root=$("#modalRoot"); root.innerHTML=`<div class="modal-backdrop"><div class="modal-card glass">${content}</div></div>`;
  return root;
}
function closeModal(){ $("#modalRoot").innerHTML=""; }
function ask(title:string,label:string,value=""):Promise<string|null>{
  return new Promise(resolve=>{
    const root=modal(`<div class="modal-head"><div><small>NEBULA VFS</small><h2>${esc(title)}</h2></div><button id="modalX">×</button></div><label class="field-label">${esc(label)}</label><input id="modalInput" class="modal-input" value="${esc(value)}"/><div class="modal-actions"><button id="modalCancel">Cancel</button><button id="modalOk" class="primary">Confirm</button></div>`);
    const input=root.querySelector<HTMLInputElement>("#modalInput")!;input.focus();input.select();
    const done=(v:string|null)=>{closeModal();resolve(v)};
    root.querySelector("#modalOk")!.addEventListener("click",()=>done(input.value.trim()||null));root.querySelector("#modalCancel")!.addEventListener("click",()=>done(null));root.querySelector("#modalX")!.addEventListener("click",()=>done(null));input.addEventListener("keydown",e=>{if(e.key==="Enter")done(input.value.trim()||null);if(e.key==="Escape")done(null)});
  });
}
function confirmBox(title:string,text:string):Promise<boolean>{
  return new Promise(resolve=>{
    const root=modal(`<div class="modal-head"><div><small>CONFIRM OPERATION</small><h2>${esc(title)}</h2></div></div><p class="modal-copy">${esc(text)}</p><div class="modal-actions"><button id="no">Cancel</button><button id="yes" class="danger-fill">Continue</button></div>`);
    const done=(v:boolean)=>{closeModal();resolve(v)};root.querySelector("#no")!.addEventListener("click",()=>done(false));root.querySelector("#yes")!.addEventListener("click",()=>done(true));
  });
}
function editor(item:VItem){
  const text=vfs.readText(item.path);
  const root=modal(`<div class="modal-head editor-head"><div><small>VIRTUAL FILE EDITOR</small><h2>${esc(item.name)}</h2><code>${esc(item.path)}</code></div><button id="modalX">×</button></div><div class="editor-toolbar"><span>${esc(item.mime)}</span><span>${fmtBytes(item.size)}</span><span>UTF-8 · WASM byte buffer</span></div><textarea id="editorText" class="editor-text" spellcheck="false"></textarea><div class="modal-actions"><button id="modalCancel">Close</button><button id="save" class="primary">Save to WASM</button></div>`);
  const ta=root.querySelector<HTMLTextAreaElement>("#editorText")!;ta.value=text;ta.focus();
  const save=()=>{vfs.writeText(item.path,ta.value);toast("File bytes written to WASM memory","success");closeModal();render();};
  root.querySelector("#save")!.addEventListener("click",save);root.querySelector("#modalCancel")!.addEventListener("click",closeModal);root.querySelector("#modalX")!.addEventListener("click",closeModal);ta.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="s"){e.preventDefault();save();}});
}
function properties(item:VItem){
  const root=modal(`<div class="modal-head"><div><small>LIVE INODE</small><h2>${esc(item.name)}</h2></div><button id="modalX">×</button></div><div class="property-hero"><div>${iconFor(item)}</div><section><strong>${esc(item.name)}</strong><span>${esc(item.mime)}</span></section></div><div class="property-table"><div><span>Path</span><code>${esc(item.path)}</code></div><div><span>Kind</span><strong>${item.kind}</strong></div><div><span>Size</span><strong>${item.kind==="dir"?item.size+" descendants":fmtBytes(item.size)}</strong></div><div><span>Created</span><strong>${fmtDate(item.created)}</strong></div><div><span>Modified</span><strong>${fmtDate(item.modified)}</strong></div>${item.deletedFrom?`<div><span>Deleted from</span><code>${esc(item.deletedFrom)}</code></div>`:""}</div><div class="modal-actions"><button id="ok" class="primary">Done</button></div>`);
  root.querySelector("#ok")!.addEventListener("click",closeModal);root.querySelector("#modalX")!.addEventListener("click",closeModal);
}
async function snapshotsDialog(){
  const snaps=vfs.listSnapshots();
  const root=modal(`<div class="modal-head"><div><small>TIME MACHINE</small><h2>Filesystem snapshots</h2></div><button id="modalX">×</button></div><div class="snapshot-create"><input id="snapName" placeholder="Snapshot name"/><button id="snapCreate" class="primary">Create snapshot</button></div><div class="snapshot-list">${snaps.length?snaps.map(s=>`<div class="snapshot-row"><div><span>◈</span><section><strong>${esc(s.name)}</strong><small>${s.nodes} virtual nodes captured</small></section></div><button data-snap="${s.index}">Restore</button></div>`).join(""):`<div class="snapshot-empty">No named snapshots yet.</div>`}</div>`);
  root.querySelector("#modalX")!.addEventListener("click",closeModal);
  root.querySelector("#snapCreate")!.addEventListener("click",()=>{const name=(root.querySelector<HTMLInputElement>("#snapName")!).value.trim()||"Checkpoint";vfs.createSnapshot(name);closeModal();toast("Snapshot captured","success");snapshotsDialog();});
  root.querySelectorAll<HTMLElement>("[data-snap]").forEach(b=>b.addEventListener("click",()=>{vfs.restoreSnapshot(Number(b.dataset.snap));path=vfs.current();selection.clear();closeModal();toast("Snapshot restored","success");render();}));
}

function toast(message:string,type:"info"|"success"|"error"="info"){
  const stack=$("#toastStack");const el=document.createElement("div");el.className=`toast ${type}`;el.innerHTML=`<span>${type==="success"?"✓":type==="error"?"!":"◇"}</span><strong>${esc(message)}</strong>`;stack.appendChild(el);requestAnimationFrame(()=>el.classList.add("show"));setTimeout(()=>{el.classList.remove("show");setTimeout(()=>el.remove(),260)},2500);
}

const palette=$("#palette");const paletteInput=$("#paletteInput") as HTMLInputElement;const paletteResults=$("#paletteResults");
const commands=[
  ["New folder","Create a directory in the current path","new-folder"],["New file","Create an editable virtual file","new-file"],["Copy selected","Copy selected nodes to VFS clipboard","copy"],["Cut selected","Move selected nodes on paste","cut"],["Paste","Materialize clipboard into current directory","paste"],["Undo","Restore previous in-WASM snapshot","undo"],["Redo","Advance filesystem history","redo"],["Snapshots","Open named snapshot time machine","snapshot"],["Recycle Bin","Open deleted virtual nodes","trash"],["Reset demo","Reinitialize the virtual volume","reset"]
];
function openPalette(){palette.classList.remove("hidden");paletteInput.value="";renderPalette("");setTimeout(()=>paletteInput.focus(),0)}
function closePalette(){palette.classList.add("hidden")}
function renderPalette(q:string){
  q=q.toLowerCase();const arr=commands.filter(c=>(c[0]+" "+c[1]).toLowerCase().includes(q));paletteResults.innerHTML=arr.map((c,i)=>`<button data-command="${c[2]}" class="${i===0?"hot":""}"><span class="cmd-icon">${c[2]==="snapshot"?"◈":"⌘"}</span><section><strong>${c[0]}</strong><small>${c[1]}</small></section><kbd>↵</kbd></button>`).join("");
}
paletteInput.addEventListener("input",()=>renderPalette(paletteInput.value));paletteInput.addEventListener("keydown",e=>{if(e.key==="Escape")closePalette();if(e.key==="Enter"){const first=paletteResults.querySelector<HTMLElement>("[data-command]");first?.click();}});
paletteResults.addEventListener("click",async e=>{const b=(e.target as HTMLElement).closest<HTMLElement>("[data-command]");if(!b)return;closePalette();const c=b.dataset.command!;if(c==="trash")openTrash();else if(c==="reset"){vfs.reset();path=vfs.current();selection.clear();history=[path];historyIndex=0;render();toast("Virtual volume reset","success");}else await runAction(c)});
palette.addEventListener("mousedown",e=>{if(e.target===palette)closePalette()});

const terminal=$("#terminalInput") as HTMLInputElement;
terminal.addEventListener("keydown",async e=>{if(e.key!=="Enter")return;const raw=terminal.value.trim();terminal.value="";if(!raw)return;const [cmd,...rest]=raw.split(/\s+/);const arg=rest.join(" ");
  if(cmd==="mkdir"){if(arg&&vfs.mkdir(path,arg)){toast(`mkdir ${arg}`,"success");render();}else toast("mkdir failed","error");}
  else if(cmd==="touch"){if(arg&&vfs.createFile(path,arg,"")){toast(`touch ${arg}`,"success");render();}else toast("touch failed","error");}
  else if(cmd==="cd"){if(arg){navigate(arg);closePalette();}}
  else if(cmd==="snapshot"){vfs.createSnapshot(arg||"Terminal checkpoint");toast("snapshot captured","success");}
  else if(cmd==="ls"){toast(`${vfs.list(path).length} items in ${path}`);}
  else if(cmd==="pwd"){toast(path);}
  else if(cmd==="undo"){vfs.undo();render();}
  else if(cmd==="redo"){vfs.redo();render();}
  else toast(`Unknown command: ${cmd}`,"error");
});

document.addEventListener("keydown",async e=>{
  const active=document.activeElement as HTMLElement;const editing=active?.tagName==="INPUT"||active?.tagName==="TEXTAREA";
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="k"){e.preventDefault();openPalette();}
  if(editing)return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="c"){e.preventDefault();await runAction("copy")}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="x"){e.preventDefault();await runAction("cut")}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="v"){e.preventDefault();await runAction("paste")}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="z"){e.preventDefault();await runAction(e.shiftKey?"redo":"undo")}
  if(e.key==="Delete"){e.preventDefault();await runAction(trashMode?"permanent-delete":"delete")}
  if(e.key==="F2"){e.preventDefault();await runAction("rename")}
  if(e.key==="Enter"&&selection.size===1)openItem([...selection][0]);
  if(e.key==="Escape"){selection.clear();closePalette();render();}
});

fileArea.addEventListener("dragover",e=>{if(!trashMode)e.preventDefault()});
fileArea.addEventListener("drop",e=>{if(trashMode)return;e.preventDefault();if(dragPaths.length){const n=vfs.move(dragPaths,path);selection.clear();toast(`${n} moved here`,`success`);render();}});

render();
toast("NEBULA VFS mounted in WebAssembly","success");
