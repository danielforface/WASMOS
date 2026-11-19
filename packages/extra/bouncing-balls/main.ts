// WASM High Performance Graphics Buffer Engine
const WIDTH: i32 = 400;
const HEIGHT: i32 = 300;
const BALL_COUNT: i32 = 40;

// Linear memory buffer for pixel RGBA data (400 * 300 * 4 bytes)
export const pixels = new Uint8Array(WIDTH * HEIGHT * 4);

// Ball state arrays
let px = new Float32Array(BALL_COUNT);
let py = new Float32Array(BALL_COUNT);
let vx = new Float32Array(BALL_COUNT);
let vy = new Float32Array(BALL_COUNT);
let radius = new Float32Array(BALL_COUNT);
let initialized: boolean = false;

function init(): void {
  for (let i = 0; i < BALL_COUNT; i++) {
    px[i] = 100.0 + <f32>((i * 7) % (WIDTH - 50));
    py[i] = 100.0 + <f32>((i * 11) % (HEIGHT - 50));
    vx[i] = <f32>((i % 5) + 1.5) * (i % 2 == 0 ? 1.0 : -1.0);
    vy[i] = <f32>(((i * 3) % 4) + 1.2) * (i % 3 == 0 ? 1.0 : -1.0);
    radius[i] = 6.0 + <f32>(i % 8);
  }
  initialized = true;
}

export function renderFrame(): i32 {
  if (!initialized) init();

  // Clear canvas background to deep purple/dark blue (RGBA)
  let len = WIDTH * HEIGHT * 4;
  for (let i = 0; i < len; i += 4) {
    pixels[i] = 10;     // R
    pixels[i+1] = 14;   // G
    pixels[i+2] = 26;   // B
    pixels[i+3] = 255;  // A
  }

  // Update physics and draw balls into WASM linear memory
  for (let b = 0; b < BALL_COUNT; b++) {
    px[b] += vx[b];
    py[b] += vy[b];

    let r = radius[b];
    if (px[b] - r < 0 || px[b] + r >= <f32>WIDTH) vx[b] *= -1.0;
    if (py[b] - r < 0 || py[b] + r >= <f32>HEIGHT) vy[b] *= -1.0;

    // Render ball to pixel buffer
    let cx = <i32>px[b];
    let cy = <i32>py[b];
    let rad = <i32>r;

    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        if (dx*dx + dy*dy <= rad*rad) {
          let x = cx + dx;
          let y = cy + dy;
          if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
            let idx = (y * WIDTH + x) * 4;
            pixels[idx] = <u8>(0);                   // R
            pixels[idx+1] = <u8>(200 + (b * 5) % 55); // G
            pixels[idx+2] = <u8>(255);               // B
            pixels[idx+3] = 255;                     // A
          }
        }
      }
    }
  }

  return pixels.dataStart; // Return WASM memory offset
}
export function getWidth():i32{return WIDTH;}
export function getHeight():i32{return HEIGHT;}
