import type { Box } from '../types';
import { tileRects } from './tiles';

export interface FaceHit {
  box: Box;
  confidence: number;
}

/*
 * Finding faces smaller than BlazeFace was built for.
 *
 * The model runs on a 128x128 tensor, and MediaPipe letterboxes the frame into
 * it: a 1620x1080 frame arrives as about 128x85 with the rest padding, a 20x
 * reduction. A face filling a third of the frame survives that. A face across
 * the room lands on a handful of pixels and is not in the image any more, so no
 * confidence threshold can bring it back — the detail was destroyed before the
 * model ran. The answer is to run the same model again over square crops taken
 * at native pixels, where a distant face is large relative to the crop.
 *
 * The size of those crops is the whole game, and it is not a matter of taste.
 * Measured across three independent configurations (tools/face-scale-bench.html),
 * converting where recall died into pixels of face inside the 128px tensor:
 *
 *   full frame, letterboxed   found at 19.2px   lost at 13.7px
 *   540px square tiles        found at 20.5px   lost at 14.8px
 *   360px square tiles        found at 22.3px   lost at 16.1px
 *
 * One constant, three ways of measuring it: this model needs roughly 20 pixels
 * of face and gives up around 15. That is a property of the network, not of the
 * footage, so tile size follows from arithmetic:
 *
 *   tile side = smallest face we want to catch * 128 / 20
 *
 * An earlier version of this file sized tiles as a fraction of the frame
 * instead. That silently made behaviour depend on resolution: the same setting
 * produced 240px tiles on a 720p recording and 360px on a 1080p one, so the
 * 720p scan magnified a code editor 1.5x harder, fed the network 24 crops of
 * something it has never seen, and reported two "faces" in a video containing
 * no people. On a 4K frame the same code would have erred the other way and
 * missed real faces. Deriving the tile from the model's envelope removes both
 * failures, because a tile is now the same number of pixels whatever the frame.
 */

/** The model's input is 128x128, and it needs ~20 of those pixels to be face. */
const MODEL_INPUT_PX = 128;
/** Use the pessimistic end of the measured range, so tiles have margin. */
const FACE_PX_IN_TENSOR = 22;

/**
 * Smallest face, in pixels of source height, a scan will look for.
 *
 * 64px is about a head at the far side of a room in a 1080p frame — still
 * recognisable, so still worth blurring. Lowering it costs real time: tile
 * count grows with the square of the reduction.
 *
 * The setting is calibrated, not a label. Measured on real footage redrawn
 * smaller (tools/face-scale-bench.html, 7 frames per cell, 1620x1080), each
 * column holds recall to roughly the size it was asked for and no further,
 * with no stray boxes in any cell:
 *
 *   face height   frame only   128px   64px   48px
 *   243px            2/7        7/7     6/7    6/7
 *   121px            0/7        5/7     7/7    6/7
 *    87px            0/7        0/7     7/7    7/7
 *    62px            0/7        0/7     6/7    7/7
 *    45px            0/7        0/7     0/7    4/7
 *    31px            0/7        0/7     0/7    0/7
 *
 *   cost            5.8ms     24.2ms  65.8ms 112.9ms   per frame, GPU delegate
 */
export const DEFAULT_MIN_FACE_PX = 64;

/**
 * Square tile sizes to sweep, smallest first, or [] when the plain full-frame
 * pass already reaches the requested size.
 *
 * A tile of side S resolves faces from about (22/128)*S up to S itself, and the
 * letterboxed full-frame pass covers everything above 22*longest/128. Levels
 * step up by 2.5x until they meet that, so no band of face sizes falls between
 * two levels — the gap a fixed 2-level scheme would leave on a 4K frame.
 */
export function tileLadder(width: number, height: number, minFacePx: number): number[] {
  const shortest = Math.min(width, height);
  const frameFloorPx = (FACE_PX_IN_TENSOR * Math.max(width, height)) / MODEL_INPUT_PX;
  const ideal = (minFacePx * MODEL_INPUT_PX) / FACE_PX_IN_TENSOR;
  // Nothing to add when the frame pass already sees faces this small, or when a
  // tile would have to be bigger than the frame.
  if (minFacePx >= frameFloorPx || ideal >= shortest) return [];

  const sides: number[] = [];
  for (let side = ideal; ; side *= 2.5) {
    const s = Math.min(side, shortest);
    sides.push(Math.round(s));
    if (s >= frameFloorPx || s >= shortest) return sides;
  }
}

export interface FaceDetectOptions {
  /** Smallest face height to look for, in source pixels. Larger is faster. */
  minFacePx?: number;
  /** Override the confidence floor. The benchmarks sweep it; nothing else should. */
  minConfidence?: number;
}

/**
 * The score a face has to reach, at least once, to be redacted.
 *
 * BlazeFace does not only find faces. Hands near the lens, chair backs and
 * editor panels all score 0.45-0.66 on real footage, against 0.84-0.97 for
 * faces. But no *single frame* can be judged on that number: applied per frame,
 * a flat 0.7 broke a real face track in two and left 1.5s of a clip unblurred,
 * because in the hard frames — turning away, motion blur — a genuine face is
 * itself only a 0.5.
 *
 * The question is therefore asked once per track, over every frame the thing
 * appeared in, where the weak frames of a real face are carried by the strong
 * ones and an impostor has nothing to lean on. That only works because track
 * association is tight enough to keep them apart; see sameOccurrence in scan.ts.
 */
export const CONFIDENT_FACE = 0.7;

/**
 * Whether a face was ever convincing enough to redact, given the best score it
 * reached across every frame it appeared in. Applied per *track* rather than
 * per frame — see the filter in scan.ts for why that distinction matters.
 */
export function isEstablishedFace(peakConfidence: number): boolean {
  return peakConfidence >= CONFIDENT_FACE;
}

/**
 * Whether a face track that starts at `nextFirstT` is the same person the
 * tracker was following until `prevLastT`, rather than a second one.
 *
 * The strict requirement is `nextFirstT > prevLastT`: one presence has to *end*
 * before the other begins. Two people on screen together overlap in time, so
 * they never satisfy this and stay separate rows the reviewer can allow or
 * blur independently — which a plain "join anything nearby" rule would destroy.
 */
export function continuesFace(prevLastT: number, nextFirstT: number, gapS: number): boolean {
  return nextFirstT > prevLastT && nextFirstT - prevLastT <= gapS;
}

/** Rejoin a dropped face only when its next box is still spatially plausible. */
export function canStitchFaceTracks(
  previous: { lastT: number; lastBox: Box },
  next: { firstT: number; firstBox: Box },
  gapS: number,
): boolean {
  return continuesFace(previous.lastT, next.firstT, gapS) && faceBoxesMatch(previous.lastBox, next.firstBox);
}
/** Below this nothing is worth drawing, even alone. The detector's own floor. */
const DEFAULT_MIN_CONFIDENCE = 0.45;

/** Boxes overlapping this much are treated as the same face. */
const MERGE_IOU = 0.3;

type Detection = {
  boundingBox?: { originX: number; originY: number; width: number; height: number };
  categories?: Array<{ score: number }>;
};

type Detector = {
  detect(image: HTMLCanvasElement | OffscreenCanvas | ImageBitmap): { detections: Detection[] };
  setOptions(options: { minDetectionConfidence?: number }): Promise<void>;
  close(): void;
};

type Source = HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

let detector: Detector | null = null;
let initPromise: Promise<Detector | null> | null = null;
let detectorGeneration = 0;

/**
 * MediaPipe BlazeFace, loaded from our own origin. Returns null (rather than
 * throwing) if the model or WASM can't start. Callers that promise a complete
 * visual scan must treat null as an unavailable detector rather than as "no
 * faces"; otherwise a model-loading failure becomes a false clean result.
 */
export async function initFaceDetector(minDetectionConfidence = 0.45): Promise<Detector | null> {
  if (initPromise) return initPromise;
  const generation = detectorGeneration;
  initPromise = (async () => {
    try {
      const { FilesetResolver, FaceDetector } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      const make = (delegate: 'GPU' | 'CPU') =>
        FaceDetector.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: '/vendor/models/blaze_face_short_range.tflite',
            delegate,
          },
          runningMode: 'IMAGE',
          minDetectionConfidence,
        });
      let d: unknown;
      try {
        d = await make('GPU');
      } catch {
        d = await make('CPU');
      }
      const created = d as Detector;
      // A reset can happen while the WASM/model is still loading. Do not let a
      // stale promise resurrect a detector that disposeFaceDetector() already
      // retired, and do not leak the late-created MediaPipe instance.
      if (generation !== detectorGeneration) {
        try {
          created.close();
        } catch {
          /* noop */
        }
        return null;
      }
      detector = created;
      return detector;
    } catch (err) {
      console.warn('[screensafe] face detection unavailable:', err);
      if (generation === detectorGeneration) initPromise = null;
      return null;
    }
  })();
  return initPromise;
}

/** Re-tune the live detector. Used by the benchmarks to sweep thresholds. */
export async function setFaceConfidence(minDetectionConfidence: number): Promise<void> {
  await detector?.setOptions({ minDetectionConfidence });
}

let scratch: { canvas: Source; ctx: CanvasRenderingContext2D; side: number } | null = null;

function scratchFor(side: number) {
  if (!scratch || scratch.side !== side) {
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(side, side)
        : Object.assign(document.createElement('canvas'), { width: side, height: side });
    const ctx = (canvas as HTMLCanvasElement).getContext('2d', {
      alpha: false,
      willReadFrequently: false,
    }) as CanvasRenderingContext2D;
    scratch = { canvas: canvas as Source, ctx, side };
  }
  return scratch;
}

function runDetector(image: Source): FaceHit[] {
  const out: FaceHit[] = [];
  const res = detector!.detect(image);
  for (const det of res.detections ?? []) {
    const bb = det.boundingBox;
    if (!bb || bb.width <= 0 || bb.height <= 0) continue;
    out.push({
      box: { x: bb.originX, y: bb.originY, w: bb.width, h: bb.height },
      confidence: det.categories?.[0]?.score ?? 0.5,
    });
  }
  return out;
}

function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = w * h;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function centerDistance(a: Box, b: Box): number {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  return Math.hypot(dx, dy);
}

/**
 * Whether two face boxes are close enough to be the same observation over time.
 *
 * A face and a nearby impostor cannot be matched using only the larger box:
 * before this gate was size-aware, a 600px face could absorb a 250px hand more
 * than 400px away. The hand then inherited the face track's confidence. Use the
 * smaller observation as the second bound, so a box must move with its own
 * footprint as well as staying near the larger one.
 */
export function faceBoxesMatch(a: Box, b: Box): boolean {
  const largest = Math.max(a.w, a.h, b.w, b.h);
  const smallest = Math.min(Math.max(a.w, a.h), Math.max(b.w, b.h));
  const reach = Math.min(largest * 0.75, smallest * 1.1 + 32);
  return centerDistance(a, b) <= reach;
}

/**
 * One face seen from the full frame and from two overlapping tiles is still one
 * face. Merge by union rather than by picking a winner: a tile can clip a face
 * at its edge, and for a redactor the union of two partial views is the safer
 * box.
 */
function mergeFaces(hits: FaceHit[]): FaceHit[] {
  const kept: FaceHit[] = [];
  for (const hit of hits) {
    const host = kept.find((k) => iou(k.box, hit.box) > MERGE_IOU);
    if (!host) {
      kept.push({ box: { ...hit.box }, confidence: hit.confidence });
      continue;
    }
    const x = Math.min(host.box.x, hit.box.x);
    const y = Math.min(host.box.y, hit.box.y);
    host.box = {
      x,
      y,
      w: Math.max(host.box.x + host.box.w, hit.box.x + hit.box.w) - x,
      h: Math.max(host.box.y + host.box.h, hit.box.y + hit.box.h) - y,
    };
    host.confidence = Math.max(host.confidence, hit.confidence);
  }
  return kept;
}

export function detectFaces(
  source: Source,
  videoW: number,
  videoH: number,
  opts: FaceDetectOptions = {},
): FaceHit[] {
  if (!detector) return [];
  const floor = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const raw: FaceHit[] = [];

  // The whole frame first: it is one inference and it is the only pass that
  // sees a face too large to sit inside a tile. Any inference failure is
  // propagated: returning [] here would make the caller interpret a broken
  // detector as a frame with no faces.
  for (const hit of runDetector(source)) {
    if (hit.confidence >= floor) raw.push(hit);
  }

  for (const side of tileLadder(videoW, videoH, opts.minFacePx ?? DEFAULT_MIN_FACE_PX)) {
    for (const tile of tileRects(videoW, videoH, side)) {
      const sc = scratchFor(tile.side);
      // Native pixels, no resampling: the point of the tile is the detail.
      sc.ctx.drawImage(
        source as CanvasImageSource,
        tile.x,
        tile.y,
        tile.side,
        tile.side,
        0,
        0,
        tile.side,
        tile.side,
      );
      for (const hit of runDetector(sc.canvas)) {
        if (hit.confidence < floor) continue;
        raw.push({
          box: { ...hit.box, x: hit.box.x + tile.x, y: hit.box.y + tile.y },
          confidence: hit.confidence,
        });
      }
    }
  }

  // Every surviving box is reported with its own score. Deciding what is real
  // happens once, over a whole track, where the evidence actually accumulates —
  // see establishedFace in scan.ts. A single frame is the wrong place to ask.
  const out: FaceHit[] = [];
  for (const hit of mergeFaces(raw)) {
    // Faces need generous padding: BlazeFace boxes clip the forehead and chin,
    // and a partially blurred face is not an anonymised face.
    const padX = hit.box.w * 0.18;
    const padY = hit.box.h * 0.24;
    const x = Math.max(0, hit.box.x - padX);
    const y = Math.max(0, hit.box.y - padY);
    // Clamp against the far edge, not against the frame size: a box that starts
    // at x and is videoW wide runs off the picture.
    const w = Math.min(videoW - x, hit.box.w + padX * 2);
    const h = Math.min(videoH - y, hit.box.h + padY * 2);
    if (w <= 1 || h <= 1) continue;
    out.push({ box: { x, y, w, h }, confidence: hit.confidence });
  }
  return out;
}

export function disposeFaceDetector(): void {
  detectorGeneration++;
  try {
    detector?.close();
  } catch {
    /* noop */
  }
  detector = null;
  initPromise = null;
  scratch = null;
}
