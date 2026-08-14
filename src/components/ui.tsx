import type { Severity } from '../lib/types';

export const SEV_COLOR: Record<Severity, string> = {
  critical: 'var(--critical)',
  high: 'var(--high)',
  medium: 'var(--medium)',
  low: 'var(--low)',
};

export const SEV_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** `1:04` — for durations and axis labels, where tenths are noise. */
export function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/** `1:04.3` — for anything a reviewer might scrub to. Sample interval is
 *  0.5s, so tenths are the honest resolution to show. */
export function fmtTimecode(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

export function fmtRange(start: number, end: number): string {
  const a = fmtTimecode(start);
  const b = fmtTimecode(end);
  return a === b ? a : `${a}–${b}`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Shield({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.6 4.5 5.8v6c0 4.6 3.2 8.4 7.5 9.6 4.3-1.2 7.5-5 7.5-9.6v-6L12 2.6Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M8.6 12.1h6.8M8.6 15h4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.4" y="2.4" width="3.4" height="11.2" rx="0.6" />
      <rect x="9.2" y="2.4" width="3.4" height="11.2" rx="0.6" />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 2.6v10.8c0 .8.9 1.3 1.6.9l8.4-5.4c.6-.4.6-1.3 0-1.7L5.6 1.7C4.9 1.3 4 1.8 4 2.6Z" />
    </svg>
  );
}

export function SoundIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M8.5 2.8 5 5.6H2.5v4.8H5l3.5 2.8V2.8Z" strokeLinejoin="round" />
      {muted ? (
        <path d="M11 6l3.2 4M14.2 6 11 10" strokeLinecap="round" />
      ) : (
        <path d="M11 5.6a3.4 3.4 0 0 1 0 4.8M12.9 3.6a6 6 0 0 1 0 8.8" strokeLinecap="round" />
      )}
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2.8" y="5" width="18.4" height="14" rx="1.6" />
      <path d="M10 9.6v4.8l4.2-2.4L10 9.6Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <path d="M2.5 6.3 4.8 8.6 9.5 3.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M4.5 2.5 8 6l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2.5 6h7M6.6 3l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Spinner() {
  return (
    <svg className="spin" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.2 8A6.2 6.2 0 0 0 8 1.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
