import { useEffect, useRef, useState } from 'react';
import type { ScanProgress } from '../lib/scan';
import type { LoadedVideo } from '../lib/video/frames';
import { fmtBytes, fmtTimecode } from './ui';

interface Props {
  video: LoadedVideo | null;
  p: ScanProgress | null;
  onCancel: () => void;
}

export function Scanning({ video, p, onCancel }: Props) {
  const started = useRef(performance.now());
  const [elapsed, setElapsed] = useState(0);

  // A live elapsed readout is the only thing on this screen that has to move.
  useEffect(() => {
    const id = setInterval(() => setElapsed((performance.now() - started.current) / 1000), 100);
    return () => clearInterval(id);
  }, []);

  const modelPhase = !p || p.phase === 'models';
  const pct = p && p.duration > 0 && !modelPhase ? Math.min(100, (p.t / p.duration) * 100) : 0;
  const skipRate = p && p.sampled > 0 ? Math.round((p.skipped / p.sampled) * 100) : 0;
  const readRate = p && elapsed > 0.4 ? p.analyzed / elapsed : 0;
  const modelLabel = p?.note?.toLowerCase().includes('face')
    ? 'Loading face model'
    : p?.note?.toLowerCase().includes('ocr')
      ? 'Loading OCR engine'
      : 'Loading detection models';

  return (
    <div className="scanning">
      {video && (
        <div className="run-file">
          <span>
            <b>{video.file.name}</b>
          </span>
          <span>
            <b>
              {video.width}×{video.height}
            </b>
          </span>
          <span>
            <b>{video.duration.toFixed(1)}s</b>
          </span>
          <span>
            <b>{fmtBytes(video.file.size)}</b>
          </span>
          <span>sampling at 2 fps</span>
        </div>
      )}

      <div className="run-head">
        <h2>{modelPhase ? modelLabel : 'Scanning'}</h2>
        <span className="run-pct">{modelPhase ? '—' : `${pct.toFixed(0)}%`}</span>
      </div>

      <div className={`bar${modelPhase ? ' indeterminate' : ''}`}>
        <i style={{ transform: `scaleX(${pct / 100})` }} />
      </div>

      <p className="run-note">
        {modelPhase
          ? (p?.note ?? 'local detection models')
          : p?.ocr === false
            ? `checking faces and QR codes at ${fmtTimecode(p.t)} of ${fmtTimecode(p.duration)}`
            : `reading frame text at ${fmtTimecode(p.t)} of ${fmtTimecode(p.duration)}`}
      </p>

      <div className="readout">
        <div className="kv">
          <span>Frames sampled</span>
          <b>{p?.sampled ?? 0}</b>
        </div>
        <div className="kv">
          <span>{p?.ocr === false ? 'Frames analyzed' : 'Frames read by OCR'}</span>
          <b>{p?.analyzed ?? 0}</b>
        </div>
        <div className="kv">
          <span>Skipped — no change</span>
          <b>
            {p?.skipped ?? 0}
            {skipRate > 0 ? ` · ${skipRate}%` : ''}
          </b>
        </div>
        <div className="kv">
          <span>Findings</span>
          <b className={p?.findings ? 'hit' : undefined}>{p?.findings ?? 0}</b>
        </div>
        <div className="kv">
          <span>Elapsed</span>
          <b>
            {elapsed.toFixed(1)}s{readRate > 0 ? ` · ${readRate.toFixed(1)} frames/s` : ''}
          </b>
        </div>
      </div>

      <div className="run-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel scan
        </button>
      </div>
    </div>
  );
}
