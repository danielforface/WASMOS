# Development

Use a feature branch. Change host imports in sdk/host-abi.json **and** the matching handler; high-level wrappers belong in sdk/stdlib.ts. Application service names and contracts belong to the provider app, not the kernel. Never edit generated dist/ files.

Before opening a PR, run npm ci, npm run build, npm test and (for protocol changes) npm run transport:test. Update the catalog and inventory when adding an app. For browser/desktop changes also run the offline Studio smoke and validate the Tauri application on the target OS.

Trust changes need an upstream version, reviewable input digests, a root/denylist delta, and regression tests. Use tools/update-trust.mjs with the two verified local input files listed in trust/upstream.json. Do not remove a distrust date by copying DER certificates without the associated policy.
