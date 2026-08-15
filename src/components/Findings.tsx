import { DETECTORS_BY_ID } from '../lib/detectors/catalog';
import type { ScanStats } from '../lib/scan';
import { CATEGORIES, type Finding, type Severity } from '../lib/types';
import type { ExportProgress, ExportResult } from '../lib/video/exportVideo';
import { MOSAIC_MAX_CELLS, MOSAIC_MIN_CELLS } from '../lib/video/redact';
import { ArrowIcon, fmtBytes, fmtRange, fmtTimecode, SEV_COLOR, SEV_LABEL, Spinner } from './ui';

interface Props {
  findings: Finding[];
  stats: ScanStats | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string, redact: boolean) => void;
  onBulk: (redact: boolean) => void;
  onExport: () => void;
  onReset: () => void;
  exporting: ExportProgress | null;
  result: ExportResult | null;
  exportedFrames: number | null;
  onDownload: () => void;
  mosaicCells: number;
  onMosaicCells: (cells: number) => void;
}

/*
 * Measured on a real face (tools/mosaic-probe.html), by re-running the face
 * detector on the redacted pixels — a redaction that its own detector can still
 * read is not a redaction:
 *
 *   50 blocks (the old fixed rule)  re-identified at 0.89
 *   15 blocks                       re-identified at 0.81
 *   13 blocks and below             no face found in the output
 *    6 blocks                       no facial structure left to a human eye
 *
 * The top of the slider is therefore known-bad for faces and says so, rather
 * than being quietly removed: it is legitimate for a recording whose findings
 * are all text, where keeping the shape of what was covered is useful.
 */
const MOSAIC_STRENGTH_LABEL = (cells: number): string =>
  cells <= 4
    ? 'maximum'
    : cells <= 6
      ? 'defeats face detection'
      : cells <= 8
        ? 'strong'
        : cells <= 13
          ? 'weak — a face may still read'
          : 'text only — a face stays recoverable';

const HINTS: Record<string, string> = {
  face: 'A recognisable face.',
  qr: 'QR codes can carry wifi credentials, payment links or 2FA enrolment.',
};

const SOURCE_LABEL: Record<Finding['source'], string> = {
  ocr: 'ocr',
  face: 'blazeface',
  qr: 'jsqr',
};

export function Findings({
  findings,
  stats,
  activeId,
  onSelect,
  onToggle,
  onBulk,
  onExport,
  onReset,
  exporting,
  result,
  exportedFrames,
  onDownload,
  mosaicCells,
  onMosaicCells,
}: Props) {
  const redacted = findings.filter((f) => f.redact);
  const counts = findings.reduce<Record<Severity, number>>(
    (acc, f) => {
      acc[f.severity]++;
      return acc;
    },
    { critical: 0, high: 0, medium: 0, low: 0 },
  );

  const groups = CATEGORIES.map((c) => ({
    meta: c,
    items: findings.filter((f) => f.category === c.id),
  })).filter((g) => g.items.length > 0);

  const exportPct = exporting ? Math.round((exporting.done / Math.max(1, exporting.total)) * 100) : 0;
  const encodeFps =
    result && exportedFrames && result.elapsedMs > 0
      ? Math.round(exportedFrames / (result.elapsedMs / 1000))
      : null;

  return (
    <aside className="panel">
      <div className="panel-head">
        <div className="panel-title">
          <h2>Findings</h2>
          <span className="count">{findings.length}</span>
        </div>
        <p>
          {findings.length === 0
            ? 'The scan finished without a match.'
            : 'Blurred by default. Allow through only what you meant to show.'}
        </p>
        {findings.length > 0 && (
          <div className="tally">
            {(Object.keys(counts) as Severity[])
              .filter((s) => counts[s] > 0)
              .map((s) => (
                <span key={s}>
                  <i style={{ background: SEV_COLOR[s] }} />
                  {counts[s]} {SEV_LABEL[s].toLowerCase()}
                </span>
              ))}
          </div>
        )}
      </div>

      {findings.length > 0 && (
        <div className="toolbar">
          <button type="button" className="link-btn" onClick={() => onBulk(true)}>
            Blur all
          </button>
          <button type="button" className="link-btn" onClick={() => onBulk(false)}>
            Allow all
          </button>
          <span className="state">
            {redacted.length}/{findings.length} blurred
          </span>
        </div>
      )}

      <div className="findings">
        {findings.length === 0 && (
          <div className="empty">
            <b>No exposures detected</b>
            <p>Export anyway for a clean re-encode, or scan another recording.</p>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.meta.id}>
            <div className="group-head">
              {g.meta.label}
              <b>{g.items.length}</b>
            </div>
            {g.items.map((f) => {
              const hint = DETECTORS_BY_ID.get(f.detectorId)?.hint ?? HINTS[f.detectorId] ?? '';
              const active = f.id === activeId;
              return (
                <div
                  key={f.id}
                  className={`row${active ? ' active' : ''}${f.redact ? '' : ' allowed'}`}
                  onClick={() => onSelect(f.id)}
                >
                  <button type="button" className="row-open" onClick={() => onSelect(f.id)}>
                    <span className="row-line">
                      <span className="row-time">{fmtRange(f.start, f.end)}</span>
                      <span className="row-det">{f.detectorId}</span>
                    </span>

                    <span className="row-label">
                      {f.label}{' '}
                      <span className="sev" style={{ color: SEV_COLOR[f.severity] }}>
                        {SEV_LABEL[f.severity]}
                      </span>
                    </span>

                    {f.source !== 'face' && <code className="row-value">{f.masked}</code>}

                    <span className="row-meta">
                      {SOURCE_LABEL[f.source]} · {Math.round(f.confidence * 100)}% conf ·{' '}
                      {f.occurrences.length} frame{f.occurrences.length === 1 ? '' : 's'}
                    </span>

                    {active && hint && <span className="row-hint">{hint}</span>}
                  </button>

                  <div className="row-act" onClick={(e) => e.stopPropagation()}>
                    <div className="seg">
                      <button
                        type="button"
                        className={f.redact ? 'on blur-on' : ''}
                        onClick={() => onToggle(f.id, true)}
                      >
                        Blur
                      </button>
                      <button
                        type="button"
                        className={f.redact ? '' : 'on'}
                        onClick={() => onToggle(f.id, false)}
                      >
                        Allow
                      </button>
                    </div>
                    <button type="button" className="row-jump" onClick={() => onSelect(f.id)}>
                      {fmtTimecode(f.start)} <ArrowIcon />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="panel-foot">
        {result ? (
          <>
            <div className="result-head">Export complete</div>
            <div className="result-kv">
              <div className="kv">
                <span>File</span>
                <b>{result.filename}</b>
              </div>
              <div className="kv">
                <span>Container</span>
                <b>
                  {result.format.toUpperCase()} · {result.videoCodec}
                  {result.audioCodec ? ` + ${result.audioCodec}` : ' · no audio'}
                </b>
              </div>
              <div className="kv">
                <span>Frame</span>
                <b>
                  {result.width}×{result.height} @ {result.fps}fps
                </b>
              </div>
              <div className="kv">
                <span>Size</span>
                <b>{fmtBytes(result.blob.size)}</b>
              </div>
              <div className="kv">
                <span>Encoded</span>
                <b>
                  {(result.elapsedMs / 1000).toFixed(1)}s
                  {exportedFrames ? ` · ${exportedFrames} frames` : ''}
                  {encodeFps ? ` · ${encodeFps} fps` : ''}
                </b>
              </div>
              <div className="kv">
                <span>Redactions</span>
                <b>{redacted.length} burned in</b>
              </div>
            </div>
            <button type="button" className="primary" onClick={onDownload}>
              Download {result.format.toUpperCase()}
            </button>
            <button type="button" className="btn block" onClick={onReset}>
              Scan another recording
            </button>
          </>
        ) : exporting ? (
          <>
            <div className="bar" style={{ marginBottom: 10 }}>
              <i style={{ transform: `scaleX(${exportPct / 100})` }} />
            </div>
            <button type="button" className="primary" disabled>
              <Spinner /> {exporting.note ?? 'Encoding'} · {exportPct}%
            </button>
            <p className="foot-note mono">
              re-encoding {exporting.total} frames with redactions composited in — on this machine
            </p>
          </>
        ) : (
          <>
            <label className="mosaic-control">
              <span className="mosaic-head">
                Redaction strength
                <b className={mosaicCells >= 14 ? 'unsafe' : mosaicCells >= 9 ? 'weak' : undefined}>
                  {MOSAIC_STRENGTH_LABEL(mosaicCells)}
                </b>
              </span>
              <input
                type="range"
                min={MOSAIC_MIN_CELLS}
                max={MOSAIC_MAX_CELLS}
                step={1}
                // Reversed, so dragging right destroys more: the slider reads
                // as strength, while the value underneath is cells kept.
                value={MOSAIC_MIN_CELLS + MOSAIC_MAX_CELLS - mosaicCells}
                onChange={(e) => onMosaicCells(MOSAIC_MIN_CELLS + MOSAIC_MAX_CELLS - Number(e.target.value))}
                aria-label="Redaction strength"
              />
              <span className="mosaic-note mono">
                {mosaicCells} blocks across · applies to the preview and the export
              </span>
            </label>
            <button type="button" className="primary" onClick={onExport}>
              Export video
            </button>
            <p className="foot-note mono">
              {redacted.length} of {findings.length} findings burned in · destructive mosaic, not a blur
            </p>
            {stats && (
              <p className="foot-note mono">
                scan {(stats.elapsedMs / 1000).toFixed(1)}s · {stats.sampled} sampled · {stats.analyzed} read ·{' '}
                {stats.skipped} skipped · {stats.ocrWorkers} workers
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
