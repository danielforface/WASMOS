# Official application catalog

A new desktop has **no applications**. The compiler, developer actions, generic ABI and installer belong to the shell. Neither app source, bootstrap services nor a list of package IDs is linked into it. The standalone shell build does not read the application tree. An imported personal workspace is not a new installation.

- **טעינת יישומי הבסיס מהריפו** installs every current `base` entry as a single transaction. It does not start apps, run scripts or download extras. The same button checks for updates without creating duplicate icons.
- **התקנת יישומים נוספים** reads the catalog, lets the user select individual extras, then fetches only those payloads. If the repository changed between choosing and confirming, it asks the user to refresh the list.
- Click an installed icon to run. Use its removal button to uninstall. Removal closes the app and unregisters its live services; user data and unrelated apps are retained. Locally edited package source is kept as a separate tab when detached. Running packages are not hot-swapped: close and reopen after updating.
- Installed bytes live in IndexedDB for the current Studio profile/origin. Opening Studio or launching an already installed package does not consult GitHub. Networked apps may of course need their own network connection. Clearing site data or switching profiles removes this cache. Workspace exports list installed revisions for reference; importing a workspace does not silently install packages. Local source tabs, custom islands and separate app data remain part of the workspace.
- The updater never deletes existing packages just because they disappear from the catalog. A withdrawn package must be removed explicitly; no automatic revocation list is implemented.

## Adding an app without changing the Host

Create `packages/base/<slug>/` or `packages/extra/<slug>/` in the official repository. Add a `package.json` and exactly one installable entry point. AssemblyScript uses `main.ts` without a generated SDK; precompiled core Wasm uses `main.wasm`; a sandboxed UI uses a self-contained UTF-8 `main.html` fragment. Keep optional source/data, build scripts and notices beside the entry point. Don't put a private key, user export, paid model or privileged Host JavaScript in a package.

Example manifest:

```json
{"id":"example.tools.counter","name":"Counter","version":"1.0.0","format":"panel","capabilities":[],"services":[]}
```

Run `npm run catalog`, `npm run build`, `npm test`. Commit the package files and generated `packages/catalog.json` **together**. Once merged to `main`, running shells see the new package the next time the user requests the catalog. A standard release is public: no token, user credential or arbitrary repository URL is needed. Source, WAT and build recipe for generated extras are included; to rebuild NEBULA/Fibonacci run `npm ci --prefix packages/extra/nebula/project`, `npm --prefix packages/extra/nebula/project run build`, `node tools/package-assets.mjs`, then regenerate the catalog.

## What the installer trusts

The installer resolves the official `refs/heads/main` through the GitHub Git refs API, pins the catalog and all downloads to that commit, checks normalized package paths, format, strict response limits, size, SHA-256 and UTF-8 or Wasm validity. It downloads at most four assets concurrently. No redirect, arbitrary URL, app script evaluation or native installation takes place during import. Only after every selected payload verifies is a single IndexedDB transaction committed. A failed fetch, rate limit or quota error leaves the old installation available. Hashes in the catalog detect mismatched bytes; **they are not independent signatures** if repository write access is compromised. Protect the official branch and review package changes.

A panel runs in an opaque sandbox with a restrictive CSP. Its interface is a private per-window MessagePort, not the parent DOM, a native IPC object or an unrestricted network proxy. Only declared, supported operations are available. Hardware capture is started via controls rendered by the Host and tracks are released on close. Files exposes metadata under `/shared`, not private app files. A panel can call `wasmos.provide(name,handler)` for its declared service methods; services disappear on window close. AssemblyScript applications publish through the existing SDK and follow the existing WASM capability policy, not the panel ABI. These controls are not a security audit of the entire Studio.

The six larger recovered projects are optional (five Studio apps plus the self-contained NEBULA VFS). The browser is counted once, in **base**. Six older Studio examples are separate extras; the camera demo requires a local WHEP server. Models, user input data and external media endpoints are not installed by the catalog.
