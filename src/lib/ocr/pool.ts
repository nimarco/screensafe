import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { Box } from '../types';
import type { OcrWord } from '../detectors/scanText';

/** Everything Tesseract needs is served from our own origin — no CDN calls. */
const TESS_OPTS = {
  workerPath: '/vendor/tess/worker.min.js',
  corePath: '/vendor/tess/',
  langPath: '/vendor/tess/',
  gzip: false as const,
  cacheMethod: 'none' as const,
};

export interface OcrLineResult {
  words: OcrWord[];
}

export interface OcrResult {
  lines: OcrLineResult[];
}

/**
 * Page segmentation modes we actually use.
 *
 * AUTO runs full layout analysis, which is right for a screenshot and is what
 * finds columns, panes and gutters. It is also the part that gives up entirely
 * on a photographed screen: no block found, no text returned. SPARSE_TEXT skips
 * layout and hunts for words wherever they are, which recovers a rebuilt view
 * even when the rebuild left some skew behind.
 */
export const OCR_PSM = {
  auto: PSM.AUTO,
  sparse: PSM.SPARSE_TEXT,
  block: PSM.SINGLE_BLOCK,
} as const;

export type OcrMode = keyof typeof OCR_PSM;

export interface RecognizeOptions {
  /** Layout strategy. Defaults to `auto`, the pool's initialised mode. */
  mode?: OcrMode;
}

function workerCount(): number {
  const cores = navigator.hardwareConcurrency || 4;
  // Each worker carries its own ~7MB core plus a 4MB language model, so this
  // trades memory for wall-clock. Four is the point where a 22s recording stops
  // being the bottleneck on a typical laptop.
  return Math.max(1, Math.min(4, cores - 1));
}

interface TessBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function toBox(b: TessBBox, scale: number): Box {
  return {
    x: b.x0 / scale,
    y: b.y0 / scale,
    w: (b.x1 - b.x0) / scale,
    h: (b.y1 - b.y0) / scale,
  };
}

export class OcrPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{ resolve: (w: Worker) => void; reject: (err: unknown) => void }> = [];
  private ready: Promise<void> | null = null;

  async init(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.ready) return this.ready;
    const n = workerCount();
    let loaded = 0;
    this.ready = (async () => {
      const created: Worker[] = [];
      try {
        const made = await Promise.all(
          Array.from({ length: n }, async () => {
            const w = await createWorker('eng', 1, TESS_OPTS);
            created.push(w);
            await w.setParameters({
              tessedit_pageseg_mode: PSM.AUTO,
              preserve_interword_spaces: '1',
              user_defined_dpi: '96',
            });
            onProgress?.(++loaded, n);
            return w;
          }),
        );
        this.workers = made;
        this.idle = [...made];
        this.flush();
      } catch (err) {
        // Promise.all can reject after another worker has already been
        // created. Dispose every partial worker or a failed/aborted scan leaves
        // Tesseract threads alive in the tab.
        await Promise.all(created.map((w) => w.terminate().catch(() => {})));
        this.workers = [];
        this.idle = [];
        this.queue = [];
        this.ready = null;
        throw err;
      }
    })();
    return this.ready;
  }

  private flush() {
    while (this.queue.length && this.idle.length) {
      const take = this.queue.shift()!;
      take.resolve(this.idle.pop()!);
    }
  }

  private acquire(): Promise<Worker> {
    if (this.idle.length) return Promise.resolve(this.idle.pop()!);
    return new Promise((resolve, reject) => this.queue.push({ resolve, reject }));
  }

  private release(w: Worker) {
    if (!this.workers.includes(w)) {
      void w.terminate().catch(() => {});
      return;
    }
    this.idle.push(w);
    this.flush();
  }

  get size(): number {
    return this.workers.length;
  }

  /**
   * Recognise one frame. `scale` is the factor the bitmap was upscaled by, so
   * boxes come back in original video pixel coordinates. Pass `scale: 1` when
   * the caller owns a richer transform and will map the boxes itself.
   */
  async recognize(
    bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
    scale: number,
    opts: RecognizeOptions = {},
  ): Promise<OcrResult> {
    await this.init();
    const w = await this.acquire();
    const mode = opts.mode ?? 'auto';
    try {
      // The worker is held exclusively for this call, so a non-default mode can
      // be set and put back without another job ever seeing it.
      if (mode !== 'auto') await w.setParameters({ tessedit_pageseg_mode: OCR_PSM[mode] });
      const res = await w.recognize(bitmap as Parameters<Worker['recognize']>[0], {}, { blocks: true });
      const lines: OcrLineResult[] = [];
      const blocks = (res.data as { blocks?: unknown[] }).blocks ?? [];
      for (const block of blocks as Array<{ paragraphs?: unknown[] }>) {
        for (const para of (block.paragraphs ?? []) as Array<{ lines?: unknown[] }>) {
          for (const line of (para.lines ?? []) as Array<{
            words?: Array<{ text: string; bbox: TessBBox; confidence: number }>;
          }>) {
            const words: OcrWord[] = [];
            for (const word of line.words ?? []) {
              const text = (word.text ?? '').trim();
              if (!text) continue;
              words.push({
                text,
                box: toBox(word.bbox, scale),
                confidence: (word.confidence ?? 0) / 100,
              });
            }
            if (words.length) lines.push({ words });
          }
        }
      }
      return { lines };
    } finally {
      if (mode !== 'auto') {
        await w.setParameters({ tessedit_pageseg_mode: OCR_PSM.auto }).catch(() => {});
      }
      this.release(w);
    }
  }

  async terminate(): Promise<void> {
    const ws = this.workers;
    this.workers = [];
    this.idle = [];
    const queued = this.queue;
    this.queue = [];
    this.ready = null;
    const err = new Error('OCR pool terminated.');
    for (const take of queued) take.reject(err);
    await Promise.all(ws.map((w) => w.terminate().catch(() => {})));
  }
}
