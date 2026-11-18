(() => {
  "use strict";

  if (location.protocol !== "https:" || location.hostname !== "wasm.local") return;
  if (globalThis.__WASM_ARCHITECT_SOCKET_HOST__) return;

  const sockets = new Map();
  let nextSocketId = 1;
  let nextRequestId = 1;

  function post(message) {
    if (!globalThis.chrome?.webview?.postMessage) {
      throw new Error("WebView2 host messaging is unavailable");
    }
    globalThis.chrome.webview.postMessage(JSON.stringify(message));
  }

  function encodeBase64(bytes) {
    let binary = "";
    const block = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += block) {
      const chunk = bytes.subarray(offset, Math.min(offset + block, bytes.length));
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  function decodeBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function asBytes(chunk) {
    if (chunk instanceof Uint8Array) return chunk;
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
    if (ArrayBuffer.isView(chunk)) {
      return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    throw new TypeError("TCP writes require an ArrayBuffer or typed array");
  }

  function rejectPending(record, error) {
    for (const operation of record.pendingWrites.values()) operation.reject(error);
    record.pendingWrites.clear();
  }

  function openTcp(host, port, options = {}) {
    host = String(host ?? "").trim();
    port = Number(port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return Promise.reject(new TypeError("Invalid TCP destination"));
    }

    const id = nextSocketId++;
    let readableController;
    let openedResolve;
    let openedReject;
    let closedResolve;
    let closedReject;

    const readable = new ReadableStream({
      start(controller) {
        readableController = controller;
      },
      cancel() {
        post({ type: "tcp-close", id });
      }
    });

    const record = {
      id,
      state: "connecting",
      readableController: null,
      openedSettled: false,
      readableSettled: false,
      closedSettled: false,
      pendingWrites: new Map()
    };
    record.readableController = readableController;

    const writable = new WritableStream({
      write(chunk) {
        if (record.state !== "open") {
          return Promise.reject(new Error("TCP socket is not open"));
        }

        const requestId = nextRequestId++;
        const bytes = asBytes(chunk);
        return new Promise((resolve, reject) => {
          record.pendingWrites.set(requestId, { resolve, reject });
          try {
            post({
              type: "tcp-write",
              id,
              requestId,
              data: encodeBase64(bytes)
            });
          } catch (error) {
            record.pendingWrites.delete(requestId);
            reject(error);
          }
        });
      },
      close() {
        if (record.state !== "closed") post({ type: "tcp-close", id });
      },
      abort() {
        if (record.state !== "closed") post({ type: "tcp-close", id });
      }
    });

    const opened = new Promise((resolve, reject) => {
      openedResolve = resolve;
      openedReject = reject;
    });
    const closed = new Promise((resolve, reject) => {
      closedResolve = resolve;
      closedReject = reject;
    });

    const socket = {
      opened,
      closed,
      close() {
        if (record.state !== "closed") {
          record.state = "closing";
          post({ type: "tcp-close", id });
        }
      }
    };

    Object.assign(record, {
      socket,
      openedResolve,
      openedReject,
      closedResolve,
      closedReject,
      readable,
      writable
    });
    sockets.set(id, record);

    try {
      post({
        type: "tcp-open",
        id,
        host,
        port,
        keepAlive: Boolean(options.keepAlive),
        noDelay: Boolean(options.noDelay)
      });
    } catch (error) {
      sockets.delete(id);
      record.openedSettled = true;
      openedReject(error);
      record.closedSettled = true;
      closedReject(error);
    }

    return Promise.resolve(socket);
  }

  function receive(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "host-error") {
      console.error("[Native TCP Host]", message.error);
      return;
    }

    const record = sockets.get(Number(message.id));
    if (!record) return;

    switch (message.type) {
      case "tcp-opened": {
        if (record.openedSettled) return;
        record.state = "open";
        record.openedSettled = true;
        record.openedResolve({
          readable: record.readable,
          writable: record.writable
        });
        break;
      }

      case "tcp-data": {
        if (record.state === "open" && !record.readableSettled) {
          record.readableController.enqueue(decodeBase64(String(message.data ?? "")));
        }
        break;
      }

      case "tcp-write-ok": {
        const requestId = Number(message.requestId);
        const operation = record.pendingWrites.get(requestId);
        if (operation) {
          record.pendingWrites.delete(requestId);
          operation.resolve();
        }
        break;
      }

      case "tcp-error": {
        const error = new Error(String(message.error || "Native TCP error"));
        const requestId = Number(message.requestId);
        if (message.requestId !== null &&
            message.requestId !== undefined &&
            Number.isInteger(requestId)) {
          const operation = record.pendingWrites.get(requestId);
          if (operation) {
            record.pendingWrites.delete(requestId);
            operation.reject(error);
          }
          break;
        }

        if (!record.openedSettled) {
          record.openedSettled = true;
          record.openedReject(error);
        }
        if (!record.readableSettled) {
          record.readableSettled = true;
          record.readableController.error(error);
        }
        rejectPending(record, error);
        break;
      }

      case "tcp-closed": {
        const error = new Error("TCP socket closed");
        record.state = "closed";
        if (!record.openedSettled) {
          record.openedSettled = true;
          record.openedReject(error);
        }
        if (!record.readableSettled) {
          record.readableSettled = true;
          record.readableController.close();
        }
        rejectPending(record, error);
        if (!record.closedSettled) {
          record.closedSettled = true;
          record.closedResolve();
        }
        sockets.delete(record.id);
        break;
      }
    }
  }

  globalThis.chrome?.webview?.addEventListener("message", event => {
    let message = event.data;
    if (typeof message === "string") {
      try { message = JSON.parse(message); }
      catch { return; }
    }
    receive(message);
  });

  Object.defineProperty(globalThis, "__WASM_ARCHITECT_SOCKET_HOST__", {
    value: Object.freeze({ openTcp }),
    configurable: false,
    enumerable: false,
    writable: false
  });

  console.info("[Native TCP Host] Direct byte-stream API installed");
})();
