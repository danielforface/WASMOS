// =============================================================================
// WASM ARCHITECT STUDIO - DIRECT RTSP/RTP/H.264 CLIENT
// Raw TCP host ABI only. No WebSocket, HTTP fetch, CORS proxy or desktop relay.
//
// Host requirements:
//   - RawTcpSocket from WASM Architect Studio's injected standard library.
//   - VideoDecoderEngine from the same standard library.
//   - Direct Sockets IWA or a native host implementing the Studio socket bridge.
//
// Implemented here:
//   - rtsp:// URL parsing, including optional user:password credentials.
//   - OPTIONS -> DESCRIBE -> SETUP -> PLAY RTSP state machine.
//   - Basic and Digest/MD5 authentication (qop=auth and legacy Digest).
//   - SDP H.264 track discovery and sprop-parameter-sets extraction.
//   - RTP/AVP/TCP interleaved framing ($ channel length payload).
//   - H.264 Single NAL, STAP-A and FU-A depacketization.
//   - Annex-B access-unit construction and WebCodecs hardware decode.
//   - RTSP keepalive, redirect handling, loss telemetry and graceful stop.
// =============================================================================

const WIDTH: i32 = 800;
const HEIGHT: i32 = 600;
export const pixels = new Uint32Array(WIDTH * HEIGHT);

export function getWidth(): i32 { return WIDTH; }
export function getHeight(): i32 { return HEIGHT; }

// -----------------------------------------------------------------------------
// UI and application state
// -----------------------------------------------------------------------------

let currentStreamUrl: string = "";
let isEditingUrl: bool = false;
let isStreaming: bool = false;
let statusMessage: string = "READY: DIRECT RAW TCP RTSP";

let mouseX: i32 = 0;
let mouseY: i32 = 0;

let decodedFrames: i32 = 0;
let submittedFrames: i32 = 0;
let lastFrameW: i32 = 0;
let lastFrameH: i32 = 0;
let lastFrameTimestamp: f64 = 0;
let fpsCounter: i32 = 0;
let currentFps: i32 = 0;
let lastFpsUpdate: f64 = 0;

const VP_X: i32 = 20;
const VP_Y: i32 = 108;
const VP_W: i32 = 540;
const VP_H: i32 = 340;

// -----------------------------------------------------------------------------
// RTSP protocol state
// -----------------------------------------------------------------------------

const STATE_IDLE: i32 = 0;
const STATE_TCP_CONNECTING: i32 = 1;
const STATE_WAIT_OPTIONS: i32 = 2;
const STATE_WAIT_DESCRIBE: i32 = 3;
const STATE_WAIT_SETUP: i32 = 4;
const STATE_WAIT_PLAY: i32 = 5;
const STATE_STREAMING: i32 = 6;
const STATE_STOPPED: i32 = 7;
const STATE_ERROR: i32 = -1;

let rtspState: i32 = STATE_IDLE;
let socket = new RawTcpSocket();
let cseq: i32 = 1;
let sessionId: string = "";
let contentBase: string = "";
let videoTrackUri: string = "";
let playUri: string = "";
let lastKeepalive: f64 = 0;
let redirectCount: i32 = 0;
let suppressTcpCloseEvent: bool = false;

let lastMethod: string = "";
let lastRequestUri: string = "";
let lastExtraHeaders: string = "";
let lastRequestBody: string = "";
let authRetryCount: i32 = 0;

// Authentication state
let authScheme: i32 = 0; // 0 none, 1 Basic, 2 Digest
let authRealm: string = "";
let authNonce: string = "";
let authOpaque: string = "";
let authQop: string = "";
let authCnonce: string = "";
let authNc: i32 = 0;

class ParsedRtspUrl {
  valid: bool = false;
  host: string = "";
  port: i32 = 554;
  username: string = "";
  password: string = "";
  cleanUrl: string = "";
  authority: string = "";
}

let parsedUrl = new ParsedRtspUrl();

// -----------------------------------------------------------------------------
// Network receive buffering
// -----------------------------------------------------------------------------

const IO_CHUNK_SIZE: i32 = 65536;
const RX_CAPACITY: i32 = 4 * 1024 * 1024;
const AU_CAPACITY: i32 = 8 * 1024 * 1024;

const ioChunk = new Uint8Array(IO_CHUNK_SIZE);
const rxBuffer = new Uint8Array(RX_CAPACITY);
let rxStart: i32 = 0;
let rxEnd: i32 = 0;

const accessUnit = new Uint8Array(AU_CAPACITY);
let accessUnitLength: i32 = 0;
let accessUnitKey: bool = false;
let accessUnitTimestamp: u32 = 0;
let accessUnitHasTimestamp: bool = false;
let fuActive: bool = false;

let sps = new Uint8Array(0);
let pps = new Uint8Array(0);
let decoderReady: bool = false;
let receivedFirstKeyframe: bool = false;

let rtpPackets: i32 = 0;
let rtcpPackets: i32 = 0;
let lostPackets: i32 = 0;
let networkBytes: i32 = 0;
let lastSequence: i32 = -1;
let firstRtpTimestamp: u32 = 0;
let haveFirstRtpTimestamp: bool = false;

// -----------------------------------------------------------------------------
// MD5 constants for RTSP Digest authentication
// -----------------------------------------------------------------------------

const MD5_S: i32[] = [
  7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
  5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
  4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
  6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
];

const MD5_K: u32[] = [
  0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,
  0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
  0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,
  0x6b901122,0xfd987193,0xa679438e,0x49b40821,
  0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,
  0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
  0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,
  0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
  0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,
  0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
  0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,
  0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
  0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,
  0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
  0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,
  0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391
];

const BASE64_TABLE: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const HEX_TABLE: string = "0123456789abcdef";

// -----------------------------------------------------------------------------
// Lifecycle and frame pump
// -----------------------------------------------------------------------------

export function appInit(w: i32, h: i32, dpr: f64): void {
  lastFpsUpdate = now_ms();
  let caps = RawTcpSocket.capabilities();
  if ((caps & 1) == 0) {
    statusMessage = "HOST HAS NO RAW TCP: INSTALL AS IWA OR USE NATIVE HOST";
  } else if ((caps & 2) != 0) {
    statusMessage = "READY: CHROMIUM DIRECT SOCKETS ACTIVE";
  } else if ((caps & 4) != 0) {
    statusMessage = "READY: NATIVE RAW TCP HOST ACTIVE";
  }
}

export function appStop(): void {
  stopConnection(false);
}

export function renderFrame(): i32 {
  let now = now_ms();
  networkTick(now);

  if (now - lastFpsUpdate >= 1000.0) {
    currentFps = fpsCounter;
    fpsCounter = 0;
    lastFpsUpdate = now;
  }

  pixels.fill(rgba(10, 13, 20));

  // Header
  drawRect(20, 15, 760, 45, rgba(18, 24, 38));
  drawFrame(20, 15, 760, 45, rgba(38, 48, 70));
  drawText("WASM DIRECT RTSP / RTP / H.264 RECEIVER", 35, 23, rgba(0, 243, 255), 2);
  drawText(statusMessage.slice(0, 92), 35, 43, rtspState == STATE_ERROR ? rgba(255, 80, 80) : (isStreaming ? rgba(0, 255, 157) : rgba(255, 180, 0)), 1);

  // URL editor
  let inX: i32 = 20;
  let inY: i32 = 68;
  drawRect(inX, inY, 760, 32, isEditingUrl ? rgba(12, 20, 32) : rgba(16, 20, 28));
  drawFrame(inX, inY, 760, 32, isEditingUrl ? rgba(0, 243, 255) : rgba(38, 48, 70));
  drawText("RTSP URL:", inX + 10, inY + 11, rgba(130, 145, 175), 1);
  drawText(maskedUrl(currentStreamUrl).slice(0, 76), inX + 90, inY + 11, rgba(235, 245, 255), 1);

  if (isEditingUrl && ((<i32>(now / 400.0)) % 2 == 0)) {
    let cursorX = inX + 90 + (maskedUrl(currentStreamUrl).length * 8);
    if (cursorX < inX + 750) drawRect(cursorX, inY + 8, 2, 16, rgba(0, 243, 255));
  }

  // Video viewport
  drawRect(VP_X, VP_Y, VP_W, VP_H, rgba(5, 7, 10));
  if (lastFrameW > 0 && isStreaming) {
    VideoDecoderEngine.drawFrame(pixels, WIDTH, HEIGHT, VP_X, VP_Y, VP_W, VP_H);
    let live = (now - lastFrameTimestamp) < 700.0;
    drawRect(VP_X + 10, VP_Y + 10, 162, 22, rgba(0, 0, 0, 180));
    drawRect(VP_X + 15, VP_Y + 17, 8, 8, live ? rgba(0, 255, 157) : rgba(255, 180, 0));
    drawText(live ? "DIRECT RTSP LIVE" : "DECODER BUFFERING", VP_X + 29, VP_Y + 17, rgba(255, 255, 255), 1);
    drawRect(VP_X + 10, VP_Y + VP_H - 28, 240, 18, rgba(0, 0, 0, 180));
    drawText("H264 GPU " + lastFrameW.toString() + "x" + lastFrameH.toString(), VP_X + 15, VP_Y + VP_H - 23, rgba(0, 243, 255), 1);
  } else if (isStreaming) {
    drawText("RTSP PLAYING - WAITING FOR H.264 IDR", VP_X + 105, VP_Y + 155, rgba(255, 180, 0), 1);
    drawText("RTP PACKETS: " + rtpPackets.toString(), VP_X + 190, VP_Y + 178, rgba(130, 145, 175), 1);
  } else {
    drawText("DIRECT RTSP STANDBY", VP_X + 165, VP_Y + 155, rgba(100, 115, 140), 2);
    drawText("No WebSocket / No proxy / No CORS bridge", VP_X + 125, VP_Y + 182, rgba(70, 85, 110), 1);
  }
  drawFrame(VP_X, VP_Y, VP_W, VP_H, rgba(40, 50, 75));

  // Controls
  let px: i32 = 570;
  let py: i32 = 108;
  let pw: i32 = 210;
  drawRect(px, py, pw, VP_H, rgba(18, 24, 38));
  drawFrame(px, py, pw, VP_H, rgba(38, 48, 70));
  drawText("DIRECT RTSP PRESETS", px + 15, py + 12, rgba(235, 245, 255), 1);
  drawButton(px + 15, py + 35, 180, 30, "1. WOWZA PUBLIC RTSP", rgba(0, 180, 255));
  drawButton(px + 15, py + 72, 180, 30, "2. LAN CAMERA", rgba(140, 90, 240));
  drawButton(px + 15, py + 109, 180, 30, "3. AUTH CAMERA", rgba(255, 170, 0));
  drawRect(px + 15, py + 148, 180, 1, rgba(38, 48, 70));
  drawText("RAW TCP ACTIONS", px + 15, py + 158, rgba(235, 245, 255), 1);
  drawButton(px + 15, py + 180, 180, 36, isStreaming || rtspState == STATE_TCP_CONNECTING ? "STOP CONNECTION" : "CONNECT DIRECT RTSP", isStreaming ? rgba(255, 70, 70) : rgba(0, 255, 157));
  drawButton(px + 15, py + 225, 180, 30, "CLEAR RTSP URL", rgba(60, 75, 95));

  // Telemetry
  drawRect(20, 460, 760, 125, rgba(12, 16, 24));
  drawFrame(20, 460, 760, 125, rgba(38, 48, 70));
  drawText("DIRECT SOCKET / RTSP / RTP TELEMETRY", 35, 472, rgba(235, 245, 255), 1);
  drawRect(35, 488, 730, 1, rgba(38, 48, 70));
  drawText("STATE: " + stateName(rtspState) + " | TCP: " + (socket.id < 0 ? "NONE" : tcpStateName(socket.state())) + " | FPS: " + currentFps.toString(), 35, 498, rgba(0, 255, 157), 1);
  drawText("RTP: " + rtpPackets.toString() + " | RTCP: " + rtcpPackets.toString() + " | LOST: " + lostPackets.toString() + " | BYTES: " + networkBytes.toString(), 35, 516, rgba(0, 243, 255), 1);
  drawText("AU SUBMITTED: " + submittedFrames.toString() + " | FRAMES DECODED: " + decodedFrames.toString() + " | SESSION: " + (sessionId.length > 0 ? "ACTIVE" : "NONE"), 35, 534, rgba(130, 145, 175), 1);
  drawText("TRANSPORT: RTP/AVP/TCP INTERLEAVED 0-1 | AUTH: " + authName(), 35, 552, rgba(100, 115, 140), 1);

  return <i32>pixels.dataStart;
}

// -----------------------------------------------------------------------------
// Input handling
// -----------------------------------------------------------------------------

export function mouseDown(button: i32, x: i32, y: i32, mods: i32): void {
  isEditingUrl = x >= 20 && x <= 780 && y >= 68 && y <= 100;

  let px: i32 = 570;
  let py: i32 = 108;

  if (x >= px + 15 && x <= px + 195 && y >= py + 35 && y <= py + 65) {
    currentStreamUrl = "rtsp://wowzaec2demo.streamlock.net/vod/mp4:BigBuckBunny_115k.mp4";
    statusMessage = "LOADED: WOWZA PUBLIC RTSP";
  }

  if (x >= px + 15 && x <= px + 195 && y >= py + 72 && y <= py + 102) {
    currentStreamUrl = "rtsp://camera.example:554/stream1";
    statusMessage = "EDIT HOST/PATH FOR YOUR LAN CAMERA";
  }

  if (x >= px + 15 && x <= px + 195 && y >= py + 109 && y <= py + 139) {
    currentStreamUrl = "rtsp://camera.example:554/stream1";
    statusMessage = "EDIT USER/PASSWORD/HOST FOR AUTH CAMERA";
  }

  if (x >= px + 15 && x <= px + 195 && y >= py + 180 && y <= py + 216) {
    if (rtspState == STATE_IDLE || rtspState == STATE_STOPPED || rtspState == STATE_ERROR) startConnection();
    else stopConnection(true);
  }

  if (x >= px + 15 && x <= px + 195 && y >= py + 225 && y <= py + 255) {
    if (rtspState != STATE_IDLE && rtspState != STATE_STOPPED && rtspState != STATE_ERROR) stopConnection(false);
    currentStreamUrl = "";
    isEditingUrl = true;
    statusMessage = "ENTER rtsp:// URL";
  }
}

export function mouseMove(x: i32, y: i32, buttons: i32, mods: i32): void {
  mouseX = x;
  mouseY = y;
}

export function textInput(codepoint: i32): void {
  if (!isEditingUrl) return;
  if (codepoint >= 32 && codepoint <= 126 && currentStreamUrl.length < 220) {
    currentStreamUrl += String.fromCharCode(codepoint);
  }
}

export function keyDown(keyCode: i32, mods: i32, repeat: i32): void {
  if (!isEditingUrl) return;
  if (keyCode == 8 && currentStreamUrl.length > 0) {
    currentStreamUrl = currentStreamUrl.slice(0, currentStreamUrl.length - 1);
  } else if (keyCode == 13) {
    isEditingUrl = false;
    startConnection();
  }
}

// -----------------------------------------------------------------------------
// Host callbacks
// -----------------------------------------------------------------------------

export function tcpEvent(socketId: i32, state: i32, newBytes: i32): void {
  if (socketId != socket.id) return;
  if (state == 1 && rtspState == STATE_TCP_CONNECTING) {
    beginRtspHandshake();
  } else if (state == -1) {
    let message = socket.error();
    failConnection(message.length > 0 ? "TCP ERROR: " + message : "TCP CONNECTION ERROR");
  } else if (state == 3 && !suppressTcpCloseEvent && rtspState != STATE_STOPPED && rtspState != STATE_IDLE) {
    failConnection("TCP CLOSED BY RTSP SERVER");
  }
}

export function videoFrameDecoded(w: i32, h: i32): void {
  decodedFrames++;
  fpsCounter++;
  lastFrameW = w;
  lastFrameH = h;
  lastFrameTimestamp = now_ms();
}

// -----------------------------------------------------------------------------
// Connection management
// -----------------------------------------------------------------------------

function startConnection(): void {
  redirectCount = 0;
  openConnection();
}

function openConnection(): void {
  if ((RawTcpSocket.capabilities() & 1) == 0) {
    failConnection("RAW TCP UNAVAILABLE: RUN AS DIRECT-SOCKETS IWA OR NATIVE HOST");
    return;
  }

  if (currentStreamUrl.length == 0) {
    failConnection("RTSP URL IS EMPTY");
    return;
  }

  parsedUrl = parseRtspUrl(currentStreamUrl);
  if (!parsedUrl.valid) {
    failConnection("INVALID RTSP URL - EXPECTED rtsp://host[:port]/path");
    return;
  }

  resetProtocolState();
  rtspState = STATE_TCP_CONNECTING;
  statusMessage = "TCP CONNECTING: " + parsedUrl.host + ":" + parsedUrl.port.toString();
  let id = socket.connect(parsedUrl.host, parsedUrl.port, 3);
  if (id < 0) {
    failConnection(id == -2 ? "HOST DOES NOT GRANT RAW TCP" : "TCP CONNECT REJECTED: " + id.toString());
  }
}

function stopConnection(sendTeardown: bool): void {
  if (sendTeardown && socket.state() == 1 && sessionId.length > 0 && parsedUrl.cleanUrl.length > 0) {
    issueRequest("TEARDOWN", playUri.length > 0 ? playUri : parsedUrl.cleanUrl, "", "", false);
  }
  suppressTcpCloseEvent = true;
  socket.close();
  suppressTcpCloseEvent = false;
  isStreaming = false;
  rtspState = STATE_STOPPED;
  statusMessage = "RTSP CONNECTION STOPPED";
  sessionId = "";
  resetReceivePipeline();
}

function failConnection(message: string): void {
  statusMessage = message;
  isStreaming = false;
  rtspState = STATE_ERROR;
  suppressTcpCloseEvent = true;
  socket.close();
  suppressTcpCloseEvent = false;
}

function resetProtocolState(): void {
  suppressTcpCloseEvent = true;
  socket.close();
  suppressTcpCloseEvent = false;
  socket = new RawTcpSocket();
  cseq = 1;
  sessionId = "";
  contentBase = "";
  videoTrackUri = "";
  playUri = "";
  lastKeepalive = now_ms();
  lastMethod = "";
  lastRequestUri = "";
  lastExtraHeaders = "";
  lastRequestBody = "";
  authScheme = 0;
  authRealm = "";
  authNonce = "";
  authOpaque = "";
  authQop = "";
  authCnonce = "";
  authNc = 0;
  authRetryCount = 0;
  isStreaming = false;
  decoderReady = false;
  decodedFrames = 0;
  submittedFrames = 0;
  lastFrameW = 0;
  lastFrameH = 0;
  rtpPackets = 0;
  rtcpPackets = 0;
  lostPackets = 0;
  networkBytes = 0;
  lastSequence = -1;
  sps = new Uint8Array(0);
  pps = new Uint8Array(0);
  resetReceivePipeline();
}

function resetReceivePipeline(): void {
  rxStart = 0;
  rxEnd = 0;
  accessUnitLength = 0;
  accessUnitKey = false;
  accessUnitHasTimestamp = false;
  fuActive = false;
  receivedFirstKeyframe = false;
  haveFirstRtpTimestamp = false;
}

function beginRtspHandshake(): void {
  if (rtspState != STATE_TCP_CONNECTING) return;
  statusMessage = "TCP OPEN - SENDING RTSP OPTIONS";
  rtspState = STATE_WAIT_OPTIONS;
  issueRequest("OPTIONS", parsedUrl.cleanUrl, "", "", true);
}

function networkTick(now: f64): void {
  let tcpState = socket.state();
  if (rtspState == STATE_TCP_CONNECTING && tcpState == 1) beginRtspHandshake();
  if (tcpState == -1 && rtspState != STATE_ERROR && rtspState != STATE_IDLE && rtspState != STATE_STOPPED) {
    let error = socket.error();
    failConnection(error.length > 0 ? "TCP ERROR: " + error : "TCP SOCKET ERROR");
    return;
  }

  if (tcpState == 1) {
    pullSocketBytes();
    processReceiveBuffer();
  }

  if (rtspState == STATE_STREAMING && now - lastKeepalive >= 15000.0) {
    lastKeepalive = now;
    issueRequest("GET_PARAMETER", playUri.length > 0 ? playUri : parsedUrl.cleanUrl, "", "", true);
  }
}

function pullSocketBytes(): void {
  for (let iteration: i32 = 0; iteration < 64; iteration++) {
    let read = socket.receive(ioChunk);
    if (read <= 0) break;
    networkBytes += read;
    if (!appendReceiveBytes(ioChunk, read)) {
      failConnection("NETWORK BUFFER OVERFLOW");
      return;
    }
  }
}

function appendReceiveBytes(source: Uint8Array, length: i32): bool {
  if (length <= 0) return true;
  if (rxEnd + length > RX_CAPACITY) compactReceiveBuffer();
  if (rxEnd + length > RX_CAPACITY) return false;
  for (let i: i32 = 0; i < length; i++) rxBuffer[rxEnd + i] = source[i];
  rxEnd += length;
  return true;
}

function compactReceiveBuffer(): void {
  if (rxStart <= 0) return;
  let remaining = rxEnd - rxStart;
  for (let i: i32 = 0; i < remaining; i++) rxBuffer[i] = rxBuffer[rxStart + i];
  rxStart = 0;
  rxEnd = remaining;
}

// -----------------------------------------------------------------------------
// RTSP framing and responses
// -----------------------------------------------------------------------------

function processReceiveBuffer(): void {
  for (let unit: i32 = 0; unit < 256; unit++) {
    let available = rxEnd - rxStart;
    if (available <= 0) {
      rxStart = 0;
      rxEnd = 0;
      return;
    }

    // RTP/RTCP interleaved frame: '$', channel, big-endian length, payload.
    if (rxBuffer[rxStart] == 0x24) {
      if (available < 4) return;
      let channel = <i32>rxBuffer[rxStart + 1];
      let frameLength = (<i32>rxBuffer[rxStart + 2] << 8) | <i32>rxBuffer[rxStart + 3];
      if (frameLength < 0 || frameLength > 65535) {
        failConnection("INVALID INTERLEAVED RTP LENGTH");
        return;
      }
      if (available < frameLength + 4) return;
      if (channel == 0) processRtpPacket(rxStart + 4, frameLength);
      else if (channel == 1) rtcpPackets++;
      rxStart += frameLength + 4;
      continue;
    }

    let headerEnd = findHeaderEnd(rxStart, rxEnd);
    if (headerEnd < 0) {
      // Resynchronize only when the buffer clearly does not begin with RTSP.
      if (available > 8 && !startsWithAscii(rxStart, "RTSP/")) rxStart++;
      else return;
      continue;
    }

    let headerLength = headerEnd - rxStart;
    let headerText = bytesToString(rxStart, headerLength);
    let contentLengthText = headerValue(headerText, "Content-Length");
    let contentLength: i32 = contentLengthText.length > 0 ? parseDecimal(contentLengthText) : 0;
    if (contentLength < 0 || contentLength > RX_CAPACITY / 2) {
      failConnection("INVALID RTSP CONTENT-LENGTH");
      return;
    }

    let messageLength = headerLength + 4 + contentLength;
    if (available < messageLength) return;
    let body = contentLength > 0 ? bytesToString(headerEnd + 4, contentLength) : "";
    rxStart += messageLength;
    handleRtspResponse(headerText, body);
  }

  if (rxStart > RX_CAPACITY / 2) compactReceiveBuffer();
}

function findHeaderEnd(start: i32, end: i32): i32 {
  for (let i: i32 = start; i + 3 < end; i++) {
    if (rxBuffer[i] == 13 && rxBuffer[i + 1] == 10 && rxBuffer[i + 2] == 13 && rxBuffer[i + 3] == 10) return i;
  }
  return -1;
}

function startsWithAscii(start: i32, value: string): bool {
  if (rxEnd - start < value.length) return false;
  for (let i: i32 = 0; i < value.length; i++) {
    if (<i32>rxBuffer[start + i] != value.charCodeAt(i)) return false;
  }
  return true;
}

function bytesToString(start: i32, length: i32): string {
  let copy = new Uint8Array(length);
  for (let i: i32 = 0; i < length; i++) copy[i] = rxBuffer[start + i];
  return String.UTF8.decode(copy.buffer);
}

function headerValue(headers: string, wantedName: string): string {
  let wanted = wantedName.toLowerCase();
  let lines = headers.split("\r\n");
  for (let i: i32 = 1; i < lines.length; i++) {
    let line = lines[i];
    let colon = line.indexOf(":");
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() == wanted) return line.slice(colon + 1).trim();
  }
  return "";
}

function responseStatus(headers: string): i32 {
  let lineEnd = headers.indexOf("\r\n");
  let first = lineEnd >= 0 ? headers.slice(0, lineEnd) : headers;
  let parts = first.split(" ");
  return parts.length >= 2 ? parseDecimal(parts[1]) : 0;
}

function handleRtspResponse(headers: string, body: string): void {
  let status = responseStatus(headers);

  if (status == 401) {
    if (authRetryCount >= 2 || !configureAuthentication(headerValue(headers, "WWW-Authenticate"))) {
      failConnection(parsedUrl.username.length == 0 ? "RTSP 401: ADD user:password@ TO URL" : "RTSP AUTHENTICATION FAILED");
      return;
    }
    authRetryCount++;
    statusMessage = "RTSP AUTH CHALLENGE - RETRYING " + authName();
    issueRequest(lastMethod, lastRequestUri, lastExtraHeaders, lastRequestBody, false);
    return;
  }

  if (status >= 300 && status < 400) {
    let location = headerValue(headers, "Location");
    if (location.length > 0 && redirectCount < 3) {
      redirectCount++;
      currentStreamUrl = location;
      statusMessage = "RTSP REDIRECT " + status.toString();
      openConnection();
      return;
    }
  }

  if (status < 200 || status >= 300) {
    if (rtspState == STATE_STREAMING && (status == 405 || status == 501)) {
      statusMessage = "STREAMING - SERVER DOES NOT SUPPORT GET_PARAMETER";
      return;
    }
    failConnection("RTSP ERROR " + status.toString() + " DURING " + lastMethod);
    return;
  }

  authRetryCount = 0;

  if (rtspState == STATE_WAIT_OPTIONS) {
    rtspState = STATE_WAIT_DESCRIBE;
    statusMessage = "OPTIONS OK - REQUESTING SDP";
    issueRequest("DESCRIBE", parsedUrl.cleanUrl, "Accept: application/sdp\r\n", "", true);
    return;
  }

  if (rtspState == STATE_WAIT_DESCRIBE) {
    contentBase = headerValue(headers, "Content-Base");
    if (contentBase.length == 0) contentBase = headerValue(headers, "Content-Location");
    if (contentBase.length == 0) contentBase = parsedUrl.cleanUrl;

    if (!parseSdp(body)) {
      failConnection("SDP HAS NO SUPPORTED H.264 VIDEO TRACK");
      return;
    }

    rtspState = STATE_WAIT_SETUP;
    statusMessage = "SDP OK - SETUP H.264 RTP/TCP";
    issueRequest("SETUP", videoTrackUri, "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n", "", true);
    return;
  }

  if (rtspState == STATE_WAIT_SETUP) {
    let sessionHeader = headerValue(headers, "Session");
    let semicolon = sessionHeader.indexOf(";");
    sessionId = (semicolon >= 0 ? sessionHeader.slice(0, semicolon) : sessionHeader).trim();
    if (sessionId.length == 0) {
      failConnection("SETUP RESPONSE HAS NO RTSP SESSION");
      return;
    }

    rtspState = STATE_WAIT_PLAY;
    statusMessage = "SETUP OK - SENDING PLAY";
    issueRequest("PLAY", playUri.length > 0 ? playUri : parsedUrl.cleanUrl, "Range: npt=0.000-\r\n", "", true);
    return;
  }

  if (rtspState == STATE_WAIT_PLAY) {
    rtspState = STATE_STREAMING;
    isStreaming = true;
    lastKeepalive = now_ms();
    statusMessage = "RTSP PLAY OK - RECEIVING RTP/H.264 DIRECTLY";
    return;
  }
}

function issueRequest(method: string, uri: string, extraHeaders: string, body: string, remember: bool): void {
  if (socket.state() != 1) return;

  if (remember) {
    lastMethod = method;
    lastRequestUri = uri;
    lastExtraHeaders = extraHeaders;
    lastRequestBody = body;
    authRetryCount = 0;
  }

  let request = method + " " + uri + " RTSP/1.0\r\n";
  request += "CSeq: " + (cseq++).toString() + "\r\n";
  request += "User-Agent: WASM-Architect-DirectRTSP/1.0\r\n";
  request += "Connection: keep-alive\r\n";
  if (sessionId.length > 0 && method != "SETUP") request += "Session: " + sessionId + "\r\n";

  let authorization = buildAuthorization(method, uri);
  if (authorization.length > 0) request += "Authorization: " + authorization + "\r\n";
  if (extraHeaders.length > 0) request += extraHeaders;

  if (body.length > 0) {
    let bodyBytes = String.UTF8.encode(body);
    request += "Content-Length: " + bodyBytes.byteLength.toString() + "\r\n";
  }
  request += "\r\n" + body;
  socket.sendText(request);
}

// -----------------------------------------------------------------------------
// SDP parsing
// -----------------------------------------------------------------------------

function parseSdp(sdpText: string): bool {
  if (sdpText.length == 0) return false;

  let lines = sdpText.replace("\r", "").split("\n");
  let inVideo = false;
  let foundH264 = false;
  let videoControl = "";
  let aggregateControl = "";
  let profileLevel = "42E01E";
  let sprop = "";

  for (let i: i32 = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line.startsWith("m=")) {
      inVideo = line.toLowerCase().startsWith("m=video");
      continue;
    }

    if (!inVideo && line.startsWith("a=control:")) {
      let control = line.slice(10).trim();
      if (control == "*" || control.startsWith("rtsp://")) aggregateControl = control;
    }

    if (!inVideo) continue;

    if (line.toLowerCase().startsWith("a=rtpmap:") && line.toLowerCase().indexOf("h264/90000") >= 0) foundH264 = true;
    if (line.startsWith("a=control:")) videoControl = line.slice(10).trim();
    if (line.toLowerCase().startsWith("a=fmtp:")) {
      let p = sdpParameter(line, "profile-level-id");
      if (p.length == 6) profileLevel = p.toUpperCase();
      let sp = sdpParameter(line, "sprop-parameter-sets");
      if (sp.length > 0) sprop = sp;
    }
  }

  if (!foundH264) return false;
  if (videoControl.length == 0) videoControl = "trackID=1";

  videoTrackUri = resolveRtspControl(contentBase, videoControl);
  if (aggregateControl.length == 0 || aggregateControl == "*") playUri = contentBase;
  else playUri = resolveRtspControl(contentBase, aggregateControl);

  let comma = sprop.indexOf(",");
  if (comma > 0) {
    sps = base64Decode(sprop.slice(0, comma).trim());
    pps = base64Decode(sprop.slice(comma + 1).trim());
  }

  decoderReady = VideoDecoderEngine.init("avc1." + profileLevel);
  return videoTrackUri.length > 0 && decoderReady;
}

function sdpParameter(line: string, name: string): string {
  let lower = line.toLowerCase();
  let token = name.toLowerCase() + "=";
  let start = lower.indexOf(token);
  if (start < 0) return "";
  start += token.length;
  let end = line.indexOf(";", start);
  if (end < 0) end = line.length;
  return line.slice(start, end).trim();
}

function resolveRtspControl(base: string, control: string): string {
  if (control.startsWith("rtsp://")) return control;
  if (control == "*") return base;
  if (control.startsWith("/")) return "rtsp://" + parsedUrl.authority + control;
  if (base.endsWith("/")) return base + control;
  return base + "/" + control;
}

// -----------------------------------------------------------------------------
// RTP/H.264 depacketization
// -----------------------------------------------------------------------------

function processRtpPacket(start: i32, length: i32): void {
  if (length < 12) return;

  let first = <i32>rxBuffer[start];
  let second = <i32>rxBuffer[start + 1];
  if ((first >> 6) != 2) return;

  let csrcCount = first & 0x0f;
  let hasExtension = (first & 0x10) != 0;
  let hasPadding = (first & 0x20) != 0;
  let marker = (second & 0x80) != 0;
  let sequence = (<i32>rxBuffer[start + 2] << 8) | <i32>rxBuffer[start + 3];
  let timestamp = readU32BE(start + 4);

  let payloadStart = start + 12 + csrcCount * 4;
  let packetEnd = start + length;
  if (payloadStart > packetEnd) return;

  if (hasExtension) {
    if (payloadStart + 4 > packetEnd) return;
    let extensionWords = (<i32>rxBuffer[payloadStart + 2] << 8) | <i32>rxBuffer[payloadStart + 3];
    payloadStart += 4 + extensionWords * 4;
    if (payloadStart > packetEnd) return;
  }

  if (hasPadding && packetEnd > payloadStart) {
    let padding = <i32>rxBuffer[packetEnd - 1];
    if (padding > 0 && padding <= packetEnd - payloadStart) packetEnd -= padding;
  }
  if (packetEnd <= payloadStart) return;

  if (lastSequence >= 0) {
    let expected = (lastSequence + 1) & 0xffff;
    if (sequence != expected) {
      let gap = (sequence - expected) & 0xffff;
      if (gap > 0 && gap < 32768) lostPackets += gap;
      accessUnitLength = 0;
      accessUnitKey = false;
      accessUnitHasTimestamp = false;
      fuActive = false;
    }
  }
  lastSequence = sequence;
  rtpPackets++;

  if (accessUnitHasTimestamp && timestamp != accessUnitTimestamp && accessUnitLength > 0) {
    // A timestamp change without an RTP marker means the previous AU was incomplete.
    accessUnitLength = 0;
    accessUnitKey = false;
    accessUnitHasTimestamp = false;
    fuActive = false;
  }
  if (!accessUnitHasTimestamp) {
    accessUnitTimestamp = timestamp;
    accessUnitHasTimestamp = true;
  }

  let nalType = <i32>rxBuffer[payloadStart] & 0x1f;
  if (nalType >= 1 && nalType <= 23) {
    appendCompleteNal(payloadStart, packetEnd - payloadStart);
  } else if (nalType == 24) {
    processStapA(payloadStart, packetEnd);
  } else if (nalType == 28) {
    processFuA(payloadStart, packetEnd);
  }

  if (marker) submitAccessUnit(timestamp);
}

function processStapA(payloadStart: i32, payloadEnd: i32): void {
  let pos = payloadStart + 1;
  while (pos + 2 <= payloadEnd) {
    let nalLength = (<i32>rxBuffer[pos] << 8) | <i32>rxBuffer[pos + 1];
    pos += 2;
    if (nalLength <= 0 || pos + nalLength > payloadEnd) return;
    appendCompleteNal(pos, nalLength);
    pos += nalLength;
  }
}

function processFuA(payloadStart: i32, payloadEnd: i32): void {
  if (payloadStart + 2 > payloadEnd) return;
  let indicator = <i32>rxBuffer[payloadStart];
  let header = <i32>rxBuffer[payloadStart + 1];
  let isStart = (header & 0x80) != 0;
  let isEnd = (header & 0x40) != 0;
  let originalType = header & 0x1f;

  if (isStart) {
    fuActive = true;
    appendStartCode();
    appendAuByte(<u8>((indicator & 0xe0) | originalType));
    if (originalType == 5) accessUnitKey = true;
  } else if (!fuActive) {
    return;
  }

  appendAuRange(payloadStart + 2, payloadEnd - payloadStart - 2);
  if (isEnd) fuActive = false;
}

function appendCompleteNal(start: i32, length: i32): void {
  if (length <= 0) return;
  let nalType = <i32>rxBuffer[start] & 0x1f;
  if (nalType == 5) accessUnitKey = true;
  if (nalType == 7) copyParameterSet(true, start, length);
  if (nalType == 8) copyParameterSet(false, start, length);
  appendStartCode();
  appendAuRange(start, length);
}

function copyParameterSet(isSps: bool, start: i32, length: i32): void {
  let out = new Uint8Array(length);
  for (let i: i32 = 0; i < length; i++) out[i] = rxBuffer[start + i];
  if (isSps) sps = out;
  else pps = out;
}

function appendStartCode(): void {
  appendAuByte(0);
  appendAuByte(0);
  appendAuByte(0);
  appendAuByte(1);
}

function appendAuByte(value: u8): void {
  if (accessUnitLength >= AU_CAPACITY) {
    accessUnitLength = 0;
    accessUnitKey = false;
    accessUnitHasTimestamp = false;
    fuActive = false;
    return;
  }
  accessUnit[accessUnitLength++] = value;
}

function appendAuRange(start: i32, length: i32): void {
  if (length <= 0 || accessUnitLength + length > AU_CAPACITY) {
    accessUnitLength = 0;
    accessUnitKey = false;
    accessUnitHasTimestamp = false;
    fuActive = false;
    return;
  }
  for (let i: i32 = 0; i < length; i++) accessUnit[accessUnitLength + i] = rxBuffer[start + i];
  accessUnitLength += length;
}

function submitAccessUnit(timestamp: u32): void {
  if (accessUnitLength <= 0 || !decoderReady || fuActive) {
    resetCurrentAccessUnit();
    return;
  }

  if (!receivedFirstKeyframe && !accessUnitKey) {
    resetCurrentAccessUnit();
    return;
  }

  let prefixLength: i32 = 0;
  if (accessUnitKey) {
    if (sps.length > 0) prefixLength += 4 + sps.length;
    if (pps.length > 0) prefixLength += 4 + pps.length;
  }

  let frame = new Uint8Array(prefixLength + accessUnitLength);
  let out: i32 = 0;
  if (accessUnitKey && sps.length > 0) out = appendAnnexBNal(frame, out, sps);
  if (accessUnitKey && pps.length > 0) out = appendAnnexBNal(frame, out, pps);
  for (let i: i32 = 0; i < accessUnitLength; i++) frame[out + i] = accessUnit[i];

  if (!haveFirstRtpTimestamp) {
    firstRtpTimestamp = timestamp;
    haveFirstRtpTimestamp = true;
  }
  let delta: u32 = timestamp - firstRtpTimestamp;
  let timestampUs: f64 = <f64>delta * 1000000.0 / 90000.0;
  VideoDecoderEngine.decodeNal(frame.buffer, accessUnitKey, timestampUs);
  submittedFrames++;
  if (accessUnitKey) receivedFirstKeyframe = true;
  resetCurrentAccessUnit();
}

function appendAnnexBNal(destination: Uint8Array, offset: i32, nal: Uint8Array): i32 {
  destination[offset++] = 0;
  destination[offset++] = 0;
  destination[offset++] = 0;
  destination[offset++] = 1;
  for (let i: i32 = 0; i < nal.length; i++) destination[offset++] = nal[i];
  return offset;
}

function resetCurrentAccessUnit(): void {
  accessUnitLength = 0;
  accessUnitKey = false;
  accessUnitHasTimestamp = false;
  fuActive = false;
}

function readU32BE(offset: i32): u32 {
  return (<u32>rxBuffer[offset] << 24)
    | (<u32>rxBuffer[offset + 1] << 16)
    | (<u32>rxBuffer[offset + 2] << 8)
    | <u32>rxBuffer[offset + 3];
}

// -----------------------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------------------

function configureAuthentication(challenge: string): bool {
  if (challenge.length == 0 || parsedUrl.username.length == 0) return false;
  let lower = challenge.toLowerCase();

  if (lower.startsWith("basic")) {
    authScheme = 1;
    authRealm = authParameter(challenge, "realm");
    return true;
  }

  if (lower.startsWith("digest")) {
    authScheme = 2;
    authRealm = authParameter(challenge, "realm");
    authNonce = authParameter(challenge, "nonce");
    authOpaque = authParameter(challenge, "opaque");
    let offeredQop = authParameter(challenge, "qop").toLowerCase();
    authQop = offeredQop.indexOf("auth") >= 0 ? "auth" : "";
    authCnonce = md5Hex(now_ms().toString() + ":" + random_f64().toString()).slice(0, 16);
    authNc = 0;
    return authRealm.length > 0 && authNonce.length > 0;
  }
  return false;
}

function buildAuthorization(method: string, uri: string): string {
  if (authScheme == 0 || parsedUrl.username.length == 0) return "";

  if (authScheme == 1) {
    return "Basic " + base64EncodeString(parsedUrl.username + ":" + parsedUrl.password);
  }

  authNc++;
  let nc = hex8(<u32>authNc);
  let ha1 = md5Hex(parsedUrl.username + ":" + authRealm + ":" + parsedUrl.password);
  let ha2 = md5Hex(method + ":" + uri);
  let response = authQop.length > 0
    ? md5Hex(ha1 + ":" + authNonce + ":" + nc + ":" + authCnonce + ":" + authQop + ":" + ha2)
    : md5Hex(ha1 + ":" + authNonce + ":" + ha2);

  let value = "Digest username=\"" + parsedUrl.username + "\", realm=\"" + authRealm + "\", nonce=\"" + authNonce + "\", uri=\"" + uri + "\", response=\"" + response + "\", algorithm=MD5";
  if (authOpaque.length > 0) value += ", opaque=\"" + authOpaque + "\"";
  if (authQop.length > 0) value += ", qop=" + authQop + ", nc=" + nc + ", cnonce=\"" + authCnonce + "\"";
  return value;
}

function authParameter(challenge: string, name: string): string {
  let lower = challenge.toLowerCase();
  let token = name.toLowerCase() + "=";
  let start = lower.indexOf(token);
  if (start < 0) return "";
  start += token.length;
  while (start < challenge.length && challenge.charCodeAt(start) == 32) start++;
  if (start < challenge.length && challenge.charCodeAt(start) == 34) {
    start++;
    let endQuote = challenge.indexOf("\"", start);
    return endQuote >= 0 ? challenge.slice(start, endQuote) : challenge.slice(start);
  }
  let end = challenge.indexOf(",", start);
  if (end < 0) end = challenge.length;
  return challenge.slice(start, end).trim();
}

function authName(): string {
  if (authScheme == 1) return "BASIC";
  if (authScheme == 2) return authQop.length > 0 ? "DIGEST/QOP" : "DIGEST";
  return "NONE";
}

// -----------------------------------------------------------------------------
// RTSP URL parsing
// -----------------------------------------------------------------------------

function parseRtspUrl(input: string): ParsedRtspUrl {
  let result = new ParsedRtspUrl();
  let value = input.trim();
  if (!value.toLowerCase().startsWith("rtsp://")) return result;

  let rest = value.slice(7);
  let slash = rest.indexOf("/");
  let authorityWithUser = slash >= 0 ? rest.slice(0, slash) : rest;
  let path = slash >= 0 ? rest.slice(slash) : "/";

  let at = authorityWithUser.lastIndexOf("@");
  let authority = authorityWithUser;
  if (at >= 0) {
    let userInfo = authorityWithUser.slice(0, at);
    authority = authorityWithUser.slice(at + 1);
    let colon = userInfo.indexOf(":");
    if (colon >= 0) {
      result.username = decodeUrlAscii(userInfo.slice(0, colon));
      result.password = decodeUrlAscii(userInfo.slice(colon + 1));
    } else {
      result.username = decodeUrlAscii(userInfo);
    }
  }

  if (authority.startsWith("[")) {
    let close = authority.indexOf("]");
    if (close < 0) return result;
    result.host = authority.slice(1, close);
    if (close + 1 < authority.length && authority.charCodeAt(close + 1) == 58) {
      result.port = parseDecimal(authority.slice(close + 2));
    }
  } else {
    let colon = authority.lastIndexOf(":");
    if (colon > 0 && authority.indexOf(":") == colon) {
      result.host = authority.slice(0, colon);
      result.port = parseDecimal(authority.slice(colon + 1));
    } else {
      result.host = authority;
    }
  }

  if (result.host.length == 0 || result.port <= 0 || result.port > 65535) return result;
  result.authority = authority;
  result.cleanUrl = "rtsp://" + authority + path;
  result.valid = true;
  return result;
}

function maskedUrl(value: string): string {
  let lower = value.toLowerCase();
  if (!lower.startsWith("rtsp://")) return value;
  let start = 7;
  let at = value.indexOf("@", start);
  if (at < 0) return value;
  let colon = value.indexOf(":", start);
  if (colon < 0 || colon > at) return value;
  return value.slice(0, colon + 1) + "***" + value.slice(at);
}

function decodeUrlAscii(value: string): string {
  let out = "";
  for (let i: i32 = 0; i < value.length; i++) {
    let ch = value.charCodeAt(i);
    if (ch == 37 && i + 2 < value.length) {
      let hi = hexValue(value.charCodeAt(i + 1));
      let lo = hexValue(value.charCodeAt(i + 2));
      if (hi >= 0 && lo >= 0) {
        out += String.fromCharCode((hi << 4) | lo);
        i += 2;
        continue;
      }
    }
    out += String.fromCharCode(ch);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Base64 and MD5 helpers
// -----------------------------------------------------------------------------

function base64EncodeString(value: string): string {
  let bytes = Uint8Array.wrap(String.UTF8.encode(value));
  let out = "";
  for (let i: i32 = 0; i < bytes.length; i += 3) {
    let a = <i32>bytes[i];
    let haveB = i + 1 < bytes.length;
    let haveC = i + 2 < bytes.length;
    let b = haveB ? <i32>bytes[i + 1] : 0;
    let c = haveC ? <i32>bytes[i + 2] : 0;
    out += BASE64_TABLE.charAt((a >> 2) & 63);
    out += BASE64_TABLE.charAt(((a & 3) << 4) | ((b >> 4) & 15));
    out += haveB ? BASE64_TABLE.charAt(((b & 15) << 2) | ((c >> 6) & 3)) : "=";
    out += haveC ? BASE64_TABLE.charAt(c & 63) : "=";
  }
  return out;
}

function base64Decode(value: string): Uint8Array {
  let clean = value.trim();
  let output = new Uint8Array((clean.length * 3) / 4 + 3);
  let accumulator: i32 = 0;
  let bits: i32 = 0;
  let count: i32 = 0;

  for (let i: i32 = 0; i < clean.length; i++) {
    let code = clean.charCodeAt(i);
    if (code == 61) break;
    let v = base64Value(code);
    if (v < 0) continue;
    accumulator = (accumulator << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[count++] = <u8>((accumulator >> bits) & 255);
    }
  }
  return output.slice(0, count);
}

function base64Value(code: i32): i32 {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code == 43) return 62;
  if (code == 47) return 63;
  return -1;
}

function md5Hex(value: string): string {
  let input = Uint8Array.wrap(String.UTF8.encode(value));
  let total = ((input.length + 9 + 63) >> 6) << 6;
  let data = new Uint8Array(total);
  for (let i: i32 = 0; i < input.length; i++) data[i] = input[i];
  data[input.length] = 0x80;

  let bitLength: u32 = <u32>input.length * 8;
  data[total - 8] = <u8>(bitLength & 255);
  data[total - 7] = <u8>((bitLength >> 8) & 255);
  data[total - 6] = <u8>((bitLength >> 16) & 255);
  data[total - 5] = <u8>((bitLength >> 24) & 255);

  let a0: u32 = 0x67452301;
  let b0: u32 = 0xefcdab89;
  let c0: u32 = 0x98badcfe;
  let d0: u32 = 0x10325476;
  let words = new Uint32Array(16);

  for (let offset: i32 = 0; offset < total; offset += 64) {
    for (let j: i32 = 0; j < 16; j++) {
      let p = offset + j * 4;
      words[j] = <u32>data[p]
        | (<u32>data[p + 1] << 8)
        | (<u32>data[p + 2] << 16)
        | (<u32>data[p + 3] << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i: i32 = 0; i < 64; i++) {
      let f: u32 = 0;
      let g: i32 = 0;
      if (i < 16) {
        f = (b & c) | ((~b) & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | ((~d) & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | (~d));
        g = (7 * i) & 15;
      }

      let oldD = d;
      d = c;
      c = b;
      b = b + rotateLeft(a + f + MD5_K[i] + words[g], MD5_S[i]);
      a = oldD;
    }

    a0 += a;
    b0 += b;
    c0 += c;
    d0 += d;
  }

  return wordHexLe(a0) + wordHexLe(b0) + wordHexLe(c0) + wordHexLe(d0);
}

function rotateLeft(value: u32, shift: i32): u32 {
  return (value << shift) | (value >> (32 - shift));
}

function wordHexLe(value: u32): string {
  return byteHex(value & 255)
    + byteHex((value >> 8) & 255)
    + byteHex((value >> 16) & 255)
    + byteHex((value >> 24) & 255);
}

function byteHex(value: u32): string {
  return HEX_TABLE.charAt(<i32>((value >> 4) & 15)) + HEX_TABLE.charAt(<i32>(value & 15));
}

function hex8(value: u32): string {
  let out = "";
  for (let shift: i32 = 28; shift >= 0; shift -= 4) out += HEX_TABLE.charAt(<i32>((value >> shift) & 15));
  return out;
}

function hexValue(code: i32): i32 {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 65 + 10;
  if (code >= 97 && code <= 102) return code - 97 + 10;
  return -1;
}

function parseDecimal(value: string): i32 {
  let text = value.trim();
  let result: i32 = 0;
  let any = false;
  for (let i: i32 = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 48 || code > 57) break;
    any = true;
    result = result * 10 + code - 48;
  }
  return any ? result : -1;
}

// -----------------------------------------------------------------------------
// UI helpers
// -----------------------------------------------------------------------------

function stateName(state: i32): string {
  if (state == STATE_IDLE) return "IDLE";
  if (state == STATE_TCP_CONNECTING) return "TCP_CONNECTING";
  if (state == STATE_WAIT_OPTIONS) return "OPTIONS";
  if (state == STATE_WAIT_DESCRIBE) return "DESCRIBE";
  if (state == STATE_WAIT_SETUP) return "SETUP";
  if (state == STATE_WAIT_PLAY) return "PLAY";
  if (state == STATE_STREAMING) return "STREAMING";
  if (state == STATE_STOPPED) return "STOPPED";
  return "ERROR";
}

function tcpStateName(state: i32): string {
  if (state == 0) return "CONNECTING";
  if (state == 1) return "OPEN";
  if (state == 2) return "CLOSING";
  if (state == 3) return "CLOSED";
  return "ERROR";
}

function drawButton(x: i32, y: i32, w: i32, h: i32, label: string, color: u32): void {
  let hover = mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h;
  let bg = hover ? color : rgba(28, 36, 52);
  drawRect(x, y, w, h, bg);
  drawRect(x, y, w, 2, rgba(0, 243, 255));
  drawText(label, x + 8, y + 10, rgba(255, 255, 255), 1);
}
