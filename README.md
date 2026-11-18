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

Open **http://127.0.0.1:4173**. Launch the built-in Browser in the Studio, or import a standalone source from **dist/apps/**. **dist/index.html and dist/vendor/ must stay together.** In a normal web browser the Studio cannot create arbitrary raw sockets. For direct browsing, use `npm run desktop` after building dist/. Use `npm run desktop:build` to package the native application. The target WebView determines HTML/CSS/JS implementation; this is not a bundled copy of Chrome.

## What is here

| Area | Source / verification |
| --- | --- |
| Studio, SDK, desktop | host/, sdk/, src-tauri/; compiler and UI assets bundled locally |
| Six Studio apps + NEBULA | [Catalog / recovered projects](docs/inventory.md); see apps/catalog.json |
| Browser TLS trust | trust/; pinned NSS data, a conservative set of TLS anchors and blocked intermediate public keys |
| Packet-owned WebTransport / WebRTC engine | [Transport profile and integration boundary](transport/README.md); `npm run transport:test` |

**Developer preview, not a production browser.** HTTP/2 and web services in the browser are separate from the new protocol guest. Full website-level `WebTransport` and `RTCPeerConnection` are not enabled. See [security boundaries](SECURITY.md) before running untrusted apps or visiting sites with private data.

## הפעלה בקצרה

אחרי הבנייה, הפעלת `npm run desktop` פותחת את ה־Studio בסביבת Tauri. את הדפדפן אפשר להפעיל מתפריט המערכת או לייבא את `dist/apps/browser.ts`. זה הקובץ שמיועד לייבוא: הוא כולל את ה־SDK העדכני. אין צורך להעתיק ידנית שורות לתוך OsService.
