const MEDIAPIPE_METRICS_URL = 'https://odml.pa.googleapis.com/v1/log';

let releaseGuard: (() => void) | null = null;

/**
 * MediaPipe Tasks includes a performance-metrics uploader. ScreenSafe keeps
 * processing on-device, so block only that known endpoint while the detector
 * is alive; all app and model requests continue to use the normal fetch.
 */
export function blockMediaPipeMetrics(): () => void {
  if (releaseGuard) return releaseGuard;

  const originalFetch = globalThis.fetch;
  const guardedFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(MEDIAPIPE_METRICS_URL)) {
      return Promise.reject(new TypeError('ScreenSafe blocked MediaPipe metrics upload'));
    }
    return originalFetch.call(globalThis, input, init);
  }) as typeof fetch;

  globalThis.fetch = guardedFetch;

  const release = () => {
    if (releaseGuard !== release) return;
    if (globalThis.fetch === guardedFetch) globalThis.fetch = originalFetch;
    releaseGuard = null;
  };
  releaseGuard = release;
  return release;
}
