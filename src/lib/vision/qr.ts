import jsQR from 'jsqr';
import type { Box } from '../types';
import { tileRects } from './tiles';

/**
 * How much a hit deserves to be believed on the strength of one frame.
 * A `weak` hit is well-formed but unremarkable, and the scanner holds it back
 * until a second frame decodes the same payload.
 */
export type QrStrength = 'strong' | 'weak';

export interface QrHit {
  box: Box;
  data: string;
  strength: QrStrength;
  /** Why it was accepted or rejected — surfaced by tools/vlog-bench.html. */
  evidence: QrEvidence;
}

export interface QrEvidence {
  /** Decoded payload length, after trimming. */
  len: number;
  /** Share of payload characters that are ordinary printable text. */
  printable: number;
  /** Longest quad side / shortest. A square code sits near 1. */
  sideRatio: number;
  /** Smallest and largest interior angle of the quad, in degrees. */
  minAngle: number;
  maxAngle: number;
  /** Shortest quad side, in pixels. */
  minSide: number;
  /** Pixels per QR module. Below ~1 the code cannot physically be there. */
  pxPerModule: number;
  reject?: string;
}

export interface QrOptions {
  /** Skip the tiled sweep. Benchmarks use it to isolate the whole-frame pass. */
  sweepTiles?: boolean;
  /**
   * Set false to take jsQR's word for it, as this module used to. Only the
   * benchmarks do that, to measure what the validation is actually removing.
   */
  validate?: boolean;
}

/*
 * jsQR returns a result only when a decode passed Reed-Solomon, which sounds
 * like proof and isn't. On camera footage its locator regularly latches onto
 * three unrelated dark blobs, extracts the quadrilateral between them, and
 * error-corrects the noise inside into a "valid" codeword stream. Measured over
 * 359 frames of real webcam video containing no QR code at all (three clips,
 * tools/vlog-bench.html) it did this three times:
 *
 *   side 5.3-1480.7px   ratio 280.1   px/module 0.89   payload ""
 *   side 24.9-1534.6px  ratio  61.5   px/module 1.65   payload ""
 *   side 432.3-751.5px  ratio   1.74  px/module 21.8   payload ""
 *
 * Two are geometric nonsense: a "square" whose sides differ by 280x, with
 * interior angles of 0.6 and 179 degrees, and 21 modules crammed into 5 pixels.
 * The third is a plausible square. All three decoded to nothing.
 *
 * The old size check missed every one of them because it measured the axis
 * aligned bounding box of that collapsed quad — 1480px wide — rather than the
 * quad itself, so each became a high-severity finding with an enormous blur box
 * over the speaker's face.
 *
 * Hence: an empty payload is not a QR code, and neither is a shape that could
 * not hold one.
 */

/*
 * The hard gates below reject only what cannot be a QR code at all. Anything
 * merely marginal is admitted as `weak` and left to corroboration across frames
 * (see confirmQr in scan.ts), because this is a privacy tool: a missed 2FA
 * enrolment code is a worse outcome than one extra box a reviewer can untick.
 */

/** A payload has to be text a human could act on, not corrected noise. */
const MIN_PRINTABLE = 0.75;
/** Shortest side of the quad. The observed false positives had sides of 5px. */
const MIN_SIDE_PX = 16;
/** Perspective skews a square; it does not stretch one side 2x past another. */
const MAX_SIDE_RATIO = 2;
const MIN_ANGLE = 55;
const MAX_ANGLE = 125;
/** Modules cannot be smaller than a pixel: 21 modules across 19px is not a code. */
const MIN_PX_PER_MODULE = 1;

/** Margins comfortable enough to act on a single frame without corroboration. */
const STRONG_PX_PER_MODULE = 3;
const STRONG_SIDE_RATIO = 1.35;
const STRONG_MIN_LEN = 8;

interface Pt {
  x: number;
  y: number;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

function interiorAngle(p: Pt, a: Pt, b: Pt): number {
  const v1 = { x: a.x - p.x, y: a.y - p.y };
  const v2 = { x: b.x - p.x, y: b.y - p.y };
  const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  if (mag === 0) return 0;
  const cos = (v1.x * v2.x + v1.y * v2.y) / mag;
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

function printableRatio(text: string): number {
  if (!text.length) return 0;
  let ok = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    // Ordinary text, tabs and newlines included; C0/C1 controls and DEL are not.
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127 && !(c >= 0x80 && c <= 0x9f))) ok++;
  }
  return ok / [...text].length;
}

/**
 * Weigh one jsQR result. Returns the evidence either way, so a rejection can be
 * explained rather than merely counted.
 */
export function judgeQr(
  data: string,
  version: number,
  corners: { tl: Pt; tr: Pt; br: Pt; bl: Pt },
): { ok: boolean; strength: QrStrength; evidence: QrEvidence } {
  const { tl, tr, br, bl } = corners;
  const finite = [tl, tr, br, bl].every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  const modules = Number.isFinite(version) && version > 0 ? version * 4 + 17 : 21;
  const sides = [dist(tl, tr), dist(tr, br), dist(br, bl), dist(bl, tl)];
  const minSide = Math.min(...sides);
  const maxSide = Math.max(...sides);
  const angles = [
    interiorAngle(tl, tr, bl),
    interiorAngle(tr, br, tl),
    interiorAngle(br, bl, tr),
    interiorAngle(bl, tl, br),
  ];
  const text = (data ?? '').trim();
  const printable = printableRatio(text);
  const evidence: QrEvidence = {
    len: text.length,
    printable: +printable.toFixed(2),
    sideRatio: +(maxSide / (minSide || 1)).toFixed(2),
    minAngle: +Math.min(...angles).toFixed(1),
    maxAngle: +Math.max(...angles).toFixed(1),
    minSide: +minSide.toFixed(1),
    pxPerModule: +(((sides[0] + sides[2]) / 2) / (modules || 1)).toFixed(2),
  };

  // Every gate below is a numeric comparison, and a NaN loses all of them
  // quietly — so an unusable quad has to be rejected before they run.
  const reject = !finite
    ? 'corners are not real coordinates'
    : text.length === 0
      ? 'empty payload'
      : printable < MIN_PRINTABLE
        ? 'payload is not text'
        : minSide < MIN_SIDE_PX
          ? 'too small'
          : evidence.sideRatio > MAX_SIDE_RATIO
            ? 'not square'
            : evidence.minAngle < MIN_ANGLE || evidence.maxAngle > MAX_ANGLE
              ? 'corners are not a quadrilateral'
              : evidence.pxPerModule < MIN_PX_PER_MODULE
                ? 'too few pixels for its module count'
                : undefined;

  if (reject) {
    evidence.reject = reject;
    return { ok: false, strength: 'weak', evidence };
  }

  const strong =
    evidence.pxPerModule >= STRONG_PX_PER_MODULE &&
    evidence.sideRatio <= STRONG_SIDE_RATIO &&
    evidence.minAngle >= 75 &&
    evidence.maxAngle <= 105 &&
    text.length >= STRONG_MIN_LEN &&
    printable === 1;

  return { ok: true, strength: strong ? 'strong' : 'weak', evidence };
}

/**
 * jsQR reports at most one code per image, so a single call can only ever
 * redact one of the codes on screen — and the one it picks is arbitrary. A
 * slide showing a wifi code beside a payment code would have had one blurred
 * and the other published.
 *
 * So each accepted or rejected region is painted out and the image re-scanned,
 * until nothing is left to find. Rejections have to be painted out too, or the
 * locator simply latches onto the same shape forever.
 */
const MAX_CODES_PER_FRAME = 4;

/** Flatten a region so the next decode pass cannot see it. */
function blankRegion(img: ImageData, x: number, y: number, w: number, h: number): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.ceil(x + w));
  const y1 = Math.min(img.height, Math.ceil(y + h));
  for (let py = y0; py < y1; py++) {
    let i = (py * img.width + x0) * 4;
    for (let px = x0; px < x1; px++, i += 4) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 128;
    }
  }
}

/**
 * QR codes are a genuine leak vector in screen recordings: wifi credentials,
 * 2FA enrolment codes and payment links all travel as QR. They're also cheap to
 * find, so we scan every analysed frame.
 */
/** Decode everything findable in one image, offsetting results by (ox, oy). */
function sweepImage(
  image: ImageData,
  ox: number,
  oy: number,
  validate: boolean,
  into: QrHit[],
): void {
  // Copy lazily: the overwhelmingly common region contains no code at all, and
  // that region must not pay for a copy.
  let working = image;

  for (let pass = 0; pass < MAX_CODES_PER_FRAME; pass++) {
    const res = jsQR(working.data, working.width, working.height, { inversionAttempts: 'dontInvert' });
    if (!res?.location) return;

    const corners = {
      tl: res.location.topLeftCorner,
      tr: res.location.topRightCorner,
      br: res.location.bottomRightCorner,
      bl: res.location.bottomLeftCorner,
    };
    const xs = [corners.tl.x, corners.tr.x, corners.br.x, corners.bl.x];
    const ys = [corners.tl.y, corners.tr.y, corners.br.y, corners.bl.y];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;

    const verdict = judgeQr(res.data ?? '', res.version, corners);
    if ((!validate || verdict.ok) && w >= 12 && h >= 12) {
      const pad = Math.max(w, h) * 0.08;
      into.push({
        box: {
          x: Math.max(0, x - pad) + ox,
          y: Math.max(0, y - pad) + oy,
          w: w + pad * 2,
          h: h + pad * 2,
        },
        data: (res.data ?? '').trim(),
        strength: verdict.strength,
        evidence: verdict.evidence,
      });
    }

    if (working === image) {
      // A plain object, not `new ImageData`: this module is exercised by the
      // Node suite as well as the browser, and only these three fields are read.
      working = {
        data: new Uint8ClampedArray(image.data),
        width: image.width,
        height: image.height,
      } as ImageData;
    }
    // Cover the quad plus a margin, so a surviving fragment of finder pattern
    // cannot re-anchor the next pass on the same code.
    const margin = Math.max(4, Math.max(w, h) * 0.12);
    blankRegion(working, x - margin, y - margin, w + margin * 2, h + margin * 2);
  }
}

function cropImage(image: ImageData, x: number, y: number, side: number): ImageData {
  const data = new Uint8ClampedArray(side * side * 4);
  for (let row = 0; row < side; row++) {
    const from = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(from, from + side * 4), row * side * 4);
  }
  return { data, width: side, height: side } as ImageData;
}

/**
 * QR codes are a genuine leak vector in screen recordings: wifi credentials,
 * 2FA enrolment codes and payment links all travel as QR.
 *
 * The frame is swept whole and then in overlapping tiles. The whole-frame pass
 * is the fast path and catches a code too large for a tile; the tiles exist
 * because jsQR cannot cope with two codes at once — measured, a frame holding
 * two codes decodes to **nothing at all**, in every arrangement tried, since
 * its locator pairs finder patterns across the two and every candidate quad
 * fails. Splitting the frame so each region holds at most one code recovers
 * both. Codes closer together than a tile still collide; see the suite.
 */
export function detectQr(image: ImageData, opts: QrOptions = {}): QrHit[] {
  const validate = opts.validate !== false;
  const hits: QrHit[] = [];
  sweepImage(image, 0, 0, validate, hits);

  // The largest square that fits: a tile has to *contain* a whole code to
  // decode it, so splitting finer than the codes themselves finds nothing.
  // This is the coarsest split that still separates two codes, and it costs
  // about a third again on top of the whole-frame pass.
  const side = Math.min(image.width, image.height);
  if (opts.sweepTiles !== false && side >= 64) {
    // On a rectangular frame, the largest square that fits creates the
    // useful row/column split. On a square frame that would be the whole
    // image again, so use half-sized overlapping tiles; otherwise two codes
    // on a square slide silently defeat jsQR's one-result-per-call limit.
    const tileSide = image.width === image.height ? Math.max(64, Math.floor(side / 2)) : side;
    for (const tile of tileRects(image.width, image.height, tileSide)) {
      sweepImage(cropImage(image, tile.x, tile.y, tile.side), tile.x, tile.y, validate, hits);
    }
  }

  // The same code seen by the frame pass and by two tiles is still one code.
  // Two copies of an identical payload in different places are not, so overlap
  // has to agree as well as the payload.
  const kept: QrHit[] = [];
  for (const hit of hits) {
    const dup = kept.some((k) => {
      if (k.data !== hit.data) return false;
      const ox = Math.max(0, Math.min(k.box.x + k.box.w, hit.box.x + hit.box.w) - Math.max(k.box.x, hit.box.x));
      const oy = Math.max(0, Math.min(k.box.y + k.box.h, hit.box.y + hit.box.h) - Math.max(k.box.y, hit.box.y));
      return ox * oy > 0;
    });
    if (!dup) kept.push(hit);
  }
  return kept;
}
