// =============================================================================
// WASM ARCHITECT STUDIO - LIVE RTSP / H.264 HARDWARE CAMERA PLAYER
// =============================================================================

const WIDTH: i32 = 800;
const HEIGHT: i32 = 600;
export const pixels = new Uint32Array(WIDTH * HEIGHT);

let streamId:i32=-1;
let endpoint:string="http://127.0.0.1:8889/live/whep";
let isPlaying: bool = false;
let statusMsg: string = "STANDBY: CLICK CONNECT FOR LOCAL WHEP";
let mouseX: i32 = 0;
let mouseY: i32 = 0;
let frameCount: i32 = 0;

export function getWidth(): i32 { return WIDTH; }
export function getHeight(): i32 { return HEIGHT; }

export function appInit(w: i32, h: i32, dpr: f64): void {
  VideoDecoderEngine.init("avc1.42E01E"); // H.264 Baseline Profile
}

export function renderFrame(): i32 {
  // Clear Background
  pixels.fill(rgba(10, 13, 20));

  // Top Bar & OSD
  drawRect(20, 15, 760, 50, rgba(22, 27, 34));
  drawText("WHEP CAMERA PLAYER", 35, 25, rgba(0, 243, 255), 2);
  drawText(statusMsg, 35, 48, isPlaying ? rgba(0, 255, 157) : rgba(255, 180, 0), 1);

  // Video Viewport Area (640x360 16:9 Aspect Ratio)
  let vx: i32 = 20;
  let vy: i32 = 75;
  let vw: i32 = 640;
  let vh: i32 = 360;

  drawRect(vx, vy, vw, vh, rgba(5, 7, 10));
  drawFrame(vx, vy, vw, vh, rgba(40, 50, 75));

  if (isPlaying) {
    // Blit hardware decoded RGBA frames directly into the WASM framebuffer
    VideoDecoderEngine.drawFrame(pixels, WIDTH, HEIGHT, vx, vy, vw, vh);

    // Live On-Screen Display (OSD) Overlay
    drawRect(vx + 10, vy + 10, 110, 24, rgba(0, 0, 0, 180));
    drawRect(vx + 15, vy + 18, 8, 8, rgba(255, 0, 0));
    drawText("REC LIVE", vx + 30, vy + 18, rgba(255, 255, 255), 1);
  } else {
    drawText("NO ACTIVE VIDEO FEED", vx + 220, vy + 170, rgba(100, 115, 140), 2);
  }

  // Right Side Control Panel Card
  let px: i32 = 670;
  let py: i32 = 75;
  drawRect(px, py, 110, 360, rgba(22, 27, 34));
  drawFrame(px, py, 110, 360, rgba(40, 50, 75));

  drawButton(px + 10, py + 15, 90, 35, "CONNECT", rgba(0, 180, 255));
  drawText("LOCAL WHEP", px+10, py+60, rgba(0,255,157), 1);
  drawButton(px + 10, py + 105, 90, 35, "STOP", rgba(255, 70, 70));

  // Telemetry Section
  drawRect(20, 445, 760, 130, rgba(16, 20, 28));
  drawFrame(20, 445, 760, 130, rgba(40, 50, 75));
  drawText("STREAM TELEMETRY & PROTOCOL LOGS", 35, 455, rgba(180, 200, 230), 1);
  drawText("CODEC: NEGOTIATED BY MEDIA SOURCE", 35, 480, rgba(0, 243, 255), 1);
  drawText("TRANSPORT: WHEP / configured local media server", 35, 500, rgba(130, 145, 175), 1);
  drawText("FRAMES DECODED: " + frameCount.toString() + " | TIME: " + (now_ms() / 1000.0).toString().slice(0, 7) + "s", 35, 520, rgba(0, 255, 157), 1);

  return <i32>pixels.dataStart;
}

export function mouseMove(x: i32, y: i32, buttons: i32, mods: i32): void {
  mouseX = x;
  mouseY = y;
}

export function mouseDown(button: i32, x: i32, y: i32, mods: i32): void {
  if(x>=680&&x<=770&&y>=90&&y<=125&&streamId<0){let b=String.UTF8.encode(endpoint);streamId=host_ws_connect(changetype<usize>(b),b.byteLength);statusMsg=streamId<0?"CONNECTION FAILED":"CONNECTING TO LOCAL WHEP...";}
  if(x>=680&&x<=770&&y>=180&&y<=215)appStop();
}
export function wsEvent(id:i32,event:i32,length:i32):void{if(id!=streamId)return;if(event==1){statusMsg="CONNECTED - WAITING FOR VIDEO";}else if(event==0||event<0){appStop();statusMsg="WHEP DISCONNECTED";}}
export function appStop():void{let id=streamId;streamId=-1;if(id>=0)host_ws_close(id);isPlaying=false;statusMsg="STOPPED";}
// Callback invoked by WebCodecs whenever a hardware frame is decoded
export function videoFrameDecoded(w: i32, h: i32): void {
  if(streamId>=0){isPlaying=true;statusMsg="RECEIVING VIDEO";frameCount++;}
}

function drawButton(x: i32, y: i32, w: i32, h: i32, label: string, color: u32): void {
  let isHover = mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h;
  let bg = isHover ? color : rgba(32, 40, 58);
  drawRect(x, y, w, h, bg);
  drawRect(x, y, w, 2, rgba(0, 243, 255));
  drawText(label, x + 10, y + 12, rgba(255, 255, 255), 1);
}
