# Packet engine (experimental)

The same Go protocol implementation builds natively and for **wasip1/wasm** (not GOOS=js and not WebView shims). quic-go and webtransport-go supply QUIC v1/TLS 1.3/HTTP/3, Extended CONNECT, streams and datagrams. Pion supplies ICE, DTLS, SRTP and SCTP. A bounded net.PacketConn accepts/drains packets for one explicitly authorized peer; no socket factory is passed to the renderer.

```sh
npm run transport:build   # dist/packet-engine.wasm; Go 1.26+
npm run transport:test    # native + WASI wire tests and two independent reactors
```

The wire tests negotiate a WebTransport session and echo a stream and datagram, reject an unrelated trust root, and exchange a WebRTC DataChannel message and an SRTP-carried Opus RTP packet. The two-instance test exchanges only UDP payloads through the exported ABI: no shared Go memory, JS PeerConnection or network access. The tests are local and do not imply interoperability with all public endpoints.

**Reusable ABI:** instantiate per session, initialize WASI without socket capabilities, obtain memory through buffer/capacity; command takes a UTF-8 JSON length, feed takes one datagram length, step runs pending work, drain and event return lengths, and shutdown tears down the instance. The reference driver copies all data across the boundary. Steps and callbacks must run on a dedicated worker in a GUI. For accepted command/event names see cmd/packet-engine and interop.mjs. Signaling is out-of-band. Only the trusted caller may select the transport, peer, initiating origin and URL.

**Not yet a browser API:** no website-facing JSEP/capture/codec pipeline, general multi-candidate ICE/STUN/TURN relay, browser-level stream/backpressure adapter or security-reviewed mapping to Tauri sockets. Packet tests are not a claim of mic/camera, playout or general NAT traversal. A full API needs origin-bound lifetime, per-peer consent, policy/permissions, media integration, cancellation, interoperability and cross-platform tests. No native bypass is exposed.
