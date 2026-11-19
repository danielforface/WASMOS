# WASMOS

Portable WebAssembly OS and application SDK, with a Tauri desktop host. The Studio compiles AssemblyScript apps, brokers capabilities and routes requests through an app-published Service Fabric. The browser is a provider, not a dependency of the kernel.

## Start

Requires Node 22+ and npm. For the desktop, install Rust and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. The experimental protocol engine additionally needs Go 1.26+.

```sh
npm ci
npm run build
npm test
npm run serve
```

Open **http://127.0.0.1:4173**. A clean desktop knows no application IDs. Choose **טעינת יישומי הבסיס מהריפו** for the complete official base, or **התקנת יישומים נוספים** to choose individual extras. Installed apps survive restart and can launch offline. For direct packet networking use `npm run desktop`; `npm run desktop:build` packages the native app. The desktop shells ship **only `dist/shell/`**, never the developer outputs in `build/apps/`. To build just the OS without any application files: `npm run build:shell`. The renderer is the target WebView, not a bundled copy of Chrome.

## What is here

| Area | Source / verification |
| --- | --- |
| Studio, SDK, desktop | host/, sdk/, src-tauri/; compiler and UI assets bundled locally |
| Official base and optional packages | [Installation and authoring](docs/packages.md) · [live catalog](packages/catalog.json) · [recovered sources](docs/inventory.md) |
| Browser TLS trust | trust/; pinned NSS data, a conservative set of TLS anchors and blocked intermediate public keys |
| Packet-owned WebTransport / WebRTC engine | [Transport profile and integration boundary](transport/README.md); `npm run transport:test` |

**Developer preview, not a production browser.** HTTP/2 and web services in the browser are separate from the new protocol guest. Full website-level `WebTransport` and `RTCPeerConnection` are not enabled. See [security boundaries](SECURITY.md) before running untrusted apps or visiting sites with private data.

## הפעלה בקצרה

אחרי `npm ci` ו־`npm run build:shell`, מריצים `npm run desktop`. בהתקנה חדשה לוחצים על **טעינת יישומי הבסיס מהריפו**, ואז על **Browser**. יישומים נוספים מותקנים רק לפי בחירה. לייבוא ידני למטרות פיתוח, `npm run build` מייצר בין היתר את `build/apps/browser.ts` עם ה־SDK העדכני.
