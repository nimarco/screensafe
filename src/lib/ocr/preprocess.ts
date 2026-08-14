/**
 * Getting text in front of the OCR engine when the frame is not a screenshot.
 *
 * Tesseract assumes it has been handed a page: upright lines, sensible glyph
 * height, one dominant text block. A screen recording satisfies all three, which
 * is why the whole-frame pass works and why it stays the default. A camera
 * pointed at a monitor satisfies none of them — the screen is a fraction of the
 * frame, its baselines are rotated, the camera is off-axis so the lines
 * converge, and the characters land at a fraction of the height the engine wants.
 * The result is not a bad read. It is zero lines: the layout analyser never
 * finds a text block to hand to the recogniser, so the detectors are never
 * given a single character to judge.
 *
 * Everything here exists to rebuild that page. Find where the text is, measure
 * how it is rotated and how big it is, and re-render it as the upright,
 * appropriately-sized block the engine was trained on — while keeping the
 * transform, so a box drawn around a secret in the rebuilt image still lands on
 * the right pixels of the original frame.
 */

import type { Box } from '../types';

/** Long edge of the buffer the layout measurements run on. */
const ANALYSIS_LONG_EDGE = 480;

/** Analysis grid cell, in analysis pixels. */
const CELL = 8;

/** Skew search half-range. Beyond this a frame is not a photographed screen. */
const MAX_SKEW_DEG = 14;

/** Cap height Tesseract is happiest at, in pixels. */
const TARGET_CAP_PX = 26;

/** Cap height as a fraction of baseline pitch, for typical editor line spacing. */
const CAP_PER_PITCH = 0.48;

export interface TextLayout {
  /** Fraction of the frame whose local structure reads as text. */
  density: number;
  /** The dominant text block in source pixels, or null when there is none. */
  region: Box | null;
  /** Baseline rotation in degrees; positive tilts the text clockwise. */
  skewDeg: number;
  /** Baseline-to-baseline distance in source pixels; 0 when not measurable. */
  linePitch: number;
  /** True when the text block is light-on-dark. */
  dark: boolean;
}

interface Analysis {
  luma: Float32Array;
  gx: Float32Array;
  w: number;
  h: number;
  /** Multiply an analysis coordinate by this to get a source coordinate. */
  scale: number;
}

function scratch(w: number, h: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
} {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = (canvas as HTMLCanvasElement).getContext('2d', {
    willReadFrequently: true,
    alpha: false,
  }) as CanvasRenderingContext2D;
  return { canvas, ctx };
}

function analyse(source: CanvasImageSource, width: number, height: number): Analysis {
  const long = Math.max(width, height);
  const scale = long > ANALYSIS_LONG_EDGE ? long / ANALYSIS_LONG_EDGE : 1;
  const w = Math.max(1, Math.round(width / scale));
  const h = Math.max(1, Math.round(height / scale));
  const { ctx } = scratch(w, h);
  ctx.drawImage(source, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const luma = new Float32Array(w * h);
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  // Horizontal gradient only. Text is a picket fence of vertical strokes, so
  // |dI/dx| separates it from the gradients, bezels and soft shadows that a
  // photograph is otherwise full of — those vary smoothly across x.
  const gx = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      gx[row + x] = Math.abs(luma[row + x + 1] - luma[row + x - 1]);
    }
  }

  return { luma, gx, w, h, scale };
}

interface CellGrid {
  score: Float32Array;
  cols: number;
  rows: number;
}

function cellScores(a: Analysis): CellGrid {
  const cols = Math.max(1, Math.ceil(a.w / CELL));
  const rows = Math.max(1, Math.ceil(a.h / CELL));
  const score = new Float32Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * CELL;
      const y0 = cy * CELL;
      const x1 = Math.min(a.w, x0 + CELL);
      const y1 = Math.min(a.h, y0 + CELL);
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * a.w;
        for (let x = x0; x < x1; x++) {
          sum += a.gx[row + x];
          n++;
        }
      }
      score[cy * cols + cx] = n ? sum / n : 0;
    }
  }
  return { score, cols, rows };
}

function percentile(values: Float32Array, p: number): number {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort();
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

/**
 * The biggest blob of text-like cells.
 *
 * A plain bounding box over every busy cell is not good enough: one glare
 * highlight on the bezel, or a patterned surface behind the laptop, drags the
 * box out to the frame edges and the crop stops being a crop. Growing the
 * largest connected component instead keeps the region on the thing that is
 * actually made of text.
 */
function largestComponent(grid: CellGrid, threshold: number): { x0: number; y0: number; x1: number; y1: number } | null {
  const { score, cols, rows } = grid;
  const on = new Uint8Array(cols * rows);
  for (let i = 0; i < on.length; i++) on[i] = score[i] >= threshold ? 1 : 0;

  // One round of dilation so a blank line inside a code block, or the gutter
  // between a keyword and its value, does not split one region into three.
  const grown = new Uint8Array(on.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          if (on[ny * cols + nx]) {
            any = 1;
            break;
          }
        }
      }
      grown[y * cols + x] = any;
    }
  }

  const seen = new Uint8Array(grown.length);
  const stack: number[] = [];
  let best: { x0: number; y0: number; x1: number; y1: number; size: number } | null = null;

  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let size = 0;
    let x0 = cols;
    let y0 = rows;
    let x1 = -1;
    let y1 = -1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % cols;
      const y = (i / cols) | 0;
      size++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x < cols - 1 ? i + 1 : -1,
        y > 0 ? i - cols : -1,
        y < rows - 1 ? i + cols : -1,
      ];
      for (const n of neighbours) {
        if (n < 0 || seen[n] || !grown[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (!best || size > best.size) best = { x0, y0, x1, y1, size };
  }

  return best ? { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1 } : null;
}

/**
 * Weighted projection profile sharpness at a given shear.
 *
 * Rows of text project into a comb: dense where a line of glyphs sits, empty in
 * the leading between lines. Shear the projection to match the baselines and
 * the comb's teeth line up, which maximises the sum of squared bucket weights.
 * Any other angle smears neighbouring lines into each other and flattens it.
 * Over the small angles we care about, shear and rotation are the same thing,
 * and shear costs one multiply per pixel.
 */
function profileFor(a: Analysis, box: { x0: number; y0: number; x1: number; y1: number }, shear: number): Float32Array {
  const height = box.y1 - box.y0;
  const width = box.x1 - box.x0;
  const span = Math.ceil(height + Math.abs(shear) * width) + 2;
  // Negative shears push buckets below zero at the right-hand edge; bias the
  // whole profile so both directions land inside the same array.
  const bias = shear < 0 ? -shear * width : 0;
  const profile = new Float32Array(span);
  for (let y = box.y0; y < box.y1; y++) {
    const row = y * a.w;
    for (let x = box.x0; x < box.x1; x += 2) {
      const v = a.gx[row + x];
      if (v < 8) continue; // ignore flat pixels; they only add a DC offset
      const b = Math.round(y - box.y0 + shear * (x - box.x0) + bias);
      if (b >= 0 && b < span) profile[b] += v;
    }
  }
  return profile;
}

function sharpness(profile: Float32Array): number {
  let sum = 0;
  let sq = 0;
  for (const v of profile) {
    sum += v;
    sq += v * v;
  }
  return sum > 0 ? sq / (sum * sum) : 0;
}

/**
 * The shear that best lines the text rows up, which is the *negative* of the
 * baselines' own slope: a line descending to the right is flattened by lifting
 * the right-hand end. Callers want the rotation of the text itself, so the sign
 * is flipped once, at the boundary in `analyseTextLayout`, and the raw shear
 * stays here where the profile bucketing needs it.
 */
function estimateShear(a: Analysis, box: { x0: number; y0: number; x1: number; y1: number }): number {
  const limit = Math.tan((MAX_SKEW_DEG * Math.PI) / 180);
  let best = 0;
  let bestScore = -Infinity;
  for (let t = -limit; t <= limit + 1e-9; t += 0.008) {
    const s = sharpness(profileFor(a, box, t));
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  // Refine around the winner: a degree of residual skew still costs the
  // recogniser characters at the ends of long lines, which is exactly where the
  // random tail of a token lives.
  for (let t = best - 0.008; t <= best + 0.008 + 1e-9; t += 0.0015) {
    const s = sharpness(profileFor(a, box, t));
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return best;
}

/**
 * Baseline pitch, from the spacing between peaks in the deskewed profile.
 *
 * This is the measurement that decides how far to upscale, and it has to be
 * trustworthy in both directions: too low and a legible recording gets rebuilt
 * for nothing, too high and the frame that needed help does not get it.
 *
 * Autocorrelation was the obvious tool and it was not good enough. On a mixed
 * UI — a sidebar, a toolbar, a terminal pane — the strongest periodicity in the
 * frame is often the layout rather than the text, and correlated compression
 * noise gives it a second peak at the smallest lag searched. Measured against a
 * real recording it returned pitches from 10px to 128px on frames whose text
 * never changed size.
 *
 * Counting the teeth of the comb directly is both simpler and steadier. Text
 * rows are a run of evenly spaced peaks, so the *median* gap between
 * consecutive peaks reports the row spacing and shrugs off the few gaps that a
 * blank line or a heading distorts. Demanding several peaks before answering is
 * what keeps it honest: a frame with no repeating rows returns 0 — "unknown" —
 * rather than a number that happens to fall below a threshold.
 */
function estimatePitch(profile: Float32Array): number {
  const n = profile.length;
  if (n < 24) return 0;

  // Light smoothing so a single noisy bucket does not read as a row.
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = profile[Math.max(0, i - 1)];
    const b = profile[i];
    const c = profile[Math.min(n - 1, i + 1)];
    smooth[i] = (a + 2 * b + c) / 4;
  }

  let mean = 0;
  for (const v of smooth) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of smooth) variance += (v - mean) * (v - mean);
  const std = Math.sqrt(variance / n);
  if (std <= 0) return 0;

  const floor = mean + std * 0.4;
  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (smooth[i] >= floor && smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1]) {
      // Suppress the shoulder of a peak already taken; a text row is one row.
      if (peaks.length && i - peaks[peaks.length - 1] < 3) {
        if (smooth[i] > smooth[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
        continue;
      }
      peaks.push(i);
    }
  }
  if (peaks.length < 5) return 0;

  const gaps: number[] = [];
  for (let i = 1; i < peaks.length; i++) gaps.push(peaks[i] - peaks[i - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[gaps.length >> 1];

  // A comb with wildly irregular teeth was not a page of text. Require the bulk
  // of the gaps to agree with the median before believing it.
  const agree = gaps.filter((g) => Math.abs(g - median) <= Math.max(1, median * 0.35)).length;
  if (agree < gaps.length * 0.6) return 0;

  return median;
}

export function analyseTextLayout(source: CanvasImageSource, width: number, height: number): TextLayout {
  const a = analyse(source, width, height);
  const grid = cellScores(a);

  // Scale the bar to the frame rather than fixing it: a bright IDE photographed
  // in daylight and a dim terminal in a dark room differ by an order of
  // magnitude in absolute gradient, but in both the text is the busiest thing
  // present.
  const p95 = percentile(grid.score, 0.95);
  const threshold = Math.max(4, p95 * 0.3);

  let texty = 0;
  for (const s of grid.score) if (s >= threshold) texty++;
  const density = texty / grid.score.length;

  const comp = largestComponent(grid, threshold);
  if (!comp) return { density, region: null, skewDeg: 0, linePitch: 0, dark: false };

  const pad = 1;
  const box = {
    x0: Math.max(0, (comp.x0 - pad) * CELL),
    y0: Math.max(0, (comp.y0 - pad) * CELL),
    x1: Math.min(a.w, (comp.x1 + 1 + pad) * CELL),
    y1: Math.min(a.h, (comp.y1 + 1 + pad) * CELL),
  };

  const shear = estimateShear(a, box);
  const skewDeg = (-Math.atan(shear) * 180) / Math.PI;
  const pitch = estimatePitch(profileFor(a, box, shear));

  let lumaSum = 0;
  let lumaN = 0;
  for (let y = box.y0; y < box.y1; y++) {
    const row = y * a.w;
    for (let x = box.x0; x < box.x1; x++) {
      lumaSum += a.luma[row + x];
      lumaN++;
    }
  }

  return {
    density,
    region: {
      x: box.x0 * a.scale,
      y: box.y0 * a.scale,
      w: (box.x1 - box.x0) * a.scale,
      h: (box.y1 - box.y0) * a.scale,
    },
    skewDeg,
    linePitch: pitch * a.scale,
    dark: lumaN > 0 ? lumaSum / lumaN < 110 : false,
  };
}

/* --------------------------------------------------------------- rebuilding */

/** Forward map from source pixels to view pixels: X = a·x + b·y + c. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface RecoveryView {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Debug label, shown by the bench tools. */
  name: string;
  /** Maps a box in this view back to source-frame pixels. */
  toSource(box: Box): Box;
}

function invert(m: Affine): Affine {
  const det = m.a * m.e - m.b * m.d;
  if (Math.abs(det) < 1e-12) throw new Error('non-invertible view transform');
  return {
    a: m.e / det,
    b: -m.b / det,
    c: (m.b * m.f - m.e * m.c) / det,
    d: -m.d / det,
    e: m.a / det,
    f: (m.d * m.c - m.a * m.f) / det,
  };
}

function mapBox(m: Affine, box: Box): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x + box.w, box.y + box.h],
    [box.x, box.y + box.h],
  ]) {
    xs.push(m.a * x + m.b * y + m.c);
    ys.push(m.d * x + m.e * y + m.f);
  }
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  // The axis-aligned hull of a rotated box covers more than the box did. That
  // is the safe direction to be wrong in for a redaction, and the excess is a
  // few pixels at the angles this path runs at.
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface ViewOptions {
  /** Upper bound on pixels in any one rebuilt view. */
  pixelBudget?: number;
  /** Force a scale instead of deriving one from the measured pitch. */
  scale?: number;
  /** Invert the rebuilt image, for light-on-dark text. */
  invert?: boolean;
  /** Extra canvas filter applied while rebuilding. */
  filter?: string;
  name?: string;
}

const DEFAULT_PIXEL_BUDGET = 4.2e6;

export function scaleForPitch(linePitch: number): number {
  if (!(linePitch > 0)) return 2;
  const cap = linePitch * CAP_PER_PITCH;
  return Math.min(6, Math.max(1, TARGET_CAP_PX / Math.max(1, cap)));
}

/**
 * Re-renders the measured text block as an upright, well-sized image.
 *
 * The rotation is undone about the region's centre and the whole thing is
 * scaled to bring the glyphs up to the height the recogniser wants. The returned
 * view carries its own inverse, so callers never have to reason about the
 * transform to place a redaction box.
 */
export function buildView(
  source: CanvasImageSource,
  layout: TextLayout,
  opts: ViewOptions = {},
): RecoveryView | null {
  const region = layout.region;
  if (!region || region.w < 16 || region.h < 16) return null;

  const budget = opts.pixelBudget ?? DEFAULT_PIXEL_BUDGET;
  const theta = (layout.skewDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const rotW = Math.abs(region.w * cos) + Math.abs(region.h * sin);
  const rotH = Math.abs(region.w * sin) + Math.abs(region.h * cos);

  let scale = opts.scale ?? scaleForPitch(layout.linePitch);
  const cap = Math.sqrt(budget / Math.max(1, rotW * rotH));
  scale = Math.max(1, Math.min(scale, cap));

  const outW = Math.max(1, Math.round(rotW * scale));
  const outH = Math.max(1, Math.round(rotH * scale));

  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const forward: Affine = {
    a: scale * cos,
    b: scale * sin,
    c: outW / 2 - scale * (cos * cx + sin * cy),
    d: -scale * sin,
    e: scale * cos,
    f: outH / 2 - scale * (-sin * cx + cos * cy),
  };

  const { canvas, ctx } = scratch(outW, outH);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, outW, outH);
  const filters = [opts.invert ? 'invert(1)' : '', opts.filter ?? ''].filter(Boolean).join(' ');
  if (filters) ctx.filter = filters;
  ctx.setTransform(forward.a, forward.d, forward.b, forward.e, forward.c, forward.f);
  ctx.drawImage(source, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';

  const back = invert(forward);
  return {
    canvas,
    name: opts.name ?? 'view',
    toSource: (box) => mapBox(back, box),
  };
}

/** Re-expresses a view's OCR words in source-frame pixels. */
export function mapWordsToSource(
  lines: Array<{ words: Array<{ text: string; box: Box; confidence: number }> }>,
  view: RecoveryView,
): Array<{ words: Array<{ text: string; box: Box; confidence: number }> }> {
  return lines.map((line) => ({
    words: line.words.map((w) => ({ ...w, box: view.toSource(w.box) })),
  }));
}

/**
 * Skew past which a frame cannot be a screen capture.
 *
 * A recording is taken from the framebuffer, so its text is axis-aligned by
 * construction and this measures a flat zero — there is no way for a real screen
 * recording to acquire a tilt. A camera pointed at a monitor cannot avoid one.
 */
export const SKEW_FLOOR_DEG = 1.0;

/**
 * Whether the baseline whole-frame pass is likely to come back empty.
 *
 * Skew alone, deliberately.
 *
 * Small upright text looks like it belongs here too — it is the other way the
 * whole-frame pass can fail — and a size test was written, calibrated and then
 * removed, because measuring it said the opposite of what it should have. On
 * clean captures the baseline reads every secret down to an effective pitch of
 * 24px and still finds most of them at 20px; the earlier belief that it died
 * around 18px came from a photographed fixture, where the text was not just
 * small but blurred and re-encoded. Worse, below that the rebuild *loses* to the
 * baseline — 1 of 6 against 4 of 6 at a 16px effective pitch — because
 * upscaling a clean, tiny frame invents no detail while costing the recogniser
 * the surrounding page. There is nothing to win in that range, and a size gate
 * would have doubled the cost of ordinary recordings to go and not win it.
 *
 * Skew has none of those problems. It reads a flat 0.02-0.10° across an entire
 * real recording and 2.5-9° on every photographed one, which is not a threshold
 * so much as a different regime.
 */
export function needsRebuild(layout: TextLayout): boolean {
  if (!layout.region) return false;
  // A handful of busy cells is a toolbar or a stray highlight, not a page of
  // text, and its "skew" is whatever noise the profile search settled on.
  if (layout.density < 0.02) return false;
  return Math.abs(layout.skewDeg) >= SKEW_FLOOR_DEG;
}

/*
 * Deliberately absent: splitting the rebuilt view into overlapping strips, to
 * chase the perspective that deskewing cannot undo — when the camera is
 * off-axis the baselines converge, so one rotation cannot square up both ends of
 * the block. It is the obvious next move and it was measured across a sweep from
 * a 3° tilt to a 14° one. Strips never won: equal at the extremes, worse in the
 * middle, at roughly double the OCR cost, because cutting a page up costs the
 * recogniser the line context it uses to resolve ambiguous glyphs. The residual
 * skew after rebuilding is 0.02-0.08° at every angle tested, so there was less
 * left to win than it appeared. Steep angles stay a known limit — see
 * tools/deskew-angle-probe.html for the numbers — and the fix for those is a
 * real four-corner homography, not thinner slices of the wrong correction.
 */
