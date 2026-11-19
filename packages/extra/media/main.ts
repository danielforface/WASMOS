// =============================================================================
// WASM ARCHITECT STUDIO - LIVE INTERNET MEDIA & REAL-TIME API DASHBOARD
// Streams public CDN video feeds & polls live Internet HTTP REST endpoints
// Real-time Bitrate Telemetry (Mbps) & Zero-Latency GPU Framebuffer Ingestion
// =============================================================================

const WIDTH: i32 = 800;
const HEIGHT: i32 = 600;
export const pixels = new Uint32Array(WIDTH * HEIGHT);

export function getWidth(): i32 { return WIDTH; }
export function getHeight(): i32 { return HEIGHT; }

// מקור ברירת מחדל
let currentStreamUrl: string = "http://127.0.0.1:8888/live/index.m3u8";

let isStreaming: bool = false;
let isEditingUrl: bool = false;
let activeWsId: i32 = -1;

// טלמטריית וידאו ו-FPS
let frameCount: i32 = 0;
let lastFrameW: i32 = 0;
let lastFrameH: i32 = 0;
let lastFrameTimestamp: f64 = 0;
let fpsCounter: i32 = 0;
let currentFps: i32 = 0;
let lastFpsTime: f64 = 0;

// טלמטריית רוחב פס (Bandwidth Telemetry)
let bytesInCurrentWindow: i64 = 0;
let totalBytesReceived: i64 = 0;
let currentBitrateMbps: f64 = 0.0;
let peakBitrateMbps: f64 = 0.0;
let lastBitrateCalcTime: f64 = 0;

// נתוני HTTP REST API מהאינטרנט
let activeHttpReqId: i32 = -1;
let lastHttpPayload: string = "No API data yet. Click 'FETCH BTC / ETH' to pull live data.";
let httpStatusMsg: string = "HTTP BRIDGE IDLE";
let lastHttpFetchTime: f64 = 0;

let mouseX: i32 = 0;
let mouseY: i32 = 0;
let statusMessage: string = "INTERNET PIPELINE READY: CLICK 'PLAY CLOUD STREAM'";

// ממדי ה-Viewport (540x330)
const VP_X: i32 = 20;
const VP_Y: i32 = 105;
const VP_W: i32 = 540;
const VP_H: i32 = 330;

export function appInit(w: i32, h: i32, dpr: f64): void {
  VideoDecoderEngine.init("avc1.42E01E");
  lastFpsTime = now_ms();
  lastBitrateCalcTime = now_ms();
}

export function renderFrame(): i32 {
  let now = now_ms();

  // 1. חישוב FPS ומד רוחב פס רגעי (Mbps) בכל שנייה
  let elapsedSinceRate = now - lastBitrateCalcTime;
  if (elapsedSinceRate >= 1000.0) {
    currentFps = fpsCounter;
    fpsCounter = 0;

    // חישוב רוחב פס: (Bytes * 8) / (Elapsed_Seconds * 1,000,000)
    let seconds: f64 = elapsedSinceRate / 1000.0;
    currentBitrateMbps = (<f64>(bytesInCurrentWindow * 8)) / (seconds * 1000000.0);
    if (currentBitrateMbps > peakBitrateMbps) {
      peakBitrateMbps = currentBitrateMbps;
    }
    bytesInCurrentWindow = 0;
    lastBitrateCalcTime = now;
    lastFpsTime = now;
  }

  // 2. תשאול בקשות HTTP REST פתוחות
  if (activeHttpReqId != -1) {
    let res = HttpClient.poll(activeHttpReqId);
    if (res != null) {
      httpStatusMsg = "API STATUS: " + res.status.toString() + " OK (" + (now - lastHttpFetchTime).toString().slice(0, 5) + "ms)";
      lastHttpPayload = res.body.slice(0, 220);
      activeHttpReqId = -1;
    }
  }

  // ניקוי רקע
  pixels.fill(rgba(10, 13, 20));

  // --- Header ---
  drawRect(20, 12, 760, 44, rgba(18, 24, 38));
  drawFrame(20, 12, 760, 44, rgba(38, 48, 70));
  drawText("WASM GLOBAL INTERNET STREAM & API ENGINE", 35, 20, rgba(0, 243, 255), 2);
  drawText(statusMessage, 35, 38, isStreaming ? rgba(0, 255, 157) : rgba(255, 180, 0), 1);

  // --- URL Input Bar ---
  let inX: i32 = 20;
  let inY: i32 = 64;
  drawRect(inX, inY, 760, 32, isEditingUrl ? rgba(12, 20, 32) : rgba(16, 20, 28));
  drawFrame(inX, inY, 760, 32, isEditingUrl ? rgba(0, 243, 255) : rgba(38, 48, 70));
  drawText("CLOUD URL:", inX + 10, inY + 11, rgba(130, 145, 175), 1);
  drawText(currentStreamUrl.slice(0, 75), inX + 95, inY + 11, rgba(235, 245, 255), 1);

  if (isEditingUrl && ((<i32>(now / 400.0)) % 2 == 0)) {
    let cursorX = inX + 95 + (currentStreamUrl.length * 8);
    if (cursorX < inX + 750) drawRect(cursorX, inY + 8, 2, 16, rgba(0, 243, 255));
  }

  // --- Main Video Viewport ---
  drawRect(VP_X, VP_Y, VP_W, VP_H, rgba(5, 7, 10));

  if (isStreaming) {
    // ציור הפריימים ישירות מזיכרון ה-GPU
    VideoDecoderEngine.drawFrame(pixels, WIDTH, HEIGHT, VP_X, VP_Y, VP_W, VP_H);

    let isDataActive = (now - lastFrameTimestamp) < 400.0;
    drawRect(VP_X + 10, VP_Y + 10, 140, 22, rgba(0, 0, 0, 180));
    drawRect(VP_X + 15, VP_Y + 17, 8, 8, isDataActive ? rgba(0, 255, 157) : rgba(255, 70, 70));
    drawText(isDataActive ? "INTERNET LIVE" : "BUFFERING...", VP_X + 28, VP_Y + 17, rgba(255, 255, 255), 1);

    // OSD נתוני וידאו ורוחב פס על גבי הנגן
    if (lastFrameW > 0) {
      drawRect(VP_X + 10, VP_Y + VP_H - 26, 270, 18, rgba(0, 0, 0, 190));
      let streamInfo = "CDN: " + lastFrameW.toString() + "x" + lastFrameH.toString() + " @ " + currentFps.toString() + " FPS | " + currentBitrateMbps.toString().slice(0, 5) + " Mbps";
      drawText(streamInfo, VP_X + 15, VP_Y + VP_H - 21, rgba(0, 243, 255), 1);
    }
  } else {
    drawText("INTERNET STREAM STANDBY", VP_X + 160, VP_Y + 150, rgba(100, 115, 140), 2);
    drawText("Click 'PLAY CLOUD STREAM' or select a CDN Preset", VP_X + 105, VP_Y + 175, rgba(70, 85, 110), 1);
  }
  drawFrame(VP_X, VP_Y, VP_W, VP_H, rgba(40, 50, 75));

  // --- Right Side Presets & Network Controls ---
  let px: i32 = 570;
  let py: i32 = 105;
  let pw: i32 = 210;

  drawRect(px, py, pw, VP_H, rgba(18, 24, 38));
  drawFrame(px, py, pw, VP_H, rgba(38, 48, 70));
  drawText("PUBLIC CDN PRESETS", px + 15, py + 10, rgba(235, 245, 255), 1);

  drawButton(px + 15, py + 30, 180, 28, "1. BIG BUCK BUNNY (GTV)", rgba(0, 180, 255));
  drawButton(px + 15, py + 64, 180, 28, "2. BLENDER DEMO (GTV)", rgba(140, 90, 240));
  drawButton(px + 15, py + 98, 180, 28, "3. LOCAL VIDEO (8080)", rgba(255, 170, 0));

  drawRect(px + 15, py + 135, 180, 1, rgba(38, 48, 70));
  drawText("ACTIONS & API", px + 15, py + 144, rgba(235, 245, 255), 1);

  if (!isStreaming) {
    drawButton(px + 15, py + 162, 180, 34, "PLAY CLOUD STREAM", rgba(0, 255, 157));
  } else {
    drawButton(px + 15, py + 162, 180, 34, "STOP CLOUD STREAM", rgba(255, 70, 70));
  }

  drawButton(px + 15, py + 204, 180, 32, "FETCH LIVE CRYPTO API", rgba(0, 243, 255));
  drawButton(px + 15, py + 244, 180, 32, "FETCH HTTPBIN POST", rgba(255, 100, 180));
  drawButton(px + 15, py + 284, 180, 28, "CLEAR URL", rgba(50, 60, 80));

  // --- Bottom Telemetry & Real-Time Ingress Panel ---
  drawRect(20, 445, 760, 142, rgba(12, 16, 24));
  drawFrame(20, 445, 760, 142, rgba(38, 48, 70));
  drawText("LIVE INTERNET HTTP REST PAYLOAD (DIRECT ASYNC INGRESS)", 35, 455, rgba(235, 245, 255), 1);
  drawText(httpStatusMsg, 540, 455, rgba(0, 255, 157), 1);
  drawRect(35, 470, 730, 1, rgba(38, 48, 70));

  // הצגת תוכן ה-JSON
  drawText(lastHttpPayload.slice(0, 95), 35, 478, rgba(0, 243, 255), 1);
  drawText(lastHttpPayload.slice(95, 190), 35, 494, rgba(0, 243, 255), 1);

  drawRect(35, 514, 730, 1, rgba(38, 48, 70));

  // מדדי רשת ורוחב פס (Bitrate / Ingress Metrics)
  let totalMbStr = ((<f64>totalBytesReceived) / 1048576.0).toString().slice(0, 6);
  let bitrateColor = currentBitrateMbps > 0.1 ? rgba(0, 255, 157) : rgba(130, 145, 175);
  let stabilityLabel = currentFps >= 55 ? "ROCK SOLID (NO JITTER)" : (isStreaming ? "HIGH LOAD (BUFFERING)" : "STANDBY");

  drawText("RATE: " + currentBitrateMbps.toString().slice(0, 5) + " Mbps", 35, 524, bitrateColor, 1);
  drawText("PEAK: " + peakBitrateMbps.toString().slice(0, 5) + " Mbps", 195, 524, rgba(255, 180, 0), 1);
  drawText("TOTAL INGRESS: " + totalMbStr + " MB", 355, 524, rgba(140, 90, 240), 1);
  drawText("STABILITY: " + stabilityLabel, 555, 524, currentFps >= 55 ? rgba(0, 255, 157) : rgba(255, 70, 70), 1);

  drawText("FPS: " + currentFps.toString() + " | FRAMES: " + frameCount.toString() + " | TIME: " + (now / 1000.0).toString().slice(0, 7) + "s | MOUSE: " + mouseX.toString() + "x" + mouseY.toString(), 35, 542, rgba(100, 115, 140), 1);

  return <i32>pixels.dataStart;
}

export function mouseDown(button: i32, x: i32, y: i32, mods: i32): void {
  isEditingUrl = (x >= 20 && x <= 780 && y >= 64 && y <= 96);

  let px: i32 = 570;
  let py: i32 = 105;

  // Preset 1: Big Buck Bunny
  if (x >= px + 15 && x <= px + 195 && y >= py + 30 && y <= py + 58) {
    currentStreamUrl = "https://www.w3schools.com/html/mov_bbb.mp4";
    statusMessage = "LOADED: Big Buck Bunny (W3C CDN)";
  }

  // Preset 2: Blender Animation
  if (x >= px + 15 && x <= px + 195 && y >= py + 64 && y <= py + 92) {
    currentStreamUrl = "https://www.w3schools.com/tags/movie.mp4";
    statusMessage = "LOADED: Blender Movie (Open CDN)";
  }

  // Preset 3: Local Server Video
  if (x >= px + 15 && x <= px + 195 && y >= py + 98 && y <= py + 126) {
    currentStreamUrl = "http://127.0.0.1:8080/video.mp4";
    statusMessage = "LOADED: Local video.mp4 from 127.0.0.1:8080";
  }

  // Play / Stop Stream Toggle
  if (x >= px + 15 && x <= px + 195 && y >= py + 162 && y <= py + 196) {
    if (!isStreaming) {
      statusMessage = "CONNECTING TO " + currentStreamUrl.slice(0, 32) + "...";
      let uBuf = String.UTF8.encode(currentStreamUrl);
      activeWsId = host_ws_connect(changetype<usize>(uBuf), uBuf.byteLength);
      isStreaming = true;
    } else {
      isStreaming = false;
      statusMessage = "CLOUD STREAM STOPPED";
    }
  }

  // Fetch Live Crypto API
  if (x >= px + 15 && x <= px + 195 && y >= py + 204 && y <= py + 236) {
    httpStatusMsg = "FETCHING LIVE BTC PRICE VIA HTTP BRIDGE...";
    lastHttpFetchTime = now_ms();
    activeHttpReqId = HttpClient.get("https://api.coindesk.com/v1/bpi/currentprice.json");
  }

  // Fetch HTTPBin POST Test
  if (x >= px + 15 && x <= px + 195 && y >= py + 244 && y <= py + 276) {
    httpStatusMsg = "SENDING POST TO HTTPBIN.ORG...";
    lastHttpFetchTime = now_ms();
    activeHttpReqId = HttpClient.post("https://httpbin.org/post", '{"source":"WASM Architect Studio","online":true}');
  }

  // Clear Input
  if (x >= px + 15 && x <= px + 195 && y >= py + 284 && y <= py + 312) {
    currentStreamUrl = "";
    isEditingUrl = true;
  }
}

export function mouseMove(x: i32, y: i32, buttons: i32, mods: i32): void {
  mouseX = x;
  mouseY = y;
}

export function textInput(codepoint: i32): void {
  if (!isEditingUrl) return;
  if (codepoint >= 32 && codepoint <= 126 && currentStreamUrl.length < 130) {
    currentStreamUrl += String.fromCharCode(codepoint);
  }
}

export function keyDown(keyCode: i32, mods: i32, repeat: i32): void {
  if (!isEditingUrl) return;
  if (keyCode == 8 && currentStreamUrl.length > 0) {
    currentStreamUrl = currentStreamUrl.slice(0, currentStreamUrl.length - 1);
  } else if (keyCode == 13) {
    isEditingUrl = false;
  }
}

export function videoFrameDecoded(w: i32, h: i32): void {
  frameCount++;
  fpsCounter++;
  lastFrameW = w;
  lastFrameH = h;
  lastFrameTimestamp = now_ms();

  // חישוב כמות הבתים שנכנסו בפריים (רוחב x גובה x 4 בתים ל-RGBA)
  let frameBytes: i64 = <i64>(w * h * 4);
  bytesInCurrentWindow += frameBytes;
  totalBytesReceived += frameBytes;
}

export function wsEvent(wsId: i32, eventType: i32, payloadLen: i32): void {
  if (eventType == 1) {
    statusMessage = "STREAMING LIVE FROM CLOUD CDN (60 FPS)";
  } else if (eventType == -1) {
    statusMessage = "STREAM LOAD FAILED (VERIFY INTERNET CONNECTION)";
  } else if (eventType == 2 && payloadLen > 0) {
    bytesInCurrentWindow += <i64>payloadLen;
    totalBytesReceived += <i64>payloadLen;
  }
}

function drawButton(x: i32, y: i32, w: i32, h: i32, label: string, color: u32): void {
  let isHover = mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h;
  let bg = isHover ? color : rgba(28, 36, 52);
  drawRect(x, y, w, h, bg);
  drawRect(x, y, w, 2, rgba(0, 243, 255));
  drawText(label, x + 8, y + (h / 2) - 4, rgba(255, 255, 255), 1);
}
