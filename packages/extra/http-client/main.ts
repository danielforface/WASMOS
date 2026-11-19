// =============================================================================
// WASM ARCHITECT STUDIO - REAL INTERNET HTTP CLIENT & LIVE DASHBOARD
// =============================================================================

// Networking and framebuffer primitives are supplied by the current SDK.
// App Layout & Framebuffer
const WIDTH: i32 = 800;
const HEIGHT: i32 = 600;
export const pixels = new Uint32Array(WIDTH * HEIGHT);

let activeReqId: i32 = -1;
let statusMsg: string = "STANDBY: CLICK A BUTTON TO SEND REAL HTTP REQUEST";
let responsePreview: string = "";
let mouseX: i32 = 0;
let mouseY: i32 = 0;


export function getWidth(): i32 { return WIDTH; }
export function getHeight(): i32 { return HEIGHT; }

export function renderFrame(): i32 {
  // Poll non-blocking network requests
  if (activeReqId != -1) {
    let res = HttpClient.poll(activeReqId);
    if (res != null) {
      statusMsg = "RESPONSE STATUS: " + res.status.toString();
      responsePreview = res.body.slice(0, 500);
      activeReqId = -1;
    }
  }

  // Draw Background
  fill(rgba(13, 17, 23));

  // Header
  drawText("WASM INTERNET HTTP NETWORK CLIENT", 30, 25, rgba(0, 243, 255), 3);
  drawRect(30, 65, 740, 2, rgba(40, 50, 75));

  // Buttons Card
  drawRect(30, 85, 740, 70, rgba(22, 27, 34));
  drawButton(50, 100, 200, 40, "SEND GET (HTTPBIN)", rgba(0, 180, 255));
  drawButton(270, 100, 200, 40, "SEND POST (HTTPBIN)", rgba(0, 255, 157));

  // Status Card
  drawRect(30, 175, 740, 45, rgba(18, 22, 30));
  let statusColor = (activeReqId != -1) ? rgba(255, 170, 0) : rgba(0, 255, 157);
  drawText(statusMsg, 45, 190, statusColor, 2);

  // Response Terminal Card
  drawRect(30, 235, 740, 300, rgba(10, 14, 20));
  drawRect(30, 235, 740, 25, rgba(28, 35, 48));
  drawText("HTTP RESPONSE BODY (RAW PAYLOAD):", 45, 242, rgba(180, 200, 230), 1);

  if (responsePreview.length > 0) {
    renderWrappedText(responsePreview, 45, 275);
  } else {
    drawText("No network response data yet. Click one of the buttons above.", 45, 275, rgba(100, 115, 140), 1);
  }

  // System Footer
  let sec = (now_ms() / 1000.0).toString().slice(0, 8);
  drawText("WASM ASYNC SOCKET POLLER ACTIVE - " + sec + "s", 30, 560, rgba(100, 115, 140), 1);

  return <i32>pixels.dataStart;
}

export function mouseMove(x: i32, y: i32, buttons: i32, mods: i32): void {
  mouseX = x;
  mouseY = y;
}

export function mouseDown(button: i32, x: i32, y: i32, mods: i32): void {
  // GET Button
  if (x >= 50 && x <= 250 && y >= 100 && y <= 140) {
    statusMsg = "FETCHING: https://httpbin.org/get ...";
    responsePreview = "";
    activeReqId = HttpClient.get("https://httpbin.org/get");
  }

  // POST Button
  if (x >= 270 && x <= 470 && y >= 100 && y <= 140) {
    statusMsg = "POSTING: https://httpbin.org/post ...";
    responsePreview = "";
    activeReqId = HttpClient.post("https://httpbin.org/post", '{"sender":"WASM Studio","timestamp":' + now_ms().toString() + '}');
  }
}

function renderWrappedText(text: string, x: i32, y: i32): void {
  let lineY = y;
  let line = "";
  for (let i = 0; i < text.length; i++) {
    let ch = text.charAt(i);
    if (ch == "\n" || line.length >= 80) {
      drawText(line, x, lineY, rgba(0, 255, 157), 1);
      lineY += 15;
      line = (ch == "\n") ? "" : ch;
      if (lineY > 515) break;
    } else {
      line += ch;
    }
  }
  if (line.length > 0 && lineY <= 515) {
    drawText(line, x, lineY, rgba(0, 255, 157), 1);
  }
}

/** Built-in Graphics Engine **/
function fill(color: u32): void { pixels.fill(color); }
function drawButton(x: i32, y: i32, w: i32, h: i32, label: string, color: u32): void {
  let isHover = mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h;
  let bg = isHover ? color : rgba(32, 40, 58);
  drawRect(x, y, w, h, bg);
  drawRect(x, y, w, 2, rgba(0, 243, 255));
  drawText(label, x + 12, y + 14, rgba(255, 255, 255), 1);
}
