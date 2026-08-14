/** Levenshtein distance, abandoned once it exceeds `cap`. */
export function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = row;
  }
  return prev[b.length];
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Are two OCR reads plausibly the same secret?
 *
 * Used to collapse duplicate findings. Exact containment is too brittle: the
 * same key comes back as `sk_lLive_51Qj` from a half-drawn frame and
 * `sk_live_510Qjs...` once it settles, and a stray period turns `NoP.qRs` into
 * `NoP..qRs`. So we compare alphanumerics only, and forgive a few character
 * errors — but only when one read is clearly a *truncation* of the other.
 *
 * That last condition matters: two values of similar length that differ
 * (203.0.113.42 vs 203.0.113.99) are different secrets. Merging them would drop
 * one out of the review queue entirely, which is the one failure mode this tool
 * cannot have.
 */
export function sameSecret(a: string, b: string): boolean {
  const x = alnum(a);
  const y = alnum(b);
  if (x.length < 6 || y.length < 6) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.includes(short)) return true;
  if (short.length < 8 || short.length > long.length * 0.6) return false;
  const cap = Math.max(1, Math.ceil(short.length * 0.25));
  return editDistance(short, long.slice(0, short.length), cap) <= cap;
}
