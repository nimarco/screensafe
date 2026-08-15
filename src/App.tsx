import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Findings } from './components/Findings';
import { Landing } from './components/Landing';
import { Scanning } from './components/Scanning';
import { Stage } from './components/Stage';
import { fmtBytes, Shield } from './components/ui';
import { scanVideo, type ScanProgress, type ScanStats } from './lib/scan';
import type { CategoryId, Finding } from './lib/types';
import { exportRedacted, type ExportProgress, type ExportResult } from './lib/video/exportVideo';
import { loadVideo, type LoadedVideo } from './lib/video/frames';
import { DEFAULT_MOSAIC_CELLS } from './lib/video/redact';
import { assetUrl } from './lib/util/assetUrl';
import { disposeFaceDetector } from './lib/vision/faces';

type Phase = 'idle' | 'scanning' | 'review';

const DEFAULT_CATEGORIES: CategoryId[] = ['developer', 'personal', 'financial', 'network', 'visual'];

const STEPS = ['Scan', 'Review', 'Export'];

function Steps({ at }: { at: number }) {
  return (
    <nav className="steps" aria-label="Progress">
      {STEPS.map((label, i) => (
        <Fragment key={label}>
          {i > 0 && <span className="step-sep" />}
          <span
            className={`step${i === at ? ' on' : i < at ? ' done' : ''}`}
            aria-current={i === at ? 'step' : undefined}
          >
            <em>{i + 1}</em>
            {label}
          </span>
        </Fragment>
      ))}
    </nav>
  );
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [categories, setCategories] = useState<Set<CategoryId>>(new Set(DEFAULT_CATEGORIES));
  const [video, setVideo] = useState<LoadedVideo | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [stats, setStats] = useState<ScanStats | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [seekToken, setSeekToken] = useState<{ t: number; n: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [exportedFrames, setExportedFrames] = useState<number | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);
  const [mosaicCells, setMosaicCells] = useState(DEFAULT_MOSAIC_CELLS);
  const abortRef = useRef<AbortController | null>(null);
  const runSeq = useRef(0);
  const videoRef = useRef<LoadedVideo | null>(null);
  const resultUrlRef = useRef<string | null>(null);
  const framesRef = useRef(0);
  const seekSeq = useRef(0);

  useEffect(() => {
    videoRef.current = video;
  }, [video]);

  useEffect(() => {
    resultUrlRef.current = resultUrl;
  }, [resultUrl]);

  const toggleCategory = (id: CategoryId) =>
    setCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const reset = useCallback(() => {
    runSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const loaded = videoRef.current ?? video;
    if (loaded) URL.revokeObjectURL(loaded.url);
    const oldResultUrl = resultUrlRef.current ?? resultUrl;
    if (oldResultUrl) URL.revokeObjectURL(oldResultUrl);
    videoRef.current = null;
    resultUrlRef.current = null;
    disposeFaceDetector();
    setPhase('idle');
    setVideo(null);
    setFindings([]);
    setStats(null);
    setProgress(null);
    setActiveId(null);
    setResult(null);
    setResultUrl(null);
    setExportedFrames(null);
    setExporting(null);
    setError(null);
  }, [video, resultUrl]);

  const start = useCallback(
    async (file: File) => {
      if (categories.size === 0) {
        setError('Turn on at least one category in Scan scope before scanning.');
        return;
      }
      const runId = ++runSeq.current;
      abortRef.current?.abort();
      abortRef.current = null;
      const previousVideo = videoRef.current;
      if (previousVideo) URL.revokeObjectURL(previousVideo.url);
      const previousResultUrl = resultUrlRef.current;
      if (previousResultUrl) URL.revokeObjectURL(previousResultUrl);
      videoRef.current = null;
      resultUrlRef.current = null;
      setError(null);
      setVideo(null);
      setResult(null);
      setResultUrl(null);
      setExportedFrames(null);
      let loaded: LoadedVideo;
      try {
        loaded = await loadVideo(file);
      } catch (err) {
        if (runSeq.current !== runId) return;
        setError(err instanceof Error ? err.message : 'That file could not be opened.');
        return;
      }
      if (runSeq.current !== runId) {
        URL.revokeObjectURL(loaded.url);
        return;
      }
      videoRef.current = loaded;
      setVideo(loaded);
      setPhase('scanning');
      setProgress(null);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await scanVideo(loaded, {
          categories,
          sampleFps: 2,
          signal: ctrl.signal,
          onProgress: (p) => {
            if (runSeq.current === runId) setProgress(p);
          },
        });
        if (runSeq.current !== runId || ctrl.signal.aborted) return;
        setFindings(res.findings);
        setStats(res.stats);
        setActiveId(res.findings[0]?.id ?? null);
        setPhase('review');
      } catch (err) {
        if (runSeq.current !== runId) return;
        if (videoRef.current === loaded) {
          URL.revokeObjectURL(loaded.url);
          videoRef.current = null;
        }
        if ((err as DOMException)?.name === 'AbortError') {
          setPhase('idle');
          setVideo(null);
          return;
        }
        setError(err instanceof Error ? err.message : 'The scan failed.');
        setVideo(null);
        setPhase('idle');
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [categories],
  );

  const loadSample = useCallback(async () => {
    setLoadingSample(true);
    setError(null);
    try {
      const res = await fetch(assetUrl('sample/leaky-demo.mp4'));
      if (!res.ok) throw new Error('Sample recording is unavailable.');
      const blob = await res.blob();
      await start(new File([blob], 'leaky-demo.mp4', { type: 'video/mp4' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the sample.');
    } finally {
      setLoadingSample(false);
    }
  }, [start]);

  const select = (id: string) => {
    setActiveId(id);
    const f = findings.find((x) => x.id === id);
    if (f) setSeekToken({ t: f.start + 0.05, n: ++seekSeq.current });
  };

  const toggle = (id: string, redact: boolean) =>
    setFindings((prev) => prev.map((f) => (f.id === id ? { ...f, redact } : f)));

  const bulk = (redact: boolean) => setFindings((prev) => prev.map((f) => ({ ...f, redact })));

  const runExport = useCallback(async () => {
    if (!video) return;
    const runId = runSeq.current;
    setError(null);
    abortRef.current?.abort();
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
      setResultUrl(null);
    }
    setResult(null);
    framesRef.current = 0;
    setExporting({ phase: 'preparing', done: 0, total: 1 });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      video.el.pause();
      const res = await exportRedacted(video, findings, {
        fps: 30,
        mosaicCells,
        signal: ctrl.signal,
        onProgress: (p) => {
          // The final `total` is the real encoded frame count; keep it so the
          // result can report measured throughput rather than a guess.
          if (p.phase === 'video' || p.phase === 'finalizing') framesRef.current = p.total;
          if (runSeq.current === runId) setExporting(p);
        },
      });
      if (runSeq.current !== runId || ctrl.signal.aborted) return;
      setResult(res);
      setExportedFrames(framesRef.current || null);
      const url = URL.createObjectURL(res.blob);
      resultUrlRef.current = url;
      setResultUrl(url);
    } catch (err) {
      if (runSeq.current === runId && (err as DOMException)?.name !== 'AbortError') {
        setError(err instanceof Error ? err.message : 'Export failed.');
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      if (runSeq.current === runId) setExporting(null);
    }
  }, [video, findings, mosaicCells]);

  const download = () => {
    if (!result || !resultUrl) return;
    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = result.filename;
    a.click();
  };

  useEffect(
    () => () => {
      runSeq.current += 1;
      abortRef.current?.abort();
      const loaded = videoRef.current;
      if (loaded) URL.revokeObjectURL(loaded.url);
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
      disposeFaceDetector();
    },
    [],
  );

  const stepIndex = result ? 2 : phase === 'review' ? 1 : 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Shield />
          ScreenSafe
          <span className="brand-tag">— the privacy linter for video</span>
        </div>

        <Steps at={stepIndex} />

        <div className="topbar-right">
          <span className="net-state" title="No request leaves this tab while processing">
            <i />
            on-device
          </span>
          {phase !== 'idle' && (
            <button type="button" className="link-btn" onClick={reset}>
              Start over
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="error-bar" role="alert">
          <b>error</b>
          {error}
        </div>
      )}

      {phase === 'idle' && (
        <Landing
          categories={categories}
          onToggleCategory={toggleCategory}
          onFile={start}
          onSample={loadSample}
          loadingSample={loadingSample}
        />
      )}

      {phase === 'scanning' && (
        <Scanning
          video={video}
          p={progress}
          onCancel={() => {
            abortRef.current?.abort();
          }}
        />
      )}

      {phase === 'review' && video && (
        <main className="review">
          {resultUrl && result ? (
            <div className="stage">
              <div className="video-frame">
                <video className="result-video" src={resultUrl} controls autoPlay />
                <span className="overlay-state">
                  <i style={{ background: 'var(--ok)' }} />
                  exported file
                </span>
              </div>
              <div className="stage-meta">
                <span>
                  <b>{result.filename}</b>
                </span>
                <span>
                  <b>
                    {result.width}×{result.height}
                  </b>
                </span>
                <span>
                  <b>{fmtBytes(result.blob.size)}</b>
                </span>
                <span>decoded back from the exported bytes — scrub to confirm the redactions are in the pixels</span>
              </div>
            </div>
          ) : (
            <Stage
              video={video}
              findings={findings}
              activeId={activeId}
              onSelect={select}
              seekToken={seekToken}
              frozen={!!exporting}
              mosaicCells={mosaicCells}
            />
          )}
          <Findings
            findings={findings}
            stats={stats}
            activeId={activeId}
            onSelect={select}
            onToggle={toggle}
            onBulk={bulk}
            onExport={runExport}
            onReset={reset}
            exporting={exporting}
            result={result}
            exportedFrames={exportedFrames}
            onDownload={download}
            mosaicCells={mosaicCells}
            onMosaicCells={setMosaicCells}
          />
        </main>
      )}
    </div>
  );
}
