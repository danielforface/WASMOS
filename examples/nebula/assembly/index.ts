// NEBULA VFS — AssemblyScript / WebAssembly virtual filesystem engine
// All filesystem state lives in WASM linear memory.

const KIND_FILE: i32 = 1;
const KIND_DIR: i32 = 2;

class VNode {
  path: string;
  name: string;
  parent: string;
  kind: i32;
  mime: string;
  content: Uint8Array;
  created: i64;
  modified: i64;
  deletedFrom: string;

  constructor(path: string, name: string, parent: string, kind: i32, mime: string = "application/octet-stream") {
    this.path = path;
    this.name = name;
    this.parent = parent;
    this.kind = kind;
    this.mime = mime;
    this.content = new Uint8Array(0);
    this.created = Date.now();
    this.modified = this.created;
    this.deletedFrom = "";
  }
}

class Snapshot {
  name: string;
  nodes: Array<VNode>;
  currentPath: string;

  constructor(name: string, nodes: Array<VNode>, currentPath: string) {
    this.name = name;
    this.nodes = nodes;
    this.currentPath = currentPath;
  }
}

let fs = new Map<string, VNode>();
let initialized = false;
let currentPath = "/";
let clipboardPaths = new Array<string>();
let clipboardMode: i32 = 0; // 1 copy, 2 cut
let undoStack = new Array<Snapshot>();
let redoStack = new Array<Snapshot>();
let namedSnapshots = new Array<Snapshot>();
let eventLog = new Array<string>();
let serial: i32 = 1;

function cloneBytes(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

function cloneNode(n: VNode): VNode {
  const c = new VNode(n.path, n.name, n.parent, n.kind, n.mime);
  c.content = cloneBytes(n.content);
  c.created = n.created;
  c.modified = n.modified;
  c.deletedFrom = n.deletedFrom;
  return c;
}

function cloneFsNodes(): Array<VNode> {
  const arr = new Array<VNode>();
  const vals = fs.values();
  for (let i = 0; i < vals.length; i++) arr.push(cloneNode(vals[i]));
  return arr;
}

function restoreSnapshot(s: Snapshot): void {
  fs = new Map<string, VNode>();
  for (let i = 0; i < s.nodes.length; i++) {
    const n = cloneNode(s.nodes[i]);
    fs.set(n.path, n);
  }
  currentPath = fs.has(s.currentPath) ? s.currentPath : "/";
}

function pushUndo(label: string): void {
  undoStack.push(new Snapshot(label, cloneFsNodes(), currentPath));
  if (undoStack.length > 50) undoStack.shift();
  redoStack = new Array<Snapshot>();
}

function emit(type: string, detail: string): void {
  eventLog.push("{\"id\":" + serial.toString() + ",\"type\":\"" + jsonEscape(type) + "\",\"detail\":\"" + jsonEscape(detail) + "\",\"time\":" + Date.now().toString() + "}");
  serial++;
  if (eventLog.length > 200) eventLog.shift();
}

function trim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c == 32 || c == 9 || c == 10 || c == 13) a++;
    else break;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c == 32 || c == 9 || c == 10 || c == 13) b--;
    else break;
  }
  return s.substring(a, b);
}

function normalize(path: string): string {
  path = trim(path);
  if (path.length == 0) return currentPath;
  if (path.charAt(0) != "/") {
    path = currentPath == "/" ? "/" + path : currentPath + "/" + path;
  }
  const raw = path.split("/");
  const out = new Array<string>();
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    if (p.length == 0 || p == ".") continue;
    if (p == "..") {
      if (out.length > 0) out.pop();
    } else {
      out.push(p);
    }
  }
  return out.length == 0 ? "/" : "/" + out.join("/");
}

function parentOf(path: string): string {
  path = normalize(path);
  if (path == "/") return "/";
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.substring(0, idx);
}

function baseName(path: string): string {
  path = normalize(path);
  if (path == "/") return "/";
  const idx = path.lastIndexOf("/");
  return path.substring(idx + 1);
}

function joinPath(parent: string, name: string): string {
  parent = normalize(parent);
  name = trim(name);
  while (name.startsWith("/")) name = name.substring(1);
  while (name.endsWith("/") && name.length > 0) name = name.substring(0, name.length - 1);
  return normalize(parent == "/" ? "/" + name : parent + "/" + name);
}

function isValidName(name: string): bool {
  name = trim(name);
  if (name.length == 0 || name == "." || name == "..") return false;
  return name.indexOf("/") < 0 && name.indexOf("\\") < 0 && name.indexOf("\0") < 0;
}

function isDir(path: string): bool {
  const n = fs.get(normalize(path));
  return n != null && n.kind == KIND_DIR;
}

function isFile(path: string): bool {
  const n = fs.get(normalize(path));
  return n != null && n.kind == KIND_FILE;
}

function inferMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".js") || lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".rs") || lower.endsWith(".c") || lower.endsWith(".cpp")) return "text/code";
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function utf8Bytes(text: string): Uint8Array {
  const ab = String.UTF8.encode(text, false);
  return Uint8Array.wrap(ab);
}

function utf8Text(bytes: Uint8Array): string {
  if (bytes.length == 0) return "";
  return String.UTF8.decode(bytes.buffer, false);
}

function uniqueName(parent: string, desired: string): string {
  let name = desired;
  let i = 2;
  while (fs.has(joinPath(parent, name))) {
    const dot = desired.lastIndexOf(".");
    if (dot > 0) name = desired.substring(0, dot) + " (" + i.toString() + ")" + desired.substring(dot);
    else name = desired + " (" + i.toString() + ")";
    i++;
  }
  return name;
}

function descendants(path: string): Array<string> {
  path = normalize(path);
  const out = new Array<string>();
  const keys = fs.keys();
  const prefix = path == "/" ? "/" : path + "/";
  for (let i = 0; i < keys.length; i++) {
    const p = keys[i];
    if (p != path && p.startsWith(prefix)) out.push(p);
  }
  return out;
}

function sortedDeepest(paths: Array<string>): Array<string> {
  paths.sort((a: string, b: string): i32 => {
    if (a.length == b.length) return a < b ? -1 : 1;
    return a.length > b.length ? -1 : 1;
  });
  return paths;
}

function moveTree(source: string, destParent: string, newName: string, preserveDeletedFrom: bool = true): string {
  source = normalize(source);
  destParent = normalize(destParent);
  if (!fs.has(source) || !isDir(destParent)) return "";
  if (source == "/") return "";
  if (destParent == source || destParent.startsWith(source + "/")) return "";

  const src = fs.get(source)!;
  const finalName = uniqueName(destParent, newName);
  const destRoot = joinPath(destParent, finalName);
  const all = descendants(source);
  all.unshift(source);
  all.sort((a: string, b: string): i32 => a.length < b.length ? -1 : (a.length > b.length ? 1 : 0));

  const clones = new Array<VNode>();
  for (let i = 0; i < all.length; i++) {
    const oldPath = all[i];
    const oldNode = fs.get(oldPath)!;
    const suffix = oldPath == source ? "" : oldPath.substring(source.length);
    const newPath = destRoot + suffix;
    const c = cloneNode(oldNode);
    c.path = newPath;
    c.name = baseName(newPath);
    c.parent = parentOf(newPath);
    c.modified = Date.now();
    if (!preserveDeletedFrom) c.deletedFrom = "";
    clones.push(c);
  }

  const rm = sortedDeepest(all);
  for (let i = 0; i < rm.length; i++) fs.delete(rm[i]);
  for (let i = 0; i < clones.length; i++) fs.set(clones[i].path, clones[i]);
  return destRoot;
}

function copyTree(source: string, destParent: string, desiredName: string): string {
  source = normalize(source);
  destParent = normalize(destParent);
  if (!fs.has(source) || !isDir(destParent)) return "";
  const finalName = uniqueName(destParent, desiredName);
  const destRoot = joinPath(destParent, finalName);
  const all = descendants(source);
  all.unshift(source);
  all.sort((a: string, b: string): i32 => a.length < b.length ? -1 : (a.length > b.length ? 1 : 0));
  for (let i = 0; i < all.length; i++) {
    const oldPath = all[i];
    const oldNode = fs.get(oldPath)!;
    const suffix = oldPath == source ? "" : oldPath.substring(source.length);
    const newPath = destRoot + suffix;
    const c = cloneNode(oldNode);
    c.path = newPath;
    c.name = baseName(newPath);
    c.parent = parentOf(newPath);
    c.created = Date.now();
    c.modified = c.created;
    c.deletedFrom = "";
    fs.set(c.path, c);
  }
  return destRoot;
}

function jsonEscape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c == 34) out += "\\\"";
    else if (c == 92) out += "\\\\";
    else if (c == 10) out += "\\n";
    else if (c == 13) out += "\\r";
    else if (c == 9) out += "\\t";
    else if (c < 32) out += "?";
    else out += String.fromCharCode(c);
  }
  return out;
}

function nodeSize(n: VNode): i32 {
  return n.kind == KIND_FILE ? n.content.length : descendants(n.path).length;
}

function nodeJson(n: VNode): string {
  return "{\"path\":\"" + jsonEscape(n.path) +
    "\",\"name\":\"" + jsonEscape(n.name) +
    "\",\"parent\":\"" + jsonEscape(n.parent) +
    "\",\"kind\":\"" + (n.kind == KIND_DIR ? "dir" : "file") +
    "\",\"mime\":\"" + jsonEscape(n.mime) +
    "\",\"size\":" + nodeSize(n).toString() +
    ",\"created\":" + n.created.toString() +
    ",\"modified\":" + n.modified.toString() +
    ",\"deletedFrom\":\"" + jsonEscape(n.deletedFrom) + "\"}";
}

function listJson(nodes: Array<VNode>): string {
  let out = "[";
  for (let i = 0; i < nodes.length; i++) {
    if (i > 0) out += ",";
    out += nodeJson(nodes[i]);
  }
  return out + "]";
}

function createDirInternal(path: string): bool {
  path = normalize(path);
  if (fs.has(path) || path == "/") return false;
  const parent = parentOf(path);
  if (!isDir(parent)) return false;
  const name = baseName(path);
  if (!isValidName(name)) return false;
  fs.set(path, new VNode(path, name, parent, KIND_DIR, "inode/directory"));
  return true;
}

function createFileInternal(path: string, text: string): bool {
  path = normalize(path);
  if (fs.has(path) || path == "/") return false;
  const parent = parentOf(path);
  if (!isDir(parent)) return false;
  const name = baseName(path);
  if (!isValidName(name)) return false;
  const n = new VNode(path, name, parent, KIND_FILE, inferMime(name));
  n.content = utf8Bytes(text);
  fs.set(path, n);
  return true;
}

function seed(): void {
  fs.clear();
  const root = new VNode("/", "/", "/", KIND_DIR, "inode/directory");
  fs.set("/", root);
  const dirs = [
    "/Home", "/Home/Desktop", "/Home/Documents", "/Home/Documents/Research", "/Home/Documents/Design",
    "/Home/Projects", "/Home/Projects/Nebula", "/Home/Projects/Aether", "/Home/Media", "/Home/Media/Images",
    "/Home/Media/Audio", "/Home/Downloads", "/System", "/System/Config", "/System/Logs", "/.trash"
  ];
  for (let i = 0; i < dirs.length; i++) createDirInternal(dirs[i]);
  createFileInternal("/Home/Documents/Welcome.md", "# NEBULA VFS\n\nThis file is stored inside WebAssembly linear memory.\n\nTry creating folders, copying, cutting, pasting, renaming, deleting, restoring, snapshots, undo/redo and recursive search.");
  createFileInternal("/Home/Documents/Research/quantum-notes.txt", "Quantum substrate notes\n----------------------\nVirtual filesystem demo content.\nEvery edit mutates the in-WASM byte buffer.");
  createFileInternal("/Home/Documents/Design/interface-spec.md", "# Interface Specification\n\n- Animated glass shell\n- Grid and list views\n- Command palette\n- Context menus\n- Recycle bin\n- Snapshot timeline\n");
  createFileInternal("/Home/Projects/Nebula/main.ts", "export const nebula = 'virtual filesystem';\nconsole.log(nebula);\n");
  createFileInternal("/Home/Projects/Nebula/architecture.json", "{\n  \"engine\": \"WASM\",\n  \"storage\": \"linear-memory\",\n  \"ui\": \"TypeScript\"\n}\n");
  createFileInternal("/Home/Projects/Aether/kernel.rs", "#![no_std]\n\npub fn boot() { /* virtual sample */ }\n");
  createFileInternal("/System/Config/theme.json", "{\"theme\":\"nebula\",\"motion\":true,\"glass\":0.72}");
  createFileInternal("/System/Logs/boot.log", "[OK] VFS online\n[OK] inode table mounted\n[OK] event bus ready\n");
  createFileInternal("/Home/Downloads/readme.txt", "Downloads are virtual too.\n");
  currentPath = "/Home/Documents";
  clipboardPaths = new Array<string>();
  clipboardMode = 0;
  undoStack = new Array<Snapshot>();
  redoStack = new Array<Snapshot>();
  namedSnapshots = new Array<Snapshot>();
  eventLog = new Array<string>();
  emit("boot", "NEBULA VFS initialized");
}

function ensureInit(): void {
  if (!initialized) {
    seed();
    initialized = true;
  }
}

export function initVfs(): i32 {
  seed();
  initialized = true;
  return 1;
}

export function getCurrentPath(): string {
  ensureInit();
  return currentPath;
}

export function cd(path: string): i32 {
  ensureInit();
  const p = normalize(path);
  if (!isDir(p) || p == "/.trash") return 0;
  currentPath = p;
  emit("cd", p);
  return 1;
}

export function exists(path: string): i32 {
  ensureInit();
  return fs.has(normalize(path)) ? 1 : 0;
}

export function list(path: string): string {
  ensureInit();
  const p = normalize(path);
  if (!isDir(p)) return "[]";
  const vals = fs.values();
  const out = new Array<VNode>();
  for (let i = 0; i < vals.length; i++) {
    const n = vals[i];
    if (n.parent == p && n.path != p && !n.path.startsWith("/.trash")) out.push(n);
  }
  out.sort((a: VNode, b: VNode): i32 => {
    if (a.kind != b.kind) return a.kind == KIND_DIR ? -1 : 1;
    const al = a.name.toLowerCase();
    const bl = b.name.toLowerCase();
    return al < bl ? -1 : (al > bl ? 1 : 0);
  });
  return listJson(out);
}

export function stat(path: string): string {
  ensureInit();
  const n = fs.get(normalize(path));
  return n == null ? "null" : nodeJson(n);
}

export function mkdir(parent: string, name: string): i32 {
  ensureInit();
  parent = normalize(parent);
  name = trim(name);
  if (!isDir(parent) || !isValidName(name)) return 0;
  const p = joinPath(parent, name);
  if (fs.has(p)) return 0;
  pushUndo("Create folder");
  const ok = createDirInternal(p);
  if (ok) emit("mkdir", p);
  return ok ? 1 : 0;
}

export function createFile(parent: string, name: string, text: string): i32 {
  ensureInit();
  parent = normalize(parent);
  name = trim(name);
  if (!isDir(parent) || !isValidName(name)) return 0;
  const p = joinPath(parent, name);
  if (fs.has(p)) return 0;
  pushUndo("Create file");
  const ok = createFileInternal(p, text);
  if (ok) emit("create", p);
  return ok ? 1 : 0;
}

export function readText(path: string): string {
  ensureInit();
  const n = fs.get(normalize(path));
  if (n == null || n.kind != KIND_FILE) return "";
  return utf8Text(n.content);
}

export function writeText(path: string, text: string): i32 {
  ensureInit();
  const p = normalize(path);
  const n = fs.get(p);
  if (n == null || n.kind != KIND_FILE) return 0;
  pushUndo("Edit file");
  n.content = utf8Bytes(text);
  n.modified = Date.now();
  n.mime = inferMime(n.name);
  emit("write", p);
  return 1;
}

export function rename(path: string, newName: string): string {
  ensureInit();
  const p = normalize(path);
  newName = trim(newName);
  if (p == "/" || p.startsWith("/.trash") || !fs.has(p) || !isValidName(newName)) return "";
  const parent = parentOf(p);
  const desired = joinPath(parent, newName);
  if (fs.has(desired)) return "";
  pushUndo("Rename");
  const result = moveTree(p, parent, newName);
  emit("rename", p + " -> " + result);
  return result;
}

export function copySelection(pathsCsv: string): i32 {
  ensureInit();
  clipboardPaths = parseCsv(pathsCsv);
  clipboardMode = 1;
  emit("clipboard", "copy " + clipboardPaths.length.toString());
  return clipboardPaths.length;
}

export function cutSelection(pathsCsv: string): i32 {
  ensureInit();
  clipboardPaths = parseCsv(pathsCsv);
  clipboardMode = 2;
  emit("clipboard", "cut " + clipboardPaths.length.toString());
  return clipboardPaths.length;
}

function parseCsv(csv: string): Array<string> {
  const raw = csv.split("\n");
  const out = new Array<string>();
  for (let i = 0; i < raw.length; i++) {
    const p = normalize(trim(raw[i]));
    if (p != "/" && fs.has(p) && !p.startsWith("/.trash")) out.push(p);
  }
  return out;
}

export function clipboardState(): string {
  ensureInit();
  return "{\"mode\":\"" + (clipboardMode == 1 ? "copy" : (clipboardMode == 2 ? "cut" : "none")) + "\",\"count\":" + clipboardPaths.length.toString() + "}";
}

export function paste(destParent: string): i32 {
  ensureInit();
  destParent = normalize(destParent);
  if (!isDir(destParent) || clipboardMode == 0 || clipboardPaths.length == 0) return 0;
  pushUndo(clipboardMode == 1 ? "Paste copies" : "Move items");
  let count = 0;
  const sources = clipboardPaths.slice(0);
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (!fs.has(src)) continue;
    if (clipboardMode == 1) {
      const r = copyTree(src, destParent, baseName(src));
      if (r.length > 0) count++;
    } else {
      if (destParent == src || destParent.startsWith(src + "/")) continue;
      const r = moveTree(src, destParent, baseName(src));
      if (r.length > 0) count++;
    }
  }
  if (clipboardMode == 2) {
    clipboardMode = 0;
    clipboardPaths = new Array<string>();
  }
  emit("paste", count.toString() + " -> " + destParent);
  return count;
}

export function move(pathsCsv: string, destParent: string): i32 {
  ensureInit();
  const paths = parseCsv(pathsCsv);
  destParent = normalize(destParent);
  if (!isDir(destParent) || paths.length == 0) return 0;
  pushUndo("Move items");
  let count = 0;
  for (let i = 0; i < paths.length; i++) {
    const src = paths[i];
    if (destParent == src || destParent.startsWith(src + "/")) continue;
    if (moveTree(src, destParent, baseName(src)).length > 0) count++;
  }
  emit("move", count.toString() + " -> " + destParent);
  return count;
}

export function deleteToTrash(pathsCsv: string): i32 {
  ensureInit();
  const paths = parseCsv(pathsCsv);
  if (paths.length == 0) return 0;
  pushUndo("Move to recycle bin");
  let count = 0;
  for (let i = 0; i < paths.length; i++) {
    const src = paths[i];
    if (!fs.has(src) || src == "/" || src.startsWith("/.trash")) continue;
    const original = src;
    const newName = serial.toString() + "_" + baseName(src);
    const moved = moveTree(src, "/.trash", newName);
    if (moved.length > 0) {
      const all = descendants(moved);
      all.unshift(moved);
      for (let j = 0; j < all.length; j++) {
        const n = fs.get(all[j]);
        if (n != null) n.deletedFrom = original;
      }
      count++;
      serial++;
    }
  }
  emit("trash", count.toString());
  return count;
}

export function listTrash(): string {
  ensureInit();
  const vals = fs.values();
  const out = new Array<VNode>();
  for (let i = 0; i < vals.length; i++) {
    const n = vals[i];
    if (n.parent == "/.trash" && n.path != "/.trash") out.push(n);
  }
  out.sort((a: VNode, b: VNode): i32 => a.modified > b.modified ? -1 : 1);
  return listJson(out);
}

export function restoreTrash(pathsCsv: string): i32 {
  ensureInit();
  const raw = pathsCsv.split("\n");
  if (raw.length == 0) return 0;
  pushUndo("Restore from recycle bin");
  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    const p = normalize(trim(raw[i]));
    const n = fs.get(p);
    if (n == null || !p.startsWith("/.trash/") || n.deletedFrom.length == 0) continue;
    let target = n.deletedFrom;
    let targetParent = parentOf(target);
    if (!isDir(targetParent)) targetParent = "/Home";
    const restored = moveTree(p, targetParent, baseName(target), false);
    if (restored.length > 0) count++;
  }
  emit("restore", count.toString());
  return count;
}

function permanentDeleteTree(path: string): bool {
  path = normalize(path);
  if (path == "/" || !fs.has(path)) return false;
  const all = descendants(path);
  all.push(path);
  const ordered = sortedDeepest(all);
  for (let i = 0; i < ordered.length; i++) fs.delete(ordered[i]);
  return true;
}

export function deletePermanent(pathsCsv: string): i32 {
  ensureInit();
  const raw = pathsCsv.split("\n");
  pushUndo("Permanent delete");
  let count = 0;
  for (let i = 0; i < raw.length; i++) {
    const p = normalize(trim(raw[i]));
    if (p.startsWith("/.trash/") && permanentDeleteTree(p)) count++;
  }
  emit("delete-permanent", count.toString());
  return count;
}

export function emptyTrash(): i32 {
  ensureInit();
  const vals = fs.values();
  const roots = new Array<string>();
  for (let i = 0; i < vals.length; i++) {
    if (vals[i].parent == "/.trash" && vals[i].path != "/.trash") roots.push(vals[i].path);
  }
  if (roots.length == 0) return 0;
  pushUndo("Empty recycle bin");
  for (let i = 0; i < roots.length; i++) permanentDeleteTree(roots[i]);
  emit("empty-trash", roots.length.toString());
  return roots.length;
}

export function search(query: string, scope: string): string {
  ensureInit();
  query = trim(query).toLowerCase();
  scope = normalize(scope);
  if (query.length == 0) return "[]";
  const vals = fs.values();
  const out = new Array<VNode>();
  for (let i = 0; i < vals.length; i++) {
    const n = vals[i];
    if (n.path == "/" || n.path.startsWith("/.trash")) continue;
    if (scope != "/" && n.path != scope && !n.path.startsWith(scope + "/")) continue;
    let hit = n.name.toLowerCase().indexOf(query) >= 0 || n.path.toLowerCase().indexOf(query) >= 0;
    if (!hit && n.kind == KIND_FILE && n.content.length <= 262144) {
      hit = utf8Text(n.content).toLowerCase().indexOf(query) >= 0;
    }
    if (hit) out.push(n);
    if (out.length >= 200) break;
  }
  return listJson(out);
}

export function undo(): i32 {
  ensureInit();
  if (undoStack.length == 0) return 0;
  redoStack.push(new Snapshot("redo", cloneFsNodes(), currentPath));
  const s = undoStack.pop();
  if (s == null) return 0;
  restoreSnapshot(s);
  emit("undo", s.name);
  return 1;
}

export function redo(): i32 {
  ensureInit();
  if (redoStack.length == 0) return 0;
  undoStack.push(new Snapshot("undo", cloneFsNodes(), currentPath));
  const s = redoStack.pop();
  if (s == null) return 0;
  restoreSnapshot(s);
  emit("redo", s.name);
  return 1;
}

export function undoState(): string {
  ensureInit();
  return "{\"undo\":" + undoStack.length.toString() + ",\"redo\":" + redoStack.length.toString() + "}";
}

export function createSnapshot(name: string): i32 {
  ensureInit();
  name = trim(name);
  if (name.length == 0) name = "Snapshot " + (namedSnapshots.length + 1).toString();
  namedSnapshots.push(new Snapshot(name, cloneFsNodes(), currentPath));
  if (namedSnapshots.length > 16) namedSnapshots.shift();
  emit("snapshot", name);
  return namedSnapshots.length - 1;
}

export function listSnapshots(): string {
  ensureInit();
  let out = "[";
  for (let i = 0; i < namedSnapshots.length; i++) {
    if (i > 0) out += ",";
    const s = namedSnapshots[i];
    out += "{\"index\":" + i.toString() + ",\"name\":\"" + jsonEscape(s.name) + "\",\"nodes\":" + s.nodes.length.toString() + "}";
  }
  return out + "]";
}

export function restoreNamedSnapshot(index: i32): i32 {
  ensureInit();
  if (index < 0 || index >= namedSnapshots.length) return 0;
  pushUndo("Restore snapshot");
  restoreSnapshot(namedSnapshots[index]);
  emit("snapshot-restore", namedSnapshots[index].name);
  return 1;
}

export function stats(): string {
  ensureInit();
  const vals = fs.values();
  let files = 0;
  let dirs = 0;
  let bytes: i64 = 0;
  let trash = 0;
  for (let i = 0; i < vals.length; i++) {
    const n = vals[i];
    if (n.path.startsWith("/.trash/")) trash++;
    if (n.kind == KIND_DIR) dirs++;
    else {
      files++;
      bytes += n.content.length;
    }
  }
  return "{\"files\":" + files.toString() + ",\"dirs\":" + dirs.toString() + ",\"bytes\":" + bytes.toString() + ",\"trash\":" + trash.toString() + ",\"undo\":" + undoStack.length.toString() + ",\"redo\":" + redoStack.length.toString() + "}";
}

export function events(): string {
  ensureInit();
  let out = "[";
  for (let i = 0; i < eventLog.length; i++) {
    if (i > 0) out += ",";
    out += eventLog[i];
  }
  return out + "]";
}

export function resetDemo(): i32 {
  seed();
  return 1;
}
