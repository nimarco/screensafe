import type { Box, Finding } from '../types';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function dilate(box: Box, w: number, h: number): Box {
  // Text baselines and antialiasing spill past the OCR box, and a half-covered
  // character is still readable. Pad generously, then clamp to the frame.
  const padX = Math.max(4, box.h * 0.28);
  const padY = Math.max(3, box.h * 0.22);
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  return {
    x,
    y,
    w: Math.min(w - x, box.w + padX * 2),
    h: Math.min(h - y, box.h + padY * 2),
  };
}

/**
 * Boxes for one finding at time `t`.
 *
 * Between two samples the content may have moved, so we return the union of the
 * bracketing observations rather than the nearest one — that way scrolling text
 * stays covered through the transition instead of sliding out from under its
 * own blur.
 */
export function boxesAt(finding: Finding, t: number): Box[] {
  const occ = finding.occurrences;
  if (!occ.length) return [];
  if (t < finding.start || t > finding.end) return [];

  // Group observations recorded at the same instant (same value, two places).
  const times = [...new Set(occ.map((o) => o.t))].sort((a, b) => a - b);
  let before = times[0];
  let after = times[times.length - 1];
  for (const time of times) {
    if (time <= t) before = time;
    if (time >= t) {
      after = time;
      break;
    }
  }

  const at = (time: number) => occ.filter((o) => o.t === time).map((o) => o.box);
  const beforeBoxes = at(before);
  const afterBoxes = at(after);

  if (before === after) return beforeBoxes;

  // Pair them up positionally so two separate on-screen copies don't get
  // merged into one enormous box spanning the whole frame.
  const out: Box[] = [];
  for (const b of beforeBoxes) {
    let best: Box | null = null;
    let bestD = Infinity;
    for (const a of afterBoxes) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    const reach = Math.max(b.w, b.h) * 4 + 60;
    out.push(best && bestD <= reach ? union(b, best) : b);
  }
  for (const a of afterBoxes) {
    if (!out.some((o) => o.x <= a.x && o.y <= a.y && o.x + o.w >= a.x + a.w && o.y + o.h >= a.y + a.h)) {
      out.push(a);
    }
  }
  return out;
}

export function activeBoxes(findings: Finding[], t: number, w: number, h: number): Box[] {
  const out: Box[] = [];
  for (const f of findings) {
    if (!f.redact) continue;
    for (const b of boxesAt(f, t)) out.push(dilate(b, w, h));
  }
  return out;
}

/*
 * One scratch surface per destination context, not one for the whole module.
 *
 * The review preview and the exporter both call paintRedactions, on different
 * canvases, while the other is running — the preview repaints on its own
 * animation frame for the whole duration of an export. Sharing one mutable
 * scratch between two independent consumers is a hazard in a function whose
 * job is to destroy information; keyed per destination they cannot reach each
 * other's pixels. (Measured: this is not what caused the stale-frame export
 * leak — output was byte-identical before and after — so it is hardening, not
 * a fix for that.)
 */
const scratches = new WeakMap<Ctx2D, { canvas: CanvasImageSource; ctx: Ctx2D }>();

function scratch(dest: Ctx2D, w: number, h: number): { canvas: CanvasImageSource; ctx: Ctx2D } {
  let entry = scratches.get(dest);
  if (!entry) {
    const created =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(Math.max(1, w), Math.max(1, h))
        : Object.assign(document.createElement('canvas'), {
            width: Math.max(1, w),
            height: Math.max(1, h),
          });
    entry = {
      canvas: created as CanvasImageSource,
      ctx: (created as HTMLCanvasElement).getContext('2d', { alpha: false }) as Ctx2D,
    };
    scratches.set(dest, entry);
  }
  const c = entry.canvas as HTMLCanvasElement;
  if (c.width < w || c.height < h) {
    c.width = Math.max(c.width, w);
    c.height = Math.max(c.height, h);
  }
  return entry;
}

/**
 * How many mosaic cells a redacted region may keep on its longer axis.
 *
 * This is the number that decides whether a redaction works, and it has to be
 * a *count*, not a pixel size. The rule here used to be a block of about 12.7
 * pixels, derived from text cap height — which quietly meant the number of
 * cells grew with the region: a line of text kept 33x2 cells and was destroyed,
 * while a 446x485 face kept 35x38 and stayed plainly recognisable in the
 * export. Same code, opposite outcomes, because the strength was pinned to the
 * block instead of to what survives it.
 *
 * Six cells across is past the point where a human can identify a face, and it
 * is strictly stronger than the old rule for text, which was already verified
 * unreadable by re-scanning the exported pixels.
 */
export const DEFAULT_MOSAIC_CELLS = 6;

/**
 * Range offered in the UI, weakest to strongest.
 *
 * The weak end is a deliberate stopping point, not the widest the maths allows:
 * the old fixed-block rule left roughly 50 cells across a face and the face
 * detector re-run on the redacted pixels found it again at 0.89 confidence,
 * which is the failure this whole scale exists to keep out of reach. Below 3
 * the mosaic stops telling a reviewer anything about what was covered.
 */
export const MOSAIC_MIN_CELLS = 3;
export const MOSAIC_MAX_CELLS = 15;

/**
 * The mosaic grid for a region: how few pixels it is crushed down to before
 * being blown back up. Exported so the suite can assert the bound holds for
 * every region size — the old rule passed every test it had while leaving a
 * face at 50x44 cells, because nothing ever checked what survived.
 */
export function mosaicGrid(
  bw: number,
  bh: number,
  cells: number = DEFAULT_MOSAIC_CELLS,
): { block: number; sw: number; sh: number } {
  // Scale the cell to the region, so a big region is destroyed as thoroughly
  // as a small one. The floor keeps tiny boxes from being pointlessly coarse.
  const bounded = Math.min(MOSAIC_MAX_CELLS, Math.max(MOSAIC_MIN_CELLS, Math.round(cells)));
  const block = Math.max(6, Math.max(bw, bh) / bounded);
  return {
    block,
    sw: Math.max(1, Math.round(bw / block)),
    sh: Math.max(1, Math.round(bh / block)),
  };
}

/**
 * Destructive mosaic.
 *
 * We downsample the region to a handful of pixels and blow it back up with
 * smoothing disabled. Unlike a Gaussian blur — which is a reversible
 * convolution and has been undone on real redactions before — averaging pixels
 * down to blocks throws the information away for good.
 */
export function paintRedactions(
  ctx: Ctx2D,
  boxes: Box[],
  frameW: number,
  frameH: number,
  cells: number = DEFAULT_MOSAIC_CELLS,
): void {
  if (!boxes.length) return;
  ctx.save();
  for (const box of boxes) {
    const bx = Math.max(0, Math.floor(box.x));
    const by = Math.max(0, Math.floor(box.y));
    const bw = Math.min(frameW - bx, Math.ceil(box.w));
    const bh = Math.min(frameH - by, Math.ceil(box.h));
    if (bw < 2 || bh < 2) continue;

    const { sw, sh } = mosaicGrid(bw, bh, cells);

    const { canvas: tmp, ctx: tctx } = scratch(ctx, sw, sh);
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(ctx.canvas as CanvasImageSource, bx, by, bw, bh, 0, 0, sw, sh);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, sw, sh, bx, by, bw, bh);
    ctx.imageSmoothingEnabled = true;
  }
  ctx.restore();
}

/** Preview-only affordance: a hairline so the reviewer can see what's covered. */
export function paintOutlines(ctx: Ctx2D, boxes: Box[], color: string): void {
  if (!boxes.length) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (const b of boxes) {
    ctx.strokeRect(Math.floor(b.x) + 0.5, Math.floor(b.y) + 0.5, Math.ceil(b.w), Math.ceil(b.h));
  }
  ctx.restore();
}
