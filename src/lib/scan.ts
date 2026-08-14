import { buildLine, boxForRange, extendOverFragments, scanLine, type OcrWord } from './detectors/scanText';
import { sameSecret } from './detectors/similarity';
import { yieldToLoop } from './util/yieldToLoop';
import { maskValue } from './detectors/catalog';
import { OcrPool } from './ocr/pool';
import { analyseTextLayout, buildView, mapWordsToSource, needsRebuild, type RecoveryView } from './ocr/preprocess';
import type { Box, CategoryId, Finding, FindingSource, Occurrence, Severity } from './types';
import { SEVERITY_RANK } from './types';
import { createGrabber, ocrScaleFor, seekTo, type LoadedVideo } from './video/frames';
import { hasChanged, meanLuma, signatureOf, type Signature } from './video/diff';
import { canStitchFaceTracks, detectFaces, faceBoxesMatch, initFaceDetector, isEstablishedFace } from './vision/faces';
import { detectQr, type QrStrength } from './vision/qr';

export interface ScanOptions {
  categories: Set<CategoryId>;
  /** Samples per second. 2 is a good default for screen recordings. */
  sampleFps?: number;
  onProgress?: (p: ScanProgress) => void;
  signal?: AbortSignal;
}

export interface ScanProgress {
  phase: 'models' | 'scanning' | 'done';
  ocr: boolean;
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
  /** Frames read twice because the screen was photographed rather than captured. */
  rebuilt: number;
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
  /** QR only: whether one frame is enough to believe it. See confirmQr. */
  strength?: QrStrength;
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
 * Whether a hit continues an existing track.
 *
 * OCR jitters by a pixel or two between frames and text scrolls, so a matching
 * string is allowed to have moved a few box-widths. That reach is far too
 * generous for a face: every face hit carries the same key, so `3x + 40px`
 * — around 1400px for a head-sized box — meant any face-shaped blob anywhere in
 * the frame joined the nearest face's track. It then inherited that track's
 * confidence, which is how a 0.53 box over a chair ended up riding on a 0.97
 * face, drawn as a second redaction that could not be judged or dismissed on
 * its own. A face does not cross the room in half a second: hold it to its own
 * size, and an impostor is forced to stand as a separate track and answer for
 * its own score.
 */
function sameOccurrence(track: Track, hit: FrameHit): boolean {
  if (track.key !== hit.key || track.source !== hit.source) return false;
  if (hit.source === 'face') return faceBoxesMatch(track.lastBox, hit.box);
  const span = Math.max(track.lastBox.w, track.lastBox.h, hit.box.w, hit.box.h);
  return centerDistance(track.lastBox, hit.box) <= span * 3 + 40;
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
  const wantOcr = [...categories].some((id) => id !== 'visual');

  const report = (p: Partial<ScanProgress> & Pick<ScanProgress, 'phase'>) =>
    opts.onProgress?.({
      t: 0,
      duration: video.duration,
      ocr: wantOcr,
      sampled: 0,
      analyzed: 0,
      skipped: 0,
      findings: 0,
      ...p,
    });

  const pool = wantOcr ? new OcrPool() : null;
  let poolClosed = false;
  const terminatePool = async () => {
    if (!pool || poolClosed) return;
    poolClosed = true;
    await pool.terminate();
  };

  try {
    if (wantOcr) {
      report({ phase: 'models', note: 'Starting OCR engine' });
      await pool!.init((loaded, total) => report({ phase: 'models', note: `Starting OCR engine ${loaded}/${total}` }));
    }

    if (wantFaces) {
      report({ phase: 'models', note: 'Loading face model' });
      const faceDetector = await initFaceDetector();
      if (!faceDetector) {
        throw new Error(
          'Face detection could not start, so the visual scan was not completed. Check that the local model files are available and try again.',
        );
      }
    }

    const scale = wantOcr ? ocrScaleFor(video.width, video.height) : 1;
    const full = createGrabber(video.width, video.height);

    const tracks: Track[] = [];
    let prevSig: Signature | null = null;
    let lastAnalysedT = -Infinity;
    /** Set when the last analysed frame held a QR read that needs corroborating. */
    let recheckForQr = false;
    let sampled = 0;
    let analyzed = 0;
    let skipped = 0;
    /** Analyzed frames that needed the deskewed rebuild — see ocr/preprocess. */
    let rebuiltFrames = 0;

    const gapTolerance = Math.max(1.0, interval * 2.5);

    const closeStale = (t: number) => {
      for (const tr of tracks) {
        if (tr.open && t - tr.lastT > gapTolerance) tr.open = false;
      }
    };

    const absorb = (hits: FrameHit[], t: number) => {
      // Vision detections are not labelled with an identity. Process stronger
      // observations first, and let a track consume at most one hit at this
      // timestamp. This keeps two same-payload OCR/QR copies separate as well as
      // preventing a weak hand box from being absorbed into a real face track.
      const ordered = [...hits].sort((a, b) => b.confidence - a.confidence);
      const matchedTracks = new Set<Track>();
      for (const hit of ordered) {
        const candidates = tracks
          .filter((tr) => tr.open && sameOccurrence(tr, hit) && !matchedTracks.has(tr))
          .sort((a, b) => centerDistance(a.lastBox, hit.box) - centerDistance(b.lastBox, hit.box));
        const match = candidates[0];
        if (match) {
          matchedTracks.add(match);
          match.lastT = t;
          match.confidence = Math.max(match.confidence, hit.confidence);
          if (boxMoved(match.lastBox, hit.box)) {
            match.occurrences.push({ t, box: hit.box });
            match.lastBox = hit.box;
          }
        } else {
          const created: Track = {
            ...hit,
            id: nextId(),
            firstT: t,
            lastT: t,
            lastBox: hit.box,
            occurrences: [{ t, box: hit.box }],
            open: true,
          };
          tracks.push(created);
          matchedTracks.add(created);
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
    const maxInflight = wantOcr ? Math.max(1, pool!.size) : 1;
    const seenKeys = new Set<string>();
    let ocrFailures = 0;

  // One scratch canvas per worker, checked out for the life of an OCR job so a
  // frame can't be overwritten while it's still being read. Tesseract reads
  // canvases directly, so there's no encode step in the middle.
    const freeCanvases = wantOcr
      ? Array.from({ length: maxInflight }, () =>
          createGrabber(Math.round(video.width * scale), Math.round(video.height * scale)),
        )
      : [];

    for (let i = 0; i <= total; i++) {
      if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
      const t = Math.min(video.duration - 0.001, i * interval);
      if (t < 0) break;

      await seekTo(video.el, t, { signal });
      full.grab(video.el);
      sampled++;

      const sig = signatureOf(full.canvas as unknown as CanvasImageSource);
    // Safety net: even if the gate never trips, never let more than
    // FORCED_REREAD_S pass without actually reading the screen. Bounds the
    // damage if a change lands just under the threshold.
      const stale = t - lastAnalysedT >= FORCED_REREAD_S;
    // A borderline QR read needs a second frame to be believed, but a QR code
    // sitting still on a static screen produces no change for the gate to
    // notice — so the corroborating frame would never be analysed. Take the
    // next one regardless.
      const chasingQr = recheckForQr;
      recheckForQr = false;
      const changed = stale || chasingQr || hasChanged(prevSig, sig);

      if (changed) {
        lastAnalysedT = t;
        prevSig = sig;
        analyzed++;

      // Tesseract is trained on dark-text-on-light-paper, but developers record
      // dark-mode editors and terminals — which is most of our target footage.
      // Inverting dark frames before OCR is a large, cheap accuracy win, and the
      // brightness comes free from the signature we just computed.
        const dark = meanLuma(sig) < 110;

        let shot: ReturnType<typeof createGrabber> | null = null;
        // A rebuilt, deskewed copy of the screen, for frames that are a camera
        // pointed at a monitor rather than a screen capture. Built here, on the
        // main thread, because it has to be cut from `full` before the loop
        // seeks past this timestamp and overwrites it.
        let rebuilt: RecoveryView | null = null;
        if (wantOcr) {
          while (freeCanvases.length === 0) {
            if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
            await Promise.race([...inflight].map((p) => p.catch(() => undefined)));
          }
          shot = freeCanvases.pop()!;
          shot.ctx.filter = dark ? 'invert(1)' : 'none';
          shot.ctx.drawImage(video.el, 0, 0, shot.width, shot.height);
          shot.ctx.filter = 'none';

          const layout = analyseTextLayout(full.canvas, video.width, video.height);
          if (needsRebuild(layout)) {
            rebuilt = buildView(full.canvas, layout, { invert: layout.dark, name: `t${t.toFixed(2)}` });
            rebuiltFrames++;
          }
        }

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
              confidence: q.strength === 'strong' ? 0.9 : 0.6,
              box: q.box,
              strength: q.strength,
            });
          }
          recheckForQr = visualHits.some((h) => h.source === 'qr' && h.strength === 'weak');
        }

        const reportHits = (hits: FrameHit[]) => {
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
        };

        const job = wantOcr
          ? pool!
              .recognize(shot!.canvas, scale)
              .then(async (ocr) => {
                if (!rebuilt) return ocr.lines;
                // The whole-frame read of a photographed screen is not merely
                // worse, it is empty — the layout analyser finds no block to
                // recognise. Both reads are kept and folded together anyway:
                // the crop is bounded to the largest text block, so anything in
                // a second window or outside it survives only in the first pass.
                const extra = await pool!.recognize(rebuilt.canvas, 1);
                return [...ocr.lines, ...mapWordsToSource(extra.lines, rebuilt)];
              })
              .then((lines) => [...hitsFromOcr(lines, categories), ...visualHits])
              .catch((err) => {
                // Keep the promise settled so the sampling loop can finish and
                // report one explicit scan error instead of a false clean
                // result. The visual hits are not enough to certify the frame.
                ocrFailures++;
                console.warn('[screensafe] OCR failed on a frame:', err);
                return visualHits;
              })
              .then(reportHits)
              .finally(() => freeCanvases.push(shot!))
          : Promise.resolve(visualHits).then(reportHits);

        samples.push({ t, analysed: true, hits: job });
        inflight.add(job);
        void job.then(
          () => inflight.delete(job),
          () => inflight.delete(job),
        );
        // Keep at most one queued frame per worker so memory stays bounded.
        while (inflight.size >= maxInflight) {
          if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
          await Promise.race([...inflight].map((p) => p.catch(() => undefined)));
        }
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
    if (wantOcr && ocrFailures > 0) {
      throw new Error(
        `OCR failed on ${ocrFailures} analyzed frame${ocrFailures === 1 ? '' : 's'}. Nothing was checked completely, so do not treat this as a clean result.`,
      );
    }

  // Resolve every frame's hits before folding: a borderline QR read can only be
  // judged against the frames around it.
    const resolved: Array<{ t: number; hits: FrameHit[] | null }> = [];
    for (const s of samples) {
      if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
      resolved.push({ t: s.t, hits: s.analysed && s.hits ? await s.hits : null });
    }
    confirmQr(resolved);

  // Now fold the results into tracks, strictly in time order.
    for (const s of resolved) {
      if (signal?.aborted) throw new DOMException('Scan cancelled', 'AbortError');
      if (s.hits) {
        closeStale(s.t);
        absorb(s.hits, s.t);
      } else {
        // Nothing on screen changed, so every open track is still on screen.
        for (const tr of tracks) if (tr.open) tr.lastT = s.t;
      }
    }

    const ocrWorkers = pool?.size ?? 0;

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
        rebuilt: rebuiltFrames,
      },
    };
  } finally {
    await terminatePool();
  }
}

/** How far apart two decodes of the same payload can be and still corroborate. */
const QR_CORROBORATION_S = 4;

/**
 * A QR code that is really on screen decodes to the same payload every time the
 * scanner looks at it. A lucky error-corrected read of some texture does not.
 *
 * So a hit whose evidence is merely adequate (`weak` — a small code, a skewed
 * quad, a terse payload) has to turn up twice within a few seconds before it
 * becomes a finding. A hit with room to spare (`strong`) is taken on one frame,
 * because a screen recording can show a crisp code for a single sampled instant
 * and dropping a real 2FA enrolment code is the worse mistake.
 */
function confirmQr(frames: Array<{ t: number; hits: FrameHit[] | null }>): void {
  const sightings = new Map<string, Array<{ t: number; box: Box }>>();
  for (const f of frames) {
    for (const h of f.hits ?? []) {
      if (h.source !== 'qr') continue;
      const seen = sightings.get(h.key);
      if (seen) seen.push({ t: f.t, box: h.box });
      else sightings.set(h.key, [{ t: f.t, box: h.box }]);
    }
  }

  for (const f of frames) {
    if (!f.hits) continue;
    f.hits = f.hits.filter((h) => {
      if (h.source !== 'qr' || h.strength === 'strong') return true;
      const seen = sightings.get(h.key) ?? [];
      const span = Math.max(h.box.w, h.box.h);
      return seen.some(
        (s) =>
          s.t !== f.t &&
          Math.abs(s.t - f.t) <= QR_CORROBORATION_S &&
          centerDistance(s.box, h.box) <= span * 3 + 40,
      );
    });
  }
}

/** Rules that fire on shape alone, when a named rule didn't claim the value. */
const GENERIC_DETECTORS = new Set([
  'labeled-secret',
  'secret-assignment',
  'bearer-token',
  'password-assignment',
]);

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

/**
 * A face the model was never once sure about, in any frame it appeared in, is
 * not a face.
 *
 * Detection is judged twice, and it has to be. Within a frame, a box the model
 * doubts is dropped when a box it trusts sits beside it — that removes the hand
 * and the chair back. But a recording with no face in it at all has nothing
 * confident to compare against, so a lone 0.48 blob survives the frame and
 * becomes a finding: the synthetic demo, which is a code editor and contains no
 * people, produced two "Face" findings at 46% and 48% for exactly this reason.
 *
 * A track carries the best score the face ever reached, so the question can be
 * asked over the whole sighting instead of one frame. A real face clears 0.7
 * somewhere — measured, they run 0.72 to 0.94 — while a hallucination never
 * does. Keeping the track whole matters: the weak frames of a real face, where
 * it turns away or blurs, stay covered because the track as a whole earned it.
 *
 * The cost is a face that never once scores 0.7 in an entire recording, which
 * is the regime where detection is already unreliable.
 */
function establishedFace(tr: Track): boolean {
  return tr.source !== 'face' || isEstablishedFace(tr.confidence);
}

/**
 * Rejoin a face that the tracker dropped and picked up again.
 *
 * Association is deliberately tight — a face must stay within its own size
 * between samples, which is what stops a chair back from being absorbed into a
 * real face's track. The cost is that a quick head movement ends one track and
 * starts another, and the reviewer is shown two identical "Face" rows for one
 * continuous person.
 *
 * Stitching is done here rather than by loosening association, because the two
 * questions are different: tracking asks "is this the same object", which has
 * to be strict, while the list asks "is this the same thing to review", which
 * does not. Tracks are only joined when one *ends before* the next begins.
 * Two people on screen together overlap in time, so they stay separate rows and
 * can still be allowed or blurred independently.
 */
function stitchFaceTracks(tracks: Track[], interval: number): Track[] {
  const gap = Math.max(1.0, interval * 2.5);
  const out: Track[] = [];
  for (const tr of [...tracks].sort((a, b) => a.firstT - b.firstT)) {
    const firstBox = tr.occurrences[0]?.box ?? tr.lastBox;
    const host =
      tr.source === 'face'
        ? out.find(
            (h) =>
              h.source === 'face' &&
              canStitchFaceTracks({ lastT: h.lastT, lastBox: h.lastBox }, { firstT: tr.firstT, firstBox }, gap),
          )
        : undefined;
    if (!host) {
      out.push(tr);
      continue;
    }
    host.lastT = Math.max(host.lastT, tr.lastT);
    host.lastBox = tr.lastBox;
    host.confidence = Math.max(host.confidence, tr.confidence);
    host.occurrences.push(...tr.occurrences);
  }
  return out;
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
  const tracks = stitchFaceTracks(mergeDuplicateTracks(rawTracks).filter(establishedFace), interval);
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
          ? 'QR code'
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
