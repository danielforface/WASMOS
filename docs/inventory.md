# Source inventory

The active Studio is the ABI 6 source with 269 unique host calls. The later-numbered “(33)” export carried an older ABI and was not substituted for it. The original embedded system-browser capsule predated the standalone browser; the active browser is now a separately installed package, not a compiled-in capsule. See [the catalog](../packages/catalog.json) and [package authoring](packages.md).

| Recovered source | Repository | Notes |
| --- | --- | --- |
| wasm_architect_studio.html | host/, sdk/, trust/ | Studio, generic service fabric; 11 former desktop apps moved to packages/base and 6 examples to packages/extra |
| app_SYSTEM_BROWSER_V1_PACKET_OWNED_1_4_.ts | packages/base/browser | Browser 6.0 family; its application publishes the web services |
| app_INFERENCE_V2_5_EXTREME_SERVICE_GGUF.ts | packages/extra/inference | Local inference and service, standalone GGUF model needed |
| app_FLY_3_EMBODIED_AUTONOMY.ts; FLY_WASM_V1/2 archives | packages/extra/fly | Authoritative CPU/SIMD path; removed an optional mirror import that only existed in an older GPU host. Data converter, format, source and license in data/. |
| rtsp_raw_tcp_controller.ts | packages/extra/rtsp | RTSP session and H.264 depacketization, not the WebRTC transport |
| app_1_V10_DUALBOX_FLOW_EVIDENCE_FIXED.ts | packages/extra/vision | WHEP vision/telemetry; earlier V9, WHEP Sentinel and app_1 (1).ts are older variants |
| app_1.ts | packages/extra/media | Independent Internet media/HTTP telemetry dashboard, despite its generic filename |
| NEBULA_WASM_VIRTUAL_DESKTOP.zip | packages/extra/nebula | Self-contained VFS desktop panel with its own Wasm module; project/ retains its standalone Vite sources |
| src-tauri.zip | src-tauri | Current native desktop and raw packet bridge |
| WASM_Architect_Native_RTSP_Host_2026-08-26.zip | hosts/webview2 | Recovered .NET TCP-only host and bridge test; uses the maintained Studio build instead of duplicate, obsolete HTML |

Search included historical conversations, project packages, generic app filenames, TS exports, archive contents and embedded Studio launchers. Roadmap proposals and unrelated apps are not shipped as implemented services. Historical exports with stale SDKs are not additional apps. The earlier .NET/WebView2 host is a predecessor, not the current desktop runtime. There may be further source not present in accessible history.

Large model and connectome binaries, captures, private settings, credentials, and original chat logs are intentionally not bundled. Fly data is available from [Zenodo](https://doi.org/10.5281/zenodo.10676866); use its attribution and converter. User project code retains its existing rights; no new blanket license is granted here. Dependencies retain their upstream licenses (lockfiles pin versions). NSS source data is from Mozilla under MPL-2.0; see trust/upstream.json.
