import { useEffect, useMemo, useRef, useState } from 'react';
import type { Finding } from '../lib/types';
import type { LoadedVideo } from '../lib/video/frames';
import { activeBoxes, paintOutlines, paintRedactions } from '../lib/video/redact';
import { fmtBytes, fmtTime, fmtTimecode, PlayIcon, SEV_COLOR, SoundIcon } from './ui';

interface Props {
  video: LoadedVideo;
  findings: Finding[];
  activeId: string | null;
  onSelect: (id: string) => void;
  seekToken: { t: number; n: number } | null;
  /** True while an export owns the video element. */
  frozen?: boolean;
}

/** Pick a ruler interval that lands on a round number and leaves ≤9 labels. */
function tickStep(duration: number): number {
  return [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => duration / s <= 9) ?? 600;
}

export function Stage({ video, findings, activeId, onSelect, seekToken, frozen = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [t, setT] = useState(0);
  const [activeCount, setActiveCount] = useState(0);

  // Keep the (detached) media element mounted so playback and audio behave.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    holder.appendChild(video.el);
    video.el.muted = true;
    return () => {
      video.el.pause();
      if (video.el.parentElement === holder) holder.removeChild(video.el);
    };
  }, [video]);

  useEffect(() => {
    video.el.muted = muted;
  }, [muted, video]);

  // External seek requests (clicking a finding).
  useEffect(() => {
    if (!seekToken) return;
    video.el.currentTime = Math.max(0, Math.min(video.duration - 0.05, seekToken.t));
    setT(video.el.currentTime);
  }, [seekToken, video]);

  // One continuous paint loop: always correct regardless of play state,
  // toggles, or seeks. This is exactly the compositing the exporter does.
  //
  // It stops for the duration of an export, which owns the same element and
  // seeks it frame by frame; a 60fps preview reading that element in between
  // is contention for no benefit, since the frame shown is the exporter's
  // position rather than the user's. (This alone does not fix the stale-frame
  // export leak — measured byte-identical output with and without it.)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frozen) return;
    canvas.width = video.width;
    canvas.height = video.height;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    let raf = 0;

    const draw = () => {
      const el = video.el;
      const now = el.currentTime;
      if (el.readyState >= 2) {
        ctx.drawImage(el, 0, 0, video.width, video.height);
        const boxes = activeBoxes(findings, now, video.width, video.height);
        paintRedactions(ctx, boxes, video.width, video.height);
        const sel = findings.find((f) => f.id === activeId);
        if (sel) {
          const selBoxes = activeBoxes([{ ...sel, redact: true }], now, video.width, video.height);
          paintOutlines(ctx, selBoxes, SEV_COLOR[sel.severity]);
        }
        setActiveCount(boxes.length);
      }
      setT(now);
      setPlaying(!el.paused && !el.ended);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [video, findings, activeId, frozen]);

  const ticks = useMemo(() => {
    const step = tickStep(video.duration);
    const out: number[] = [];
    for (let s = 0; s <= video.duration; s += step) out.push(s);
    return out;
  }, [video.duration]);

  const toggle = () => {
    if (video.el.paused) void video.el.play();
    else video.el.pause();
  };

  const scrub = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    video.el.currentTime = frac * video.duration;
  };

  const redacted = findings.filter((f) => f.redact).length;

  return (
    <div className="stage">
      <div className="video-frame">
        <canvas ref={canvasRef} />
        <div ref={holderRef} className="source-holder" />
        <span className="overlay-state">
          <i style={{ background: activeCount > 0 ? 'var(--critical)' : 'var(--ok)' }} />
          {activeCount > 0 ? `${activeCount} redaction${activeCount === 1 ? '' : 's'} on frame` : 'frame clear'}
        </span>
      </div>

      <div className="transport">
        <button type="button" className="icon-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
          <PlayIcon playing={playing} />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setMuted((m) => !m)}
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          <SoundIcon muted={muted} />
        </button>
        <span className="time">
          <b>{fmtTimecode(t)}</b> / {fmtTimecode(video.duration)}
        </span>

        <div className="timeline" onClick={scrub}>
          <div className="timeline-track">
            <div className="timeline-played" style={{ width: `${(t / video.duration) * 100}%` }} />
          </div>
          {findings.map((f) => {
            const left = (f.start / video.duration) * 100;
            const width = Math.max(0.4, ((f.end - f.start) / video.duration) * 100);
            return (
              <button
                type="button"
                key={f.id}
                className={`marker${f.id === activeId ? ' active' : ''}${f.redact ? '' : ' allowed'}`}
                style={{ left: `${left}%`, width: `${width}%`, background: SEV_COLOR[f.severity] }}
                title={`${f.label} · ${fmtTimecode(f.start)}`}
                aria-label={`${f.label} at ${fmtTimecode(f.start)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(f.id);
                }}
              />
            );
          })}
          <div className="playhead" style={{ left: `${(t / video.duration) * 100}%` }} />
          <div className="ruler">
            {ticks.map((s) => {
              const pos = s / video.duration;
              // Labels near the end flip to the left of their tick so the
              // ruler's last mark isn't clipped on a narrow column.
              return (
                <span className={`tick${pos > 0.85 ? ' tick-end' : ''}`} key={s} style={{ left: `${pos * 100}%` }}>
                  <span>{fmtTime(s)}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <div className="stage-meta">
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
        <span>{video.hasAudio ? 'audio' : 'no audio'}</span>
        <span>
          <b>
            {redacted}/{findings.length}
          </b>{' '}
          composited — preview is the export
        </span>
      </div>
    </div>
  );
}
