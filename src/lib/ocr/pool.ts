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
  private queue: Array<(w: Worker) => void> = [];
  private ready: Promise<void> | null = null;

  async init(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    if (this.ready) return this.ready;
    const n = workerCount();
    let loaded = 0;
    this.ready = (async () => {
      const made = await Promise.all(
        Array.from({ length: n }, async () => {
          const w = await createWorker('eng', 1, TESS_OPTS);
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
    })();
    return this.ready;
  }

  private flush() {
    while (this.queue.length && this.idle.length) {
      const take = this.queue.shift()!;
      take(this.idle.pop()!);
    }
  }

  private acquire(): Promise<Worker> {
    if (this.idle.length) return Promise.resolve(this.idle.pop()!);
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(w: Worker) {
    this.idle.push(w);
    this.flush();
  }

  get size(): number {
    return this.workers.length;
  }

  /**
   * Recognise one frame. `scale` is the factor the bitmap was upscaled by, so
   * boxes come back in original video pixel coordinates.
   */
  async recognize(bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas, scale: number): Promise<OcrResult> {
    await this.init();
    const w = await this.acquire();
    try {
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
      this.release(w);
    }
  }

  async terminate(): Promise<void> {
    const ws = this.workers;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.ready = null;
    await Promise.all(ws.map((w) => w.terminate().catch(() => {})));
  }
}
