import { buildLine, boxForRange, extendOverFragments, scanLine, type OcrWord } from './detectors/scanText';
import { sameSecret } from './detectors/similarity';
import { yieldToLoop } from './util/yieldToLoop';
import { maskValue } from './detectors/catalog';
import { OcrPool } from './ocr/pool';
import type { Box, CategoryId, Finding, FindingSource, Occurrence, Severity } from './types';
import { SEVERITY_RANK } from './types';
import { createGrabber, ocrScaleFor, seekTo, type LoadedVideo } from './video/frames';
import { hasChanged, meanLuma, signatureOf, type Signature } from './video/diff';
import { detectFaces, initFaceDetector } from './vision/faces';
import { detectQr } from './vision/qr';

export interface ScanOptions {
  categories: Set<CategoryId>;
  /** Samples per second. 2 is a good default for screen recordings. */
  sampleFps?: number;
  onProgress?: (p: ScanProgress) => void;
  signal?: AbortSignal;
}

export interface ScanProgress {
  phase: 'models' | 'scanning' | 'done';
  t: number;
  duration: number;
  sampled: number;
  analyzed: number;
  skipped: number;
  findings: number;
  note?: string;
}

export interface ScanStats {
  sampled: number;
  analyzed: number;
  skipped: number;
  elapsedMs: number;
  sampleInterval: number;
  ocrWorkers: number;
}

export interface ScanResult {
  findings: Finding[];
  stats: ScanStats;
}

/** Never go longer than this without reading the screen, changed or not. */
const FORCED_REREAD_S = 5;

interface FrameHit {
  key: string;
  detectorId: string;
  label: string;
  category: CategoryId;
  severity: Severity;
  value: string;
  source: FindingSource;
  confidence: number;
  box: Box;
}

interface Track extends Omit<FrameHit, 'box'> {
  id: string;
  firstT: number;
  lastT: number;
  lastBox: Box;
  occurrences: Occurrence[];
  open: boolean;
}

function centerDistance(a: Box, b: Box): number {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  return Math.hypot(dx, dy);
}

function boxMoved(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2 || Math.abs(a.w - b.w) > 2 || Math.abs(a.h - b.h) > 2
  );
}

/**
 * OCR jitters by a pixel or two between frames, and text sometimes scrolls.
 * We treat a hit as the same occurrence when it carries the same value and
 * hasn't jumped further than a few box-widths.
 */
function sameOccurrence(track: Track, hit: FrameHit): boolean {
  if (track.key !== hit.key) return false;
  const reach = Math.max(track.lastBox.w, track.lastBox.h, hit.box.w, hit.box.h) * 3 + 40;
  return centerDistance(track.lastBox, hit.box) <= reach;
}

let idSeq = 0;
const nextId = () => `f${(++idSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function hitsFromOcr(lines: Array<{ words: OcrWord[] }>, categories: Set<CategoryId>): FrameHit[] {
  const hits: FrameHit[] = [];
  for (const line of lines) {
    const built = buildLine(line.words);
    const matches = scanLine(built.text, categories);
    for (const m of matches) {
      // Cover OCR-split tails of long secrets, not just the matched span.
      const coverEnd = extendOverFragments(built, m.start, m.end);
      const box = boxForRange(built, m.start, coverEnd);
      if (!box) continue;
      const conf =
        built.words.length > 0
          ? built.words.reduce((acc, w) => acc + w.confidence, 0) / built.words.length
          : 0.5;
      hits.push({
        key: `${m.detectorId}|${m.value.toLowerCase()}`,
        detectorId: m.detectorId,
        label: m.label,
        category: m.category,
        severity: m.severity,
        value: m.value,
        source: 'ocr',
        confidence: conf,
        box,
      });
    }
  }
  return hits;
}

export async function scanVideo(video: LoadedVideo, opts: ScanOptions): Promise<ScanResult> {
  const started = performance.now();
  const sampleFps = opts.sampleFps ?? 2;
  const interval = 1 / sampleFps;
  const { categories, signal } = opts;
  const wantFaces = categories.has('visual');

  const report = (p: Partial<ScanProgress> & Pick<ScanProgress, 'phase'>) =>
    opts.onProgress?.({
      t: 0,
      duration: video.duration,
      sampled: 0,
      analyzed: 0,
      skipped: 0,
      findings: 0,
      ...p,
    });

  report({ phase: 'models', note: 'Starting OCR engine' });

  const pool = new OcrPool();
  await pool.init((loaded, total) => report({ phase: 'models', note: `Starting OCR engine ${loaded}/${total}` }));

  if (wantFaces) {
    report({ phase: 'models', note: 'Loading face model' });
    await initFaceDetector();
  }

  const scale = ocrScaleFor(video.width, video.height);
  const full = createGrabber(video.width, video.height);

  const tracks: Track[] = [];
  let prevSig: Signature | null = null;
  let lastAnalysedT = -Infinity;
  let sampled = 0;
  let analyzed = 0;
  let skipped = 0;

  const gapTolerance = Math.max(1.0, interval * 2.5);

  const closeStale = (t: number) => {
    for (const tr of tracks) {
      if (tr.open && t - tr.lastT > gapTolerance) tr.open = false;
    }
  };

  const absorb = (hits: FrameHit[], t: number) => {
    for (const hit of hits) {
      const match = tracks.find((tr) => tr.open && sameOccurrence(tr, hit));
      if (match) {
        match.lastT = t;
        match.confidence = Math.max(match.confidence, hit.confidence);
        if (boxMoved(match.lastBox, hit.box)) {
          match.occurrences.push({ t, box: hit.box });
          match.lastBox = hit.box;
        }
      } else {
        tracks.push({
          ...hit,
          id: nextId(),
          firstT: t,
          lastT: t,
          lastBox: hit.box,
          occurrences: [{ t, box: hit.box }],
          open: true,
        });
      }
    }
  };

  const total = Math.max(1, Math.floor(video.duration / interval));

  /**
   * Frames must be *grabbed* serially — there is one video element and one
   * decode position — but OCR is the expensive part and it lives in workers, so
   * it runs concurrently across the pool. We record each sample in order and
   * carry a promise for its hits; tracking happens afterwards, walking the
   * samples in time order, so out-of-order OCR completion can't corrupt the
   * time ranges.
   */
  interface Sample {
    t: number;
    analysed: boolean;
    hits?: Promise<FrameHit[]>;
  }

  const samples: Sample[] = [];
  const inflight = new Set<Promise<unknown>>();
  const maxInflight = Math.max(1, pool.size);
  const seenKeys = new Set<string>();
  let ocrFailures = 0;

  // One scratch canvas per worker, checked out for the life of an OCR job so a
  // frame can't be overwritten while it's still being read. Tesseract reads
  // canvases directly, so there's no encode step in the middle.
  const freeCanvases = Array.from({ length: maxInflight }, () =>
    createGrabber(Math.round(video.width * scale), Math.round(video.height * scale)),
  );

  for (let i = 0; i <= total; i++) {
    if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
    const t = Math.min(video.duration - 0.001, i * interval);
    if (t < 0) break;

    await seekTo(video.el, t);
    full.grab(video.el);
    sampled++;

    const sig = signatureOf(full.canvas as unknown as CanvasImageSource);
    // Safety net: even if the gate never trips, never let more than
    // FORCED_REREAD_S pass without actually reading the screen. Bounds the
    // damage if a change lands just under the threshold.
    const stale = t - lastAnalysedT >= FORCED_REREAD_S;
    const changed = stale || hasChanged(prevSig, sig);

    if (changed) {
      lastAnalysedT = t;
      prevSig = sig;
      analyzed++;

      // Tesseract is trained on dark-text-on-light-paper, but developers record
      // dark-mode editors and terminals — which is most of our target footage.
      // Inverting dark frames before OCR is a large, cheap accuracy win, and the
      // brightness comes free from the signature we just computed.
      const dark = meanLuma(sig) < 110;

      while (freeCanvases.length === 0) await Promise.race(inflight);
      const shot = freeCanvases.pop()!;
      shot.ctx.filter = dark ? 'invert(1)' : 'none';
      shot.ctx.drawImage(video.el, 0, 0, shot.width, shot.height);
      shot.ctx.filter = 'none';

      // Faces and QR are milliseconds on the main thread — do them inline.
      const visualHits: FrameHit[] = [];
      if (categories.has('visual')) {
        for (const f of detectFaces(full.canvas, video.width, video.height)) {
          visualHits.push({
            key: 'face',
            detectorId: 'face',
            label: 'Face',
            category: 'visual',
            severity: 'medium',
            value: 'face',
            source: 'face',
            confidence: f.confidence,
            box: f.box,
          });
        }
        for (const q of detectQr(full.toImageData())) {
          visualHits.push({
            key: `qr|${q.data}`,
            detectorId: 'qr',
            label: 'QR code',
            category: 'visual',
            severity: 'high',
            value: q.data || 'QR code',
            source: 'qr',
            confidence: 0.9,
            box: q.box,
          });
        }
      }

      const job = pool
        .recognize(shot.canvas, scale)
        .then((ocr) => [...hitsFromOcr(ocr.lines, categories), ...visualHits])
        .catch((err) => {
          ocrFailures++;
          console.warn('[screensafe] OCR failed on a frame:', err);
          return visualHits;
        })
        .then((hits) => {
          // Tracking happens later, but the reviewer should watch the count
          // climb while the scan runs — distinct values is a good live proxy.
          for (const h of hits) seenKeys.add(h.key);
          report({
            phase: 'scanning',
            t,
            duration: video.duration,
            sampled,
            analyzed,
            skipped,
            findings: seenKeys.size,
          });
          return hits;
        })
        .finally(() => freeCanvases.push(shot));

      samples.push({ t, analysed: true, hits: job });
      inflight.add(job);
      void job.finally(() => inflight.delete(job));
      // Keep at most one queued frame per worker so memory stays bounded.
      while (inflight.size >= maxInflight) await Promise.race(inflight);
    } else {
      skipped++;
      samples.push({ t, analysed: false });
    }

    report({
      phase: 'scanning',
      t,
      duration: video.duration,
      sampled,
      analyzed,
      skipped,
      findings: seenKeys.size,
    });
  }

  // A scan that read nothing must never be reported as "nothing found" — for a
  // tool whose whole job is catching leaks, a silent failure is the worst
  // possible outcome. Fail loudly instead.
  await Promise.allSettled(inflight);
  if (analyzed > 0 && ocrFailures === analyzed) {
    await pool.terminate();
    throw new Error(
      'Could not read any frames of this video — the scan produced no usable text. Nothing was checked, so do not treat this as a clean result.',
    );
  }

  // Now fold the results into tracks, strictly in time order.
  for (const s of samples) {
    if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
    if (s.analysed && s.hits) {
      const hits = await s.hits;
      closeStale(s.t);
      absorb(hits, s.t);
    } else {
      // Nothing on screen changed, so every open track is still on screen.
      for (const tr of tracks) if (tr.open) tr.lastT = s.t;
    }
  }

  const ocrWorkers = pool.size;
  await pool.terminate();

  const findings = tracksToFindings(tracks, interval, video.duration);
  report({
    phase: 'done',
    t: video.duration,
    duration: video.duration,
    sampled,
    analyzed,
    skipped,
    findings: findings.length,
  });

  return {
    findings,
    stats: {
      sampled,
      analyzed,
      skipped,
      elapsedMs: performance.now() - started,
      sampleInterval: interval,
      ocrWorkers,
    },
  };
}

/** Rules that fire on shape alone, when a named rule didn't claim the value. */
const GENERIC_DETECTORS = new Set(['labeled-secret', 'bearer-token', 'password-assignment']);

function overlapRatio(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = x * y;
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? inter / smaller : 0;
}

/**
 * The same secret can land in the queue twice: once from a partial read while
 * it was still being typed, once fully; or once from its named rule and once
 * from the generic "looks like a secret" rule. Both cover the same pixels at
 * the same moment, so showing them as two rows is just noise for the reviewer.
 *
 * Merge when the values are one-inside-the-other, the boxes sit on top of each
 * other, and the sightings are contiguous in time — then keep whichever
 * identification is more specific.
 */
function mergeDuplicateTracks(tracks: Track[]): Track[] {
  const byStart = [...tracks].sort((a, b) => a.firstT - b.firstT);
  const kept: Track[] = [];

  for (const tr of byStart) {
    const host = kept.find((h) => {
      if (h.source !== tr.source || h.source !== 'ocr') return false;
      if (tr.firstT > h.lastT + 1.5) return false; // not contiguous
      if (!sameSecret(h.value, tr.value)) return false;
      return overlapRatio(h.lastBox, tr.occurrences[0]?.box ?? tr.lastBox) > 0.3;
    });

    if (!host) {
      kept.push(tr);
      continue;
    }

    // Prefer the more specific identification: a real severity ranking first,
    // then a named rule over a generic one, then the longer (more complete) read.
    const hostGeneric = GENERIC_DETECTORS.has(host.detectorId);
    const trGeneric = GENERIC_DETECTORS.has(tr.detectorId);
    const better =
      SEVERITY_RANK[tr.severity] < SEVERITY_RANK[host.severity] ||
      (tr.severity === host.severity && hostGeneric && !trGeneric) ||
      (tr.severity === host.severity && hostGeneric === trGeneric && tr.value.length > host.value.length);

    if (better) {
      host.detectorId = tr.detectorId;
      host.label = tr.label;
      host.category = tr.category;
      host.severity = tr.severity;
      host.value = tr.value;
    }
    host.firstT = Math.min(host.firstT, tr.firstT);
    host.lastT = Math.max(host.lastT, tr.lastT);
    host.confidence = Math.max(host.confidence, tr.confidence);
    host.occurrences.push(...tr.occurrences);
  }

  return kept;
}

function tracksToFindings(rawTracks: Track[], interval: number, duration: number): Finding[] {
  if (import.meta.env?.DEV) {
    // Pre-merge tracks, for tuning the dedupe rules against real OCR output.
    (globalThis as unknown as { __ssTracks?: unknown }).__ssTracks = rawTracks.map((t) => ({
      det: t.detectorId,
      v: t.value,
      f: +t.firstT.toFixed(2),
      l: +t.lastT.toFixed(2),
      box: t.lastBox,
    }));
  }
  const tracks = mergeDuplicateTracks(rawTracks);
  const findings: Finding[] = tracks.map((tr) => ({
    id: tr.id,
    detectorId: tr.detectorId,
    label: tr.label,
    category: tr.category,
    severity: tr.severity,
    value: tr.value,
    masked:
      tr.source === 'face'
        ? 'Face'
        : tr.source === 'qr'
          ? tr.value.slice(0, 28) + (tr.value.length > 28 ? '…' : '')
          : maskValue(tr.detectorId, tr.value),
    // Pad outward by a full sample interval: we know the value was visible at
    // the sampled instants, and it probably appeared slightly before and left
    // slightly after. Over-blurring is recoverable; a leak is not.
    start: Math.max(0, tr.firstT - interval),
    end: Math.min(duration, tr.lastT + interval),
    occurrences: tr.occurrences.sort((a, b) => a.t - b.t),
    redact: true,
    source: tr.source,
    confidence: tr.confidence,
  }));

  return findings.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return a.start - b.start;
  });
}
