import type { Box, CategoryId, Severity } from '../types';
import { SEVERITY_RANK } from '../types';
import { DETECTORS, type DetectorDef } from './catalog';

export interface OcrWord {
  text: string;
  box: Box;
  confidence: number;
}

/** A line of OCR text with the char offset of each word inside `text`. */
export interface OcrLine {
  text: string;
  words: OcrWord[];
  /** wordStarts[i] is the offset of words[i] inside `text`. */
  wordStarts: number[];
}

export interface TextMatch {
  detectorId: string;
  label: string;
  category: CategoryId;
  severity: Severity;
  value: string;
  start: number;
  end: number;
}

export function buildLine(words: OcrWord[]): OcrLine {
  const parts: string[] = [];
  const starts: number[] = [];
  let offset = 0;
  for (const w of words) {
    starts.push(offset);
    parts.push(w.text);
    offset += w.text.length + 1; // words are joined by a single space
  }
  return { text: parts.join(' '), words, wordStarts: starts };
}

/**
 * OCR routinely reads `0` as `O`, `1` as `l` and `5` as `S` inside random
 * tokens. We scan a normalised copy so a single misread character doesn't hide
 * a live credential, then report offsets against the original (equal-length)
 * string. Only applied to runs that already look token-ish.
 */
function normaliseForMatching(text: string): string {
  return text.replace(/[A-Za-z0-9_\-.]{8,}/g, (run) => {
    if (!/[_\-]/.test(run) && !/\d/.test(run)) return run;
    return run.replace(/[Oo](?=[A-Za-z0-9]{3,})/g, '0').replace(/[l|](?=[A-Za-z0-9]{3,})/g, '1');
  });
}

/**
 * A view of a line with a map back to the original character offsets, so a
 * match found in a cleaned-up copy still boxes the right pixels.
 */
interface Variant {
  text: string;
  /** offsets[i] = index of variant char i in the original string. */
  offsets: number[] | null; // null = identity (same length, 1:1)
}

const GLUE = /[:/.@=_\-]/;

/**
 * Tesseract sprinkles spaces around punctuation: it reads
 * `postgres://admin:pw@db.prod.internal` as
 * `postgres: //admin: pw@db. prod. internal`. Every URL, connection string and
 * dotted token in the catalog dies on that. Removing spaces that sit against
 * URL/token punctuation repairs the whole class at once, and the offset map
 * keeps the redaction box aligned to the original pixels.
 */
function despace(text: string): Variant | null {
  let out = '';
  const offsets: number[] = [];
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') {
      let j = i;
      while (j < text.length && text[j] === ' ') j++;
      const prev = out[out.length - 1] ?? '';
      const next = text[j] ?? '';
      if (prev && next && (GLUE.test(prev) || GLUE.test(next))) {
        changed = true;
        i = j - 1;
        continue;
      }
    }
    out += text[i];
    offsets.push(i);
  }
  return changed ? { text: out, offsets } : null;
}

function runDetector(det: DetectorDef, variant: Variant, original: string): TextMatch[] {
  const out: TextMatch[] = [];
  const re = new RegExp(det.pattern.source, det.pattern.flags);
  const groupIdx = det.group ?? 0;
  const { text, offsets } = variant;
  for (const m of text.matchAll(re)) {
    const indices = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices;
    const span = indices?.[groupIdx];
    if (!span) continue;
    const [s, e] = span;
    if (e <= s) continue;
    const value = text.slice(s, e);
    if (det.validate && !det.validate(value, m[0], text)) continue;
    // Map back to original coordinates so boxes land on the right words.
    const start = offsets ? offsets[s] : s;
    const end = offsets ? offsets[Math.min(e - 1, offsets.length - 1)] + 1 : e;
    out.push({
      detectorId: det.id,
      label: det.label,
      category: det.category,
      severity: det.severity,
      value,
      start,
      end: Math.min(end, original.length),
    });
  }
  return out;
}

/**
 * Resolve overlapping matches: a connection string that contains a password
 * should surface once, as the connection string. Highest severity wins, then
 * the longest span.
 */
function resolveOverlaps(matches: TextMatch[]): TextMatch[] {
  const sorted = [...matches].sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    const len = b.end - b.start - (a.end - a.start);
    if (len !== 0) return len;
    return a.start - b.start;
  });
  const kept: TextMatch[] = [];
  for (const m of sorted) {
    const clashes = kept.some((k) => m.start < k.end && k.start < m.end);
    if (!clashes) kept.push(m);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function scanLine(text: string, enabledCategories: Set<CategoryId>): TextMatch[] {
  if (!text.trim()) return [];

  // Three views of the same line: as read, with confusable characters folded,
  // and with OCR's spurious punctuation spacing removed. Scanning all three
  // costs microseconds and each one catches leaks the others miss.
  const variants: Variant[] = [{ text, offsets: null }];
  const normalised = normaliseForMatching(text);
  if (normalised !== text) variants.push({ text: normalised, offsets: null });
  const despaced = despace(text);
  if (despaced) variants.push(despaced);

  const all: TextMatch[] = [];
  for (const det of DETECTORS) {
    if (!enabledCategories.has(det.category)) continue;
    for (const variant of variants) {
      for (const m of runDetector(det, variant, text)) {
        const dupe = all.some(
          (x) => x.detectorId === m.detectorId && x.start === m.start && x.value.length >= m.value.length,
        );
        if (!dupe) all.push(m);
      }
    }
  }
  return resolveOverlaps(all);
}

/**
 * OCR breaks long random tokens across "words" at arbitrary points — a JWT
 * comes back as `...eyJzdWIi0iIxMjMONSJ9.dBj ftJeZ4CVPmB92K27u`. The regex
 * matches up to the space, and the tail stays legible on screen next to a
 * redaction box, which is worse than not redacting at all.
 *
 * So once we know a span is a long secret, we widen the *coverage* over any
 * adjacent token-shaped fragments. This never changes what we report — only how
 * much of the frame we hide, which is the direction we want to be wrong in.
 */
const TOKEN_CHARS = /^[A-Za-z0-9_\-.=+/]+$/;

function tokenish(word: string): boolean {
  // A trailing quote or bracket is the delimiter around the secret, not part of
  // it — `ftJeZ4CVPmB92K27u"` is still the tail of a JWT. Strip the wrapping
  // before judging, or the fragment that most needs covering gets skipped.
  const core = word.replace(/^["'`([{<]+/, '').replace(/["'`)\]}>,;:]+$/, '');
  if (core.length < 4 || !TOKEN_CHARS.test(core)) return false;
  const hasDigit = /\d/.test(core);
  const mixedCase = /[a-z]/.test(core) && /[A-Z]/.test(core);
  return hasDigit || mixedCase;
}

export function extendOverFragments(line: OcrLine, start: number, end: number, minLen = 12): number {
  if (end - start < minLen) return end;
  let out = end;
  for (let i = 0; i < line.words.length; i++) {
    const ws = line.wordStarts[i];
    const we = ws + line.words[i].text.length;
    if (ws < out) continue; // already covered
    // Only jump a single space; anything wider is a different column.
    if (ws > out + 1) break;
    if (!tokenish(line.words[i].text)) break;
    out = we;
  }
  return out;
}

/** Union of the boxes of every word overlapping the char range [start, end). */
export function boxForRange(line: OcrLine, start: number, end: number): Box | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let hit = false;
  for (let i = 0; i < line.words.length; i++) {
    const ws = line.wordStarts[i];
    const we = ws + line.words[i].text.length;
    if (start < we && ws < end) {
      const b = line.words[i].box;
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
      hit = true;
    }
  }
  if (!hit) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
