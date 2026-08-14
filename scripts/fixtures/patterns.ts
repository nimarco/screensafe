import type { QrFixture } from './qrFixtures.ts';

/**
 * Raw RGBA images built without a canvas, so the same fixtures drive the Node
 * regression suite and the in-browser benchmarks.
 */
export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function blank(width: number, height: number, gray = 255): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(gray);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}

function px(img: RawImage, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4;
  img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
  img.data[i + 3] = 255;
}

function fillRect(img: RawImage, x: number, y: number, w: number, h: number, v: number): void {
  for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) px(img, x + dx, y + dy, v);
}

export interface QrDrawOptions {
  /** Pixels per module. Real scannable codes sit at 3 and up. */
  module?: number;
  /** Quiet-zone modules kept clear around the code. The spec asks for 4. */
  quiet?: number;
  x?: number;
  y?: number;
  dark?: number;
  light?: number;
}

/** Draw a fixture into an image and return the box of the code itself. */
export function drawQr(
  img: RawImage,
  fx: QrFixture,
  opts: QrDrawOptions = {},
): { x: number; y: number; w: number; h: number } {
  const m = opts.module ?? 6;
  const quiet = opts.quiet ?? 4;
  const n = fx.rows.length;
  const x0 = opts.x ?? 0;
  const y0 = opts.y ?? 0;
  const light = opts.light ?? 255;
  const dark = opts.dark ?? 0;
  fillRect(img, x0, y0, (n + quiet * 2) * m, (n + quiet * 2) * m, light);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (fx.rows[r][c] === '#') {
        fillRect(img, x0 + (c + quiet) * m, y0 + (r + quiet) * m, m, m, dark);
      }
    }
  }
  return { x: x0 + quiet * m, y: y0 + quiet * m, w: n * m, h: n * m };
}

/** A whole image that is one QR code on white. */
export function qrImage(fx: QrFixture, opts: QrDrawOptions = {}): RawImage {
  const m = opts.module ?? 6;
  const quiet = opts.quiet ?? 4;
  const side = (fx.rows.length + quiet * 2) * m;
  const img = blank(side, side);
  drawQr(img, fx, { ...opts, x: 0, y: 0 });
  return img;
}

/** Deterministic PRNG, so a failing decoy case is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Patterns that carry QR-ish structure without being QR codes. jsQR's locator
 * hunts for three ring-shaped finder patterns, so the interesting decoys are
 * the ones that supply them: bathroom tile, window grids, a checkerboard, and
 * most of all a deliberate trio of concentric squares around noise.
 */
export const DECOYS: Array<{ name: string; make: () => RawImage }> = [
  {
    name: 'checkerboard',
    make: () => {
      const img = blank(420, 420);
      for (let y = 0; y < 420; y += 12)
        for (let x = 0; x < 420; x += 12)
          if (((x / 12) & 1) === ((y / 12) & 1)) fillRect(img, x, y, 12, 12, 0);
      return img;
    },
  },
  {
    name: 'random-blocks',
    make: () => {
      const img = blank(420, 420);
      const r = rng(7);
      for (let y = 0; y < 420; y += 10)
        for (let x = 0; x < 420; x += 10) if (r() > 0.5) fillRect(img, x, y, 10, 10, 0);
      return img;
    },
  },
  {
    name: 'finder-lookalike',
    make: () => {
      // Three genuine QR finder patterns around a field of noise: structurally
      // the most convincing thing that is not a QR code.
      const img = blank(420, 420);
      const finder = (x: number, y: number) => {
        fillRect(img, x, y, 70, 70, 0);
        fillRect(img, x + 10, y + 10, 50, 50, 255);
        fillRect(img, x + 20, y + 20, 30, 30, 0);
      };
      finder(20, 20);
      finder(330, 20);
      finder(20, 330);
      const r = rng(11);
      for (let y = 110; y < 320; y += 10)
        for (let x = 110; x < 320; x += 10) if (r() > 0.5) fillRect(img, x, y, 10, 10, 0);
      return img;
    },
  },
  {
    name: 'window-grid',
    make: () => {
      const img = blank(420, 420, 40);
      for (let y = 10; y < 410; y += 34)
        for (let x = 10; x < 410; x += 26) fillRect(img, x, y, 18, 24, 230);
      return img;
    },
  },
  {
    name: 'barcode',
    make: () => {
      const img = blank(420, 420);
      const r = rng(3);
      for (let x = 0; x < 420; ) {
        const w = 2 + Math.floor(r() * 8);
        if (r() > 0.45) fillRect(img, x, 120, w, 180, 0);
        x += w;
      }
      return img;
    },
  },
  {
    name: 'dither-gradient',
    make: () => {
      const img = blank(420, 420);
      for (let y = 0; y < 420; y++)
        for (let x = 0; x < 420; x++) {
          const level = x / 420;
          const bayer = (((x & 3) * 4 + (y & 3)) % 16) / 16;
          px(img, x, y, level > bayer ? 255 : 0);
        }
      return img;
    },
  },
  {
    name: 'noise',
    make: () => {
      const img = blank(420, 420);
      const r = rng(23);
      for (let y = 0; y < 420; y++) for (let x = 0; x < 420; x++) px(img, x, y, r() > 0.5 ? 255 : 0);
      return img;
    },
  },
];
