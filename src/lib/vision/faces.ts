import type { Box } from '../types';

export interface FaceHit {
  box: Box;
  confidence: number;
}

type Detector = {
  detect(image: HTMLCanvasElement | OffscreenCanvas | ImageBitmap): {
    detections: Array<{
      boundingBox?: { originX: number; originY: number; width: number; height: number };
      categories?: Array<{ score: number }>;
    }>;
  };
  close(): void;
};

let detector: Detector | null = null;
let initPromise: Promise<Detector | null> | null = null;

/**
 * MediaPipe BlazeFace, loaded from our own origin. Returns null (rather than
 * throwing) if the model or WASM can't start — face detection is the one
 * optional detector, and a missing GPU delegate shouldn't sink a whole scan.
 */
export async function initFaceDetector(): Promise<Detector | null> {
  if (initPromise) return initPromise;
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
          minDetectionConfidence: 0.45,
        });
      let d: unknown;
      try {
        d = await make('GPU');
      } catch {
        d = await make('CPU');
      }
      detector = d as Detector;
      return detector;
    } catch (err) {
      console.warn('[screensafe] face detection unavailable:', err);
      return null;
    }
  })();
  return initPromise;
}

export function detectFaces(
  source: HTMLCanvasElement | OffscreenCanvas | ImageBitmap,
  videoW: number,
  videoH: number,
): FaceHit[] {
  if (!detector) return [];
  let out: FaceHit[] = [];
  try {
    const res = detector.detect(source);
    for (const det of res.detections ?? []) {
      const bb = det.boundingBox;
      if (!bb) continue;
      // Faces need generous padding: BlazeFace boxes clip the forehead and chin,
      // and a partially blurred face is not an anonymised face.
      const padX = bb.width * 0.18;
      const padY = bb.height * 0.24;
      out.push({
        box: {
          x: Math.max(0, bb.originX - padX),
          y: Math.max(0, bb.originY - padY),
          w: Math.min(videoW, bb.width + padX * 2),
          h: Math.min(videoH, bb.height + padY * 2),
        },
        confidence: det.categories?.[0]?.score ?? 0.5,
      });
    }
  } catch (err) {
    console.warn('[screensafe] face detect failed on frame:', err);
  }
  return out;
}

export function disposeFaceDetector(): void {
  try {
    detector?.close();
  } catch {
    /* noop */
  }
  detector = null;
  initPromise = null;
}
