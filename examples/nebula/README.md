# NEBULA VFS — Full in-memory virtual file system in WebAssembly

This is a real virtual file-system demo. The filesystem data, directory tree, file contents,
clipboard, trash, snapshots, undo/redo state and search logic live inside AssemblyScript/WASM.
The browser layer is only the visual shell and event bridge.

## Run

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal.

## Highlights

- Full in-memory hierarchical VFS (`/`, directories, files, byte contents)
- Create file/folder, rename, copy, cut, paste, move, recursive delete
- Recycle Bin, restore, empty trash
- Multi-selection and batch operations
- Undo / redo using deep in-WASM snapshots
- Named system snapshots and restore
- Recursive search
- File metadata, MIME inference, timestamps, byte sizes
- Text editor backed by real virtual file contents
- Drag/drop moving between virtual directories
- Grid/list views
- Desktop-grade animated glass UI
- Context menus, keyboard shortcuts, command palette and terminal-like command bar
- No access to the host OS filesystem is required

The VFS is intentionally volatile: refresh resets memory. Persistence can be added by serializing
WASM state to IndexedDB/OPFS without changing the VFS API.
