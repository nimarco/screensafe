import { yieldToLoop } from '../util/yieldToLoop';

export interface LoadedVideo {
  el: HTMLVideoElement;
  url: string;
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  file: File;
}

export interface SeekOptions {
  /**
   * Require a requestVideoFrameCallback confirmation for the requested frame.
   * This is intentionally opt-in: scans still use the hidden-tab-friendly
   * fallback, while security-sensitive exports fail closed without proof.
   */
  requireFrameCallback?: boolean;
  /** Maximum time to wait for a matching presented frame. */
  frameTimeoutMs?: number;
  /** Cancel a pending seek when the owning scan/export is cancelled. */
  signal?: AbortSignal;
}

// A sought timestamp may fall between source frames, or a source may begin a
// few milliseconds after zero. Keep the acceptance window to roughly one or
// two 30fps frames; anything farther away is evidence that the compositor is
// still showing another part of the recording.
const SEEK_FRAME_TOLERANCE_S = 0.05;

/** Some containers (notably MediaRecorder WebM) report Infinity until seeked. */
async function resolveDuration(el: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(el.duration) && el.duration > 0) return el.duration;
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let guard = 0;
    const cleanup = () => {
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('error', onError);
      window.clearTimeout(guard);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onSeeked = () => {
      const d = Number.isFinite(el.duration) ? el.duration : el.currentTime;
      if (!Number.isFinite(d) || d <= 0) {
        fail(new Error('This file has no usable duration.'));
        return;
      }
      settled = true;
      cleanup();
      try {
        el.currentTime = 0;
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve(d);
    };
    const onError = () => fail(new Error("This file couldn't be decoded while reading its duration."));
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('error', onError);
    guard = window.setTimeout(
      () => fail(new Error('The video duration could not be determined. Try re-encoding the file and try again.')),
      5000,
    );
    try {
      el.currentTime = 1e6;
    } catch (err) {
      fail(err);
    }
  });
}

function probeAudio(el: HTMLVideoElement): boolean {
  const anyEl = el as HTMLVideoElement & {
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length: number };
  };
  if (typeof anyEl.mozHasAudio === 'boolean') return anyEl.mozHasAudio;
  if (anyEl.audioTracks) return anyEl.audioTracks.length > 0;
  if (typeof anyEl.webkitAudioDecodedByteCount === 'number') return anyEl.webkitAudioDecodedByteCount > 0;
  return true; // assume audio; the exporter degrades gracefully if there is none
}

export async function loadVideo(file: File): Promise<LoadedVideo> {
  const url = URL.createObjectURL(file);
  const el = document.createElement('video');
  el.preload = 'auto';
  el.muted = true;
  el.playsInline = true;
  el.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const onMeta = () => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('error', onErr);
        resolve();
      };
      const onErr = () => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('error', onErr);
        reject(new Error("This file couldn't be decoded. Try an MP4, WebM or MOV."));
      };
      el.addEventListener('loadedmetadata', onMeta);
      el.addEventListener('error', onErr);
    });

    const duration = await resolveDuration(el);
    if (!el.videoWidth || !el.videoHeight) {
      throw new Error('This file has no video track.');
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('This file has no usable duration.');
    }

    return {
      el,
      url,
      width: el.videoWidth,
      height: el.videoHeight,
      duration,
      hasAudio: probeAudio(el),
      file,
    };
  } catch (err) {
    // The caller only receives a LoadedVideo after this point, so it cannot
    // otherwise know which object URL must be released on a failed load.
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * Seek and wait until the frame at `t` is actually painted.
 *
 * Seeking (rather than playing) is what makes a scan deterministic: the same
 * video always yields the same sample times, and we never depend on wall-clock
 * playback speed.
 */
export function seekTo(el: HTMLVideoElement, t: number, opts: SeekOptions = {}): Promise<void> {
  const target = Math.max(0, t);
  const requireFrameCallback = opts.requireFrameCallback === true;
  const { signal } = opts;
  const anyEl = el as HTMLVideoElement & {
    requestVideoFrameCallback?: (
      cb: (now: number, metadata: { mediaTime?: number }) => void,
    ) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  const hasFrameCallback = typeof anyEl.requestVideoFrameCallback === 'function';

  if (requireFrameCallback && !hasFrameCallback) {
    return Promise.reject(new Error('Frame-accurate export is unavailable because this browser cannot confirm video frames.'));
  }
  if (requireFrameCallback && document.visibilityState !== 'visible') {
    return Promise.reject(new Error('Export stopped because the document is hidden. Keep this tab visible and try again.'));
  }
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Export cancelled', 'AbortError'));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let waitingForFrame = false;
    let frameCallback: number | null = null;
    let frameGuard = 0;
    let seekGuard = 0;
    const wasPaused = el.paused;
    let startedPresentation = false;

    const cleanup = () => {
      el.removeEventListener('seeked', onSeeked);
      if (requireFrameCallback) document.removeEventListener('visibilitychange', onVisibilityChange);
      signal?.removeEventListener('abort', onAbort);
      window.clearTimeout(seekGuard);
      window.clearTimeout(frameGuard);
      if (frameCallback !== null && anyEl.cancelVideoFrameCallback) {
        anyEl.cancelVideoFrameCallback(frameCallback);
      }
      frameCallback = null;
      if (startedPresentation && wasPaused) el.pause();
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        fail(new Error('Export stopped because the document became hidden. Keep this tab visible and try again.'));
      }
    };
    const onAbort = () => fail(new DOMException('Export cancelled', 'AbortError'));

    const waitForPresentedFrame = () => {
      if (settled) return;

      // `seeked` is not enough for a destructive export: it reports the media
      // position, but under decoder load the compositor can still be showing a
      // previously decoded frame. A visible rVFC callback is the point at
      // which the browser has actually presented a frame we can draw.
      // Scanning deliberately keeps the old short hidden/detached fallback:
      // its element is not mounted during the scan, so waiting 1.5 seconds for
      // a presentation callback would turn 2fps sampling into a minute-long
      // operation. Only strict export seeks require the callback.
      const useFrameCallback = hasFrameCallback && (requireFrameCallback || document.visibilityState === 'visible');
      if (!useFrameCallback) {
        if (requireFrameCallback) {
          fail(new Error('Frame-accurate export is unavailable because no presented-frame callback fired.'));
        } else {
          void yieldToLoop().then(finish, fail);
        }
        return;
      }

      if (requireFrameCallback && document.visibilityState !== 'visible') {
        fail(new Error('Export stopped because the document is hidden. Keep this tab visible and try again.'));
        return;
      }

      const timeout = requireFrameCallback ? (opts.frameTimeoutMs ?? 1500) : 120;
      frameGuard = window.setTimeout(() => {
        if (requireFrameCallback) {
          fail(new Error(`The decoder did not present the requested frame at ${target.toFixed(3)}s.`));
        } else {
          finish();
        }
      }, timeout);

      const onFrame = (_now: number, metadata: { mediaTime?: number }) => {
        frameCallback = null;
        if (settled) return;

        if (requireFrameCallback) {
          const mediaTime = Number(metadata?.mediaTime);
          // A seek may land on the adjacent source frame, especially for
          // variable-rate video. Keep the window tight so a frame from a
          // different moment cannot be composited with the requested boxes.
          if (!Number.isFinite(mediaTime) || Math.abs(mediaTime - target) > SEEK_FRAME_TOLERANCE_S) {
            try {
              frameCallback = anyEl.requestVideoFrameCallback!(onFrame);
            } catch (err) {
              fail(err);
            }
            return;
          }
        }

        window.clearTimeout(frameGuard);
        finish();
      };

      try {
        frameCallback = anyEl.requestVideoFrameCallback!(onFrame);
      } catch (err) {
        fail(err);
        return;
      }

      // Some engines do not present a newly sought frame while the element is
      // paused. Start muted playback long enough to make rVFC fire, then
      // cleanup() restores the paused state before the caller draws the frame.
      if (requireFrameCallback && wasPaused && el.paused) {
        startedPresentation = true;
        void el.play().catch(fail);
      }
    };

    const markSeeked = () => {
      if (settled || waitingForFrame) return;
      waitingForFrame = true;
      el.removeEventListener('seeked', onSeeked);
      window.clearTimeout(seekGuard);
      waitForPresentedFrame();
    };
    const onSeeked = () => markSeeked();

    el.addEventListener('seeked', onSeeked);
    if (requireFrameCallback) document.addEventListener('visibilitychange', onVisibilityChange);
    signal?.addEventListener('abort', onAbort, { once: true });
    // Guard against browsers that swallow `seeked` at the very end of a file.
    seekGuard = window.setTimeout(markSeeked, 1500);

    if (Math.abs(el.currentTime - target) < 1e-4 && el.readyState >= 2) {
      markSeeked();
    } else {
      try {
        el.currentTime = target;
      } catch (err) {
        fail(err);
      }
    }
  });
}

export interface FrameGrabber {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  width: number;
  height: number;
  grab(el: HTMLVideoElement): void;
  toImageData(): ImageData;
}

export function createGrabber(width: number, height: number): FrameGrabber {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = (canvas as HTMLCanvasElement).getContext('2d', {
    willReadFrequently: true,
    alpha: false,
  }) as CanvasRenderingContext2D;
  return {
    canvas,
    ctx,
    width,
    height,
    grab(el) {
      ctx.drawImage(el, 0, 0, width, height);
    },
    toImageData() {
      return ctx.getImageData(0, 0, width, height);
    },
  };
}

/**
 * How much to upscale a frame before OCR.
 *
 * Two forces pull against each other. Tesseract wants ~30px cap height and
 * screen recordings sit near 14px, which argues for upscaling. But OCR cost
 * scales with total pixels, and a 2x upscale of 720p is a 3.7MP image that
 * takes seconds per frame. So we take the gentler of "enough height" and "fits
 * the pixel budget", which lands ~1.5x for 720p and 1x for 1080p.
 */
const OCR_PIXEL_BUDGET = 2.0e6;

export function ocrScaleFor(width: number, height: number): number {
  const byHeight = 1600 / height;
  const byBudget = Math.sqrt(OCR_PIXEL_BUDGET / (width * height));
  return Math.min(2, Math.max(1, Math.min(byHeight, byBudget)));
}
