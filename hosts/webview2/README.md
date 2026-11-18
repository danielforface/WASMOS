# Historical Windows TCP host

The recovered WebView2/.NET 8 shell is an alternative for the earlier RTSP workflow, not a replacement for the Tauri desktop. Only the top-level trusted Studio origin may post privileged messages. No UDP or native renderer-origin service is provided here.

Run `npm ci && npm run build` at repository root, then `dotnet run --project hosts/webview2/WasmArchitectNativeHost.csproj` on Windows with WebView2 installed. The project embeds dist/; it does not ship the superseded HTML or a second copy of the RTSP app. The JS bridge test runs with `node hosts/webview2/tests/bridge-test.js`.
