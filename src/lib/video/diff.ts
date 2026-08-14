/**
 * Frame-change gate.
 *
 * A screen recording is overwhelmingly static — the same editor window sits
 * there for twenty seconds at a time — while OCR costs ~0.5-2s per frame. So we
 * compute a cheap perceptual signature per frame and only pay for OCR when the
 * picture actually changed. It costs ~0.2ms per frame and removes most of the
 * OCR work on real recordings.
 *
 * Both the metric and the resolution are measured, not guessed — see
 * tools/diff-probe.html and tools/sig-res-probe.html.
 *
 * Two findings drove this design:
 *
 * 1. A whole-frame mean is useless here. When one line of text appears, ~20
 *    cells change and ~14000 don't, so the mean moves by less than 1.5 — right
 *    on top of the noise floor. Counting *how many* cells moved separates the
 *    two cleanly.
 *
 * 2. Resolution matters more than either threshold. At 64x36 each cell averages
 *    a 20x20px block, and thin antialiased UI text disappears into it entirely:
 *
 *      transition                  64x36    160x90
 *      line appears (19.5→20.0)   0 cells   45 cells
 *      line appears (19.0→19.5)   3 cells   13 cells
 *      line appears (18.5→19.0)   3 cells  101 cells
 *      static                     0 cells    0 cells
 *
 *    At 64x36 a real change was indistinguishable from noise, so the scanner
 *    silently skipped frames containing live credentials. At 160x90 there is a
 *    wide margin.
 *
 * The thresholds sit deliberately low. A false "changed" costs one extra OCR
 * pass; a false "unchanged" means a secret is never read at all. Only one of
 * those is recoverable.
 */

export const SIG_W = 160;
export const SIG_H = 90;

export type Signature = Uint8Array;

/** A cell must move this much (0-255 luma) to count as changed. */
const CELL_DELTA = 14;
/** ...and this many cells must move. Smallest real change measured was 13. */
const CELL_COUNT = 8;
/** Fallback for global changes (fades, theme switches) that shift everything a little. */
const MEAN_THRESHOLD = 1.0;

let sigCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let sigCtx: CanvasRenderingContext2D | null = null;

function ctx(): CanvasRenderingContext2D {
  if (!sigCtx) {
    sigCanvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(SIG_W, SIG_H)
        : Object.assign(document.createElement('canvas'), { width: SIG_W, height: SIG_H });
    sigCtx = (sigCanvas as HTMLCanvasElement).getContext('2d', {
      willReadFrequently: true,
      alpha: false,
    }) as CanvasRenderingContext2D;
  }
  return sigCtx;
}

export function signatureOf(source: CanvasImageSource): Signature {
  const c = ctx();
  c.drawImage(source, 0, 0, SIG_W, SIG_H);
  const { data } = c.getImageData(0, 0, SIG_W, SIG_H);
  const sig = new Uint8Array(SIG_W * SIG_H);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Rec. 601 luma, integer math.
    sig[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return sig;
}

/** Average brightness of a frame, 0-255. Free — we already built the signature. */
export function meanLuma(sig: Signature): number {
  let sum = 0;
  for (let i = 0; i < sig.length; i++) sum += sig[i];
  return sum / sig.length;
}

export interface ChangeInfo {
  changed: boolean;
  mean: number;
  cells: number;
}

export function compare(a: Signature | null, b: Signature): ChangeInfo {
  if (!a) return { changed: true, mean: 255, cells: b.length };
  let sum = 0;
  let cells = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > CELL_DELTA) cells++;
  }
  const mean = sum / a.length;
  return { changed: cells >= CELL_COUNT || mean >= MEAN_THRESHOLD, mean, cells };
}

/**
 * Compare against the last *analysed* frame rather than the previous sample, so
 * a slow drip of small changes still accumulates past the threshold instead of
 * sliding under it one sample at a time.
 */
export function hasChanged(lastAnalysed: Signature | null, current: Signature): boolean {
  return compare(lastAnalysed, current).changed;
}
