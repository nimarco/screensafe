import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Finding } from '../types';
import { createGrabber, seekTo, type LoadedVideo } from './frames';
import { activeBoxes, paintRedactions } from './redact';
import { yieldToLoop } from '../util/yieldToLoop';

export interface ExportProgress {
  phase: 'preparing' | 'audio' | 'video' | 'finalizing' | 'done';
  done: number;
  total: number;
  note?: string;
}

export interface ExportOptions {
  fps?: number;
  maxWidth?: number;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  format: 'mp4' | 'webm';
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  elapsedMs: number;
}

export function webCodecsAvailable(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

function evenize(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

function safeName(original: string): string {
  const base = original.replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_');
  return `${base || 'video'}-screensafe`;
}

/** H.264 levels, smallest that fits. Falls back down the list if unsupported. */
const AVC_CANDIDATES = ['avc1.640034', 'avc1.640028', 'avc1.4d0028', 'avc1.42002a', 'avc1.42001f'];

async function pickAvcCodec(width: number, height: number, fps: number, bitrate: number): Promise<string | null> {
  for (const codec of AVC_CANDIDATES) {
    try {
      const res = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
      if (res.supported) return codec;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

interface DecodedAudio {
  buffer: AudioBuffer;
}

async function decodeAudio(file: File): Promise<DecodedAudio | null> {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const bytes = await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    await ctx.close();
    if (!buffer || buffer.length === 0 || buffer.numberOfChannels === 0) return null;
    return { buffer };
  } catch {
    return null; // silent video, or a codec the browser won't decode
  }
}

function assertExportVisible(): void {
  if (document.visibilityState !== 'visible') {
    throw new Error('Export stopped because the document is hidden. Keep this tab visible and try again.');
  }
}

/**
 * Re-encode the source with redactions burned in.
 *
 * Frames are pulled from the decoder's presented-frame callbacks when the
 * browser supports them. A stalled stream may fall back to confirmed seeks,
 * but no frame is composited without a callback proving that the decoder has
 * presented the requested moment.
 */
export async function exportRedacted(
  video: LoadedVideo,
  findings: Finding[],
  opts: ExportOptions = {},
): Promise<ExportResult> {
  // A hidden document may report the requested currentTime while withholding
  // the compositor callback that proves which pixels drawImage will receive.
  // There is no safe timing fallback for a privacy export, so refuse it.
  assertExportVisible();
  if (!webCodecsAvailable()) return exportViaMediaRecorder(video, findings, opts);

  const started = performance.now();
  const fps = opts.fps ?? 30;
  const maxWidth = opts.maxWidth ?? Infinity;
  const scale = Math.min(1, maxWidth / video.width);
  const width = evenize(video.width * scale);
  const height = evenize(video.height * scale);
  const { signal } = opts;

  const report = (p: ExportProgress) => opts.onProgress?.(p);
  report({ phase: 'preparing', done: 0, total: 1, note: 'Configuring encoder' });

  const bitrate = Math.round(Math.min(16e6, Math.max(2e6, width * height * fps * 0.12)));
  const codec = await pickAvcCodec(width, height, fps, bitrate);
  if (!codec) return exportViaMediaRecorder(video, findings, opts);

  const audio = await decodeAudio(video.file);

  let audioConfigured = false;
  if (audio && typeof AudioEncoder !== 'undefined') {
    try {
      const res = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: audio.buffer.sampleRate,
        numberOfChannels: Math.min(2, audio.buffer.numberOfChannels),
        bitrate: 128_000,
      });
      audioConfigured = !!res.supported;
    } catch {
      audioConfigured = false;
    }
  }

  const channels = audio ? Math.min(2, audio.buffer.numberOfChannels) : 0;

  /* ------------------------------------------------------------- audio
   *
   * Encoded to a buffer *before* the muxer is built. Audio is the most
   * fragile part of the pipeline (codec support, sample formats, exotic source
   * tracks), and doing it first means a failure degrades to "exports without
   * sound" instead of a half-declared audio track or a promise that never
   * settles. The whole soundtrack of a 5 minute clip is a few hundred KB here.
   */
  let audioChunks: Array<{ chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }> | null = null;

  if (audioConfigured && audio) {
    report({ phase: 'audio', done: 0, total: 1, note: 'Encoding audio' });
    const collected: Array<{ chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }> = [];
    try {
      let encoderError: unknown = null;
      const encoder = new AudioEncoder({
        output: (chunk, meta) => collected.push({ chunk, meta }),
        error: (e) => {
          encoderError = e;
        },
      });
      encoder.configure({
        codec: 'mp4a.40.2',
        sampleRate: audio.buffer.sampleRate,
        numberOfChannels: channels,
        bitrate: 128_000,
      });

      const sr = audio.buffer.sampleRate;
      const totalFrames = audio.buffer.length;
      const CHUNK = 8192;
      const planes: Float32Array[] = [];
      for (let c = 0; c < channels; c++) planes.push(audio.buffer.getChannelData(c));

      for (let offset = 0; offset < totalFrames && !encoderError; offset += CHUNK) {
        if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
        const count = Math.min(CHUNK, totalFrames - offset);
        const planar = new Float32Array(count * channels);
        for (let c = 0; c < channels; c++) {
          planar.set(planes[c].subarray(offset, offset + count), c * count);
        }
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: sr,
          numberOfFrames: count,
          numberOfChannels: channels,
          timestamp: Math.round((offset / sr) * 1e6),
          data: planar,
        });
        encoder.encode(data);
        data.close();
        if (encoder.encodeQueueSize > 16) await yieldToLoop();
      }

      // Never let a wedged encoder hang the whole export.
      const flushed = await Promise.race([
        encoder.flush().then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 20_000)),
      ]);
      try {
        encoder.close();
      } catch {
        /* already closed by the error path */
      }
      if (!flushed || encoderError) throw encoderError ?? new Error('audio encoder timed out');
      audioChunks = collected;
    } catch (err) {
      console.warn('[screensafe] audio could not be re-encoded; exporting without sound:', err);
      audioChunks = null;
    }
  }

  const withAudio = !!audioChunks && audioChunks.length > 0 && !!audio;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: 'in-memory',
    /*
     * The streaming path below takes its timestamps from the source's own
     * presentation times, and the first frame a video element presents is not
     * reliably at exactly 0. The muxer's default is `strict`, which *throws*
     * on a non-zero first chunk — and it throws inside the VideoEncoder's
     * output callback, where nothing awaits it: the frame is dropped, the
     * encoder is poisoned, and the export used to sail on and report success
     * over a file with holes in it.
     *
     * `cross-track-offset` shifts every track by the same amount, so audio and
     * video keep their true relative timing (both clocks come from the same
     * source media).
     */
    firstTimestampBehavior: 'cross-track-offset',
    // No frameRate hint: timestamps come from the source's own presentation
    // times, so letting the muxer round them to an assumed rate would corrupt
    // the timing of 24fps, 60fps and variable-rate recordings.
    video: { codec: 'avc', width, height },
    ...(withAudio && audio
      ? {
          audio: {
            codec: 'aac' as const,
            numberOfChannels: channels,
            sampleRate: audio.buffer.sampleRate,
          },
        }
      : {}),
  });

  if (withAudio && audioChunks) {
    for (const { chunk, meta } of audioChunks) muxer.addAudioChunk(chunk, meta);
  }

  /* ------------------------------------------------------------- video
   *
   * Anything that goes wrong between `encode()` and the bytes landing in the
   * muxer means the file is missing frames. For a redaction tool that is not a
   * degraded export, it's a wrong one: a hole where a covered frame should be.
   * Both failure routes are recorded here and rethrown before we hand anything
   * back, so a damaged file can never be presented as a finished export.
   */
  let writeError: unknown = null;
  const noteWriteError = (err: unknown) => {
    if (writeError === null) writeError = err;
  };

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (err) {
        noteWriteError(err);
      }
    },
    error: (e) => noteWriteError(e),
  });
  encoder.configure({
    codec,
    width,
    height,
    bitrate,
    framerate: fps,
    latencyMode: 'quality',
  });

  const canvas = createGrabber(width, height);
  const frameCount = Math.max(1, Math.floor(video.duration * fps));
  const keyEvery = Math.round(fps * 2);
  let emitted = 0;

  const composite = (t: number) => {
    canvas.ctx.drawImage(video.el, 0, 0, width, height);
    // Findings are stored in source pixels; scale them if we resized.
    const boxes = activeBoxes(findings, t, video.width, video.height).map((b) =>
      scale === 1 ? b : { x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale },
    );
    paintRedactions(canvas.ctx, boxes, width, height);
  };

  /** Returns false once the encoder is no longer accepting frames. */
  const emit = (t: number, durationUs: number): boolean => {
    if (writeError !== null) return false;
    const frame = new VideoFrame(canvas.canvas as CanvasImageSource, {
      timestamp: Math.round(t * 1e6),
      duration: durationUs,
    });
    try {
      encoder.encode(frame, { keyFrame: emitted % keyEvery === 0 });
    } catch (err) {
      // A closed or errored codec throws synchronously. Inside the frame
      // callback below that would just vanish, so record it instead.
      noteWriteError(err);
      return false;
    } finally {
      frame.close();
    }
    emitted++;
    if (emitted % 5 === 0) {
      report({ phase: 'video', done: emitted, total: frameCount, note: 'Rendering redacted frames' });
    }
    return true;
  };

  const exportEl = video.el as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  };
  const canStream = typeof exportEl.requestVideoFrameCallback === 'function';

  // rVFC only fires for a connected element that the browser is presenting.
  // The review screen already mounts its source element, but the verification
  // tools intentionally exercise detached elements too.
  const detached = !exportEl.isConnected;
  if (detached) {
    exportEl.style.cssText =
      'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(exportEl);
  }
  // The strict seek confirmation may briefly play the element to make the
  // browser present a frame. Keep that autoplay-safe and preserve the source
  // video's audio only through the separately encoded track.
  exportEl.muted = true;

  try {
    if (canStream) {
    /*
     * Pull frames by playing the video rather than seeking to each one.
     *
     * Seeking looks tidier but is pathologically slow here: keyframes are two
     * seconds apart, so every seek re-decodes up to 60 frames, and a 22s clip
     * costs ~20,000 decodes. Playing decodes each frame exactly once and hands
     * it over via requestVideoFrameCallback with its true presentation time —
     * roughly 20x faster, and it preserves the source's own frame timing.
     */
    const el = exportEl as HTMLVideoElement & {
      requestVideoFrameCallback: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    };

    assertExportVisible();
    await seekTo(el, 0, { requireFrameCallback: true });
    el.playbackRate = 1;

    const streamed = await new Promise<{ complete: boolean; resumeT: number }>((resolve, reject) => {
      let lastT = -1;
      let lastFrameAt = performance.now();
      let watchdog = 0;
      const cleanup = () => {
        window.clearInterval(watchdog);
        el.removeEventListener('ended', onEnded);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        el.pause();
      };
      const onVisibilityChange = () => {
        if (document.visibilityState !== 'visible') {
          cleanup();
          reject(new Error('Export stopped because the document became hidden. Keep this tab visible and try again.'));
        }
      };
      const onEnded = () => {
        cleanup();
        resolve({ complete: true, resumeT: lastT });
      };
      const step = (_now: number, meta: { mediaTime: number }) => {
        if (signal?.aborted) {
          cleanup();
          reject(new DOMException('Export cancelled', 'AbortError'));
          return;
        }
        lastFrameAt = performance.now();
        const t = meta.mediaTime;
        // rVFC can repeat a frame across callbacks; never emit a timestamp twice.
        if (t > lastT) {
          composite(t);
          if (!emit(t, Math.round(1e6 / fps))) {
            // The encoder is gone. Stop pulling frames and let the check after
            // this block turn it into a failed export rather than a short file.
            cleanup();
            resolve({ complete: true, resumeT: lastT });
            return;
          }
          lastT = t;
        }
        if (el.ended) {
          cleanup();
          resolve({ complete: true, resumeT: lastT });
          return;
        }
        el.requestVideoFrameCallback(step);
      };
      // A hidden tab presents no frames at all — rVFC stops firing and playback
      // itself stalls. That happens on first start (headless, backgrounded) and
      // mid-export when the user switches away, so watch continuously and fail
      // closed rather than handing the rest of the job to an unconfirmed path.
      watchdog = window.setInterval(() => {
        if (performance.now() - lastFrameAt > 4000) {
          if (document.visibilityState !== 'visible') {
            cleanup();
            reject(new Error('Export stopped because the document became hidden. Keep this tab visible and try again.'));
            return;
          }
          cleanup();
          resolve({ complete: false, resumeT: lastT });
        }
      }, 1000);
      document.addEventListener('visibilitychange', onVisibilityChange);
      el.addEventListener('ended', onEnded);
      el.requestVideoFrameCallback(step);
      el.play().catch((err) => {
        cleanup();
        reject(err);
      });
    });

    if (!streamed.complete) {
      assertExportVisible();
      console.warn('[screensafe] frame streaming stalled; finishing by confirmed seeking');
      const startFrame = Math.max(0, Math.floor(streamed.resumeT * fps) + 1);
      for (let i = startFrame; i < frameCount; i++) {
        if (signal?.aborted) {
          encoder.close();
          throw new DOMException('Export cancelled', 'AbortError');
        }
        assertExportVisible();
        const t = i / fps;
        await seekTo(video.el, Math.min(t, video.duration - 0.001), { requireFrameCallback: true });
        composite(t);
        if (!emit(t, Math.round(1e6 / fps))) break;
        while (encoder.encodeQueueSize > 8) await yieldToLoop();
      }
    }
  } else {
    for (let i = 0; i < frameCount; i++) {
      if (signal?.aborted) {
        encoder.close();
        throw new DOMException('Export cancelled', 'AbortError');
      }
      assertExportVisible();
      const t = i / fps;
      await seekTo(video.el, Math.min(t, video.duration - 0.001), { requireFrameCallback: true });
      composite(t);
      if (!emit(t, Math.round(1e6 / fps))) break;
      while (encoder.encodeQueueSize > 8) await yieldToLoop();
    }
  }
  } catch (err) {
    try {
      encoder.close();
    } catch {
      /* the original failure may already have closed the encoder */
    }
    throw err;
  } finally {
    if (detached && exportEl.parentElement === document.body) exportEl.remove();
  }

  // Fail closed. A short or holed file here is worse than no file: the user
  // would download it believing the secrets had been covered.
  if (writeError !== null || emitted === 0) {
    console.error('[screensafe] export aborted; frames were not written:', writeError);
    try {
      encoder.close();
    } catch {
      /* the error path may have closed it already */
    }
    throw new Error(
      'Export failed before the file was complete, so nothing was saved. Some frames could not be ' +
        'encoded, and a partial file could have left secrets visible.',
    );
  }

  report({ phase: 'finalizing', done: emitted, total: emitted, note: 'Writing MP4' });
  await encoder.flush();
  encoder.close();

  // flush() drains the queue through the output callback, so a chunk can still
  // be rejected on the way out. Check once more before calling it a file.
  if (writeError !== null) {
    console.error('[screensafe] export aborted while flushing:', writeError);
    throw new Error(
      'Export failed while writing the last frames, so nothing was saved. A partial file could have ' +
        'left secrets visible.',
    );
  }

  muxer.finalize();

  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  report({ phase: 'done', done: emitted, total: emitted });

  return {
    blob,
    filename: `${safeName(video.file.name)}.mp4`,
    format: 'mp4',
    width,
    height,
    fps: video.duration > 0 ? Math.round(emitted / video.duration) : fps,
    hasAudio: withAudio,
    elapsedMs: performance.now() - started,
  };
}

/* ------------------------------------------------------------------------ */

/**
 * Fallback for browsers without WebCodecs. Records the redacted canvas in real
 * time, so it costs one playthrough and produces WebM.
 */
async function exportViaMediaRecorder(
  video: LoadedVideo,
  findings: Finding[],
  opts: ExportOptions,
): Promise<ExportResult> {
  assertExportVisible();
  const started = performance.now();
  const fps = opts.fps ?? 30;
  const width = evenize(video.width);
  const height = evenize(video.height);
  const report = (p: ExportProgress) => opts.onProgress?.(p);
  const exportEl = video.el as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  if (typeof exportEl.requestVideoFrameCallback !== 'function') {
    throw new Error('Frame-accurate export is unavailable because this browser cannot confirm video frames.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const stream = canvas.captureStream(fps);
  let audioCtx: AudioContext | null = null;
  let hasAudio = false;
  try {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaElementSource(video.el);
    const dest = audioCtx.createMediaStreamDestination();
    src.connect(dest);
    for (const track of dest.stream.getAudioTracks()) {
      stream.addTrack(track);
      hasAudio = true;
    }
  } catch {
    hasAudio = false;
  }

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) =>
    MediaRecorder.isTypeSupported(m),
  );
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  let recorderStarted = false;
  let frameCallback: number | null = null;
  let drawn = false;
  let visibilityError: Error | null = null;
  let resolveDrawing: (() => void) | null = null;
  let rejectDrawing: ((err: unknown) => void) | null = null;
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') {
      visibilityError = new Error('Export stopped because the document became hidden. Keep this tab visible and try again.');
      video.el.pause();
      rejectDrawing?.(visibilityError);
      if (recorderStarted && recorder.state !== 'inactive') recorder.stop();
    }
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  const onEnded = () => resolveDrawing?.();
  exportEl.addEventListener('ended', onEnded);
  try {
    // Confirm the starting frame before the recorder begins consuming the
    // canvas. The same rule applies to the WebCodecs path above.
    video.el.muted = true;
    await seekTo(exportEl, 0, { requireFrameCallback: true });
    video.el.muted = !hasAudio;
    recorder.start();
    recorderStarted = true;

    await new Promise<void>((resolve, reject) => {
      resolveDrawing = resolve;
      rejectDrawing = reject;
      const draw = (_now: number, meta: { mediaTime: number }) => {
        frameCallback = null;
        if (visibilityError) {
          reject(visibilityError);
          return;
        }
        const t = meta.mediaTime;
        ctx.drawImage(video.el, 0, 0, width, height);
        drawn = true;
        paintRedactions(ctx, activeBoxes(findings, t, video.width, video.height), width, height);
        report({
          phase: 'video',
          done: Math.round(t * fps),
          total: Math.round(video.duration * fps),
          note: 'Recording redacted playback',
        });
        if (video.el.ended) {
          resolve();
          return;
        }
        try {
          frameCallback = exportEl.requestVideoFrameCallback!(draw);
        } catch (err) {
          reject(err);
        }
      };
      try {
        frameCallback = exportEl.requestVideoFrameCallback!(draw);
        void video.el.play().catch(reject);
      } catch (err) {
        reject(err);
      }
    });
    if (visibilityError) throw visibilityError;
    if (!drawn) throw new Error('Export failed before a video frame was presented, so nothing was saved.');
  } finally {
    resolveDrawing = null;
    rejectDrawing = null;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    exportEl.removeEventListener('ended', onEnded);
    if (frameCallback !== null && exportEl.cancelVideoFrameCallback) {
      exportEl.cancelVideoFrameCallback(frameCallback);
    }
    frameCallback = null;
    if (recorderStarted && recorder.state !== 'inactive') recorder.stop();
    if (recorderStarted) await finished;
    await audioCtx?.close().catch(() => {});
  }

  const blob = new Blob(chunks, { type: mime ?? 'video/webm' });
  report({ phase: 'done', done: 1, total: 1 });

  return {
    blob,
    filename: `${safeName(video.file.name)}.webm`,
    format: 'webm',
    width,
    height,
    fps,
    hasAudio,
    elapsedMs: performance.now() - started,
  };
}
