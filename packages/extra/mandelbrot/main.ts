// WASM Parallel Fractal Rendering Engine
const WIDTH: i32 = 400;
const HEIGHT: i32 = 300;
export const pixels = new Uint8Array(WIDTH * HEIGHT * 4);

export function computeMandelbrot(zoom: f64, offsetX: f64, offsetY: f64): i32 {
  let maxIter: i32 = 100;

  for (let y: i32 = 0; y < HEIGHT; y++) {
    for (let x: i32 = 0; x < WIDTH; x++) {
      let zx: f64 = 0.0;
      let zy: f64 = 0.0;
      let cx: f64 = (x - WIDTH / 2) / (0.5 * zoom * WIDTH) + offsetX;
      let cy: f64 = (y - HEIGHT / 2) / (0.5 * zoom * HEIGHT) + offsetY;

      let iter: i32 = 0;
      while (zx * zx + zy * zy <= 4.0 && iter < maxIter) {
        let tmp = zx * zx - zy * zy + cx;
        zy = 2.0 * zx * zy + cy;
        zx = tmp;
        iter++;
      }

      let idx = (y * WIDTH + x) * 4;
      if (iter == maxIter) {
        pixels[idx] = 0;
        pixels[idx+1] = 0;
        pixels[idx+2] = 0;
      } else {
        pixels[idx] = <u8>((iter * 12) % 256);
        pixels[idx+1] = <u8>((iter * 5) % 256);
        pixels[idx+2] = <u8>((iter * 25) % 256);
      }
      pixels[idx+3] = 255;
    }
  }
  return pixels.dataStart;
}
export function getWidth():i32{return WIDTH;}
export function getHeight():i32{return HEIGHT;}
let cached:i32=0;
export function renderFrame():i32{if(!cached)cached=computeMandelbrot(1.0,-0.5,0.0);return cached;}
