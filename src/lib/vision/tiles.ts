/**
 * Sweeping a detector over overlapping regions.
 *
 * Both detectors here are built to answer one question about one image, and
 * both of them fail in the same way when a frame does not match that shape:
 *
 *   BlazeFace resizes the frame into a 128px tensor, so a distant face is gone
 *   before the model runs.
 *   jsQR returns a single result per call, and given two codes at once its
 *   locator pairs finder patterns across them and decodes *neither*.
 *
 * One whole-frame call is simply the wrong primitive. Cropping the frame into
 * overlapping regions and asking again fixes both, because each region contains
 * a face large enough to survive the resize, or at most one code.
 */

export interface Rect {
  x: number;
  y: number;
  side: number;
}

/**
 * Fraction of a tile shared with its neighbour.
 *
 * A target is guaranteed to sit wholly inside some tile only if it is smaller
 * than the overlap, so a third of the tile covers everything up to a third of a
 * tile. Anything larger is caught by a coarser level, or by the whole-frame
 * pass. Total swept pixels are (1/(1-overlap))^2 of the frame — 2.25x here —
 * whatever tile size is chosen, since the cost follows the area, not the count.
 */
export const TILE_OVERLAP = 1 / 3;

/**
 * Square tiles covering the frame, evenly spaced so neighbours overlap by at
 * least TILE_OVERLAP and the last tile sits flush against the far edge. Even
 * spacing matters: naive stepping leaves a final tile a few pixels from its
 * neighbour, which costs a whole extra inference for no new pixels.
 */
export function tileRects(width: number, height: number, side: number): Rect[] {
  const s = Math.max(64, Math.min(Math.round(side), width, height));
  const step = Math.max(1, s * (1 - TILE_OVERLAP));
  const starts = (extent: number): number[] => {
    if (extent <= s) return [0];
    const n = Math.ceil((extent - s) / step) + 1;
    const gap = (extent - s) / (n - 1);
    return Array.from({ length: n }, (_, i) => Math.round(i * gap));
  };
  const out: Rect[] = [];
  for (const y of starts(height)) {
    for (const x of starts(width)) out.push({ x, y, side: s });
  }
  return out;
}
