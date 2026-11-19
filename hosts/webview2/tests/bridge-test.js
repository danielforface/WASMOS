"use strict";

const assert = require("node:assert/strict");

globalThis.location = { protocol: "https:", hostname: "wasm.local" };

let pageMessageListener = null;
const commands = [];

globalThis.chrome = {
  webview: {
    addEventListener(type, listener) {
      assert.equal(type, "message");
      pageMessageListener = listener;
    },
    postMessage(json) {
      const command = JSON.parse(json);
      commands.push(command);

      if (command.type === "tcp-open") {
        queueMicrotask(() => pageMessageListener({
          data: { type: "tcp-opened", id: command.id }
        }));
      } else if (command.type === "tcp-write") {
        queueMicrotask(() => pageMessageListener({
          data: {
            type: "tcp-write-ok",
            id: command.id,
            requestId: command.requestId
          }
        }));
      } else if (command.type === "tcp-close") {
        queueMicrotask(() => pageMessageListener({
          data: { type: "tcp-closed", id: command.id }
        }));
      }
    }
  }
};

require("../bridge/native-socket-bridge.js");

(async () => {
  const socket = await globalThis.__WASM_ARCHITECT_SOCKET_HOST__.openTcp(
    "camera.local",
    554,
    { keepAlive: true, noDelay: true });

  const { readable, writable } = await socket.opened;
  const writer = writable.getWriter();
  const reader = readable.getReader();

  await writer.write(new Uint8Array([0x52, 0x54, 0x53, 0x50]));
  const write = commands.find(command => command.type === "tcp-write");
  assert.ok(write);
  assert.equal(Buffer.from(write.data, "base64").toString("ascii"), "RTSP");

  const open = commands.find(command => command.type === "tcp-open");
  assert.deepEqual(
    { host: open.host, port: open.port, keepAlive: open.keepAlive, noDelay: open.noDelay },
    { host: "camera.local", port: 554, keepAlive: true, noDelay: true });

  pageMessageListener({
    data: { type: "tcp-data", id: open.id, data: Buffer.from("reply").toString("base64") }
  });
  const packet = await reader.read();
  assert.equal(Buffer.from(packet.value).toString("ascii"), "reply");

  socket.close();
  await socket.closed;
  assert.equal(commands.at(-1).type, "tcp-close");

  console.log("native-socket-bridge: PASS");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
