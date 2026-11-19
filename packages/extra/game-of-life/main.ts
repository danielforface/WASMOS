// Conway's Game of Life in WASM
const WIDTH: i32 = 100;
const HEIGHT: i32 = 75;
let currentGrid = new Uint8Array(WIDTH * HEIGHT);
let nextGrid = new Uint8Array(WIDTH * HEIGHT);
export const pixels = new Uint8Array(WIDTH * HEIGHT * 4 * 16); // 4x scaled pixel buffer
let initialized: boolean = false;

function seed(): void {
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    currentGrid[i] = (Math.random() > 0.7) ? 1 : 0;
  }
  initialized = true;
}

export function step(): i32 {
  if (!initialized) seed();

  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx == 0 && dy == 0) continue;
          let nx = (x + dx + WIDTH) % WIDTH;
          let ny = (y + dy + HEIGHT) % HEIGHT;
          neighbors += currentGrid[ny * WIDTH + nx];
        }
      }

      let idx = y * WIDTH + x;
      let state = currentGrid[idx];
      if (state == 1 && (neighbors == 2 || neighbors == 3)) {
        nextGrid[idx] = 1;
      } else if (state == 0 && neighbors == 3) {
        nextGrid[idx] = 1;
      } else {
        nextGrid[idx] = 0;
      }
    }
  }

  // Copy nextGrid to currentGrid
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    currentGrid[i] = nextGrid[i];
  }

  // Render to 4x Pixel Buffer (400x300)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let alive = currentGrid[y * WIDTH + x] == 1;
      let r: u8 = alive ? 0 : 15;
      let g: u8 = alive ? 255 : 23;
      let b: u8 = alive ? 157 : 42;

      // Draw 4x4 block per cell
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          let screenX = x * 4 + px;
          let screenY = y * 4 + py;
          let pIdx = (screenY * (WIDTH * 4) + screenX) * 4;
          pixels[pIdx] = r;
          pixels[pIdx+1] = g;
          pixels[pIdx+2] = b;
          pixels[pIdx+3] = 255;
        }
      }
    }
  }

  return pixels.dataStart;
}

export function getWidth(): i32 { return WIDTH * 4; }
export function getHeight(): i32 { return HEIGHT * 4; }
export function renderFrame():i32{return step();}
