/** Luhn checksum — the thing that separates a real card number from 16 digits. */
export function luhn(input: string): boolean {
  const digits = input.replace(/[^0-9]/g, '');
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Shannon entropy in bits per character. Random tokens sit well above 3. */
export function entropy(s: string): number {
  if (!s.length) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Values people type when they are deliberately *not* writing a secret.
 *
 * Shared rather than inlined because more than one rule has to agree on it: a
 * tutorial's `API_KEY=your_api_key_here` should be silent whether it is being
 * judged as a live credential or as a secret-named assignment, and two copies
 * of this list would eventually disagree.
 */
export function isPlaceholderValue(s: string): boolean {
  return /^(your|my|the|some|test|example|placeholder|changeme|hunter2|xxx+|todo|fixme|null|none|undefined)/i.test(s);
}

/**
 * Rejects strings that read like English/code identifiers rather than secrets.
 * Generic token rules lean on this so `API_KEY=your_api_key_here` in a tutorial
 * does not get flagged as a live credential.
 */
export function looksRandom(s: string, minEntropy = 3.0): boolean {
  if (s.length < 12) return false;
  if (entropy(s) < minEntropy) return false;
  if (isPlaceholderValue(s)) return false;
  if (/^[a-z]+(_[a-z]+)*$/.test(s)) return false; // snake_case words
  const hasDigit = /[0-9]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasLower = /[a-z]/.test(s);
  return (hasDigit && (hasUpper || hasLower)) || (hasUpper && hasLower);
}

/** True for RFC1918 / loopback / link-local space. */
export function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n > 255)) return false;
  if (p[0] === 10) return true;
  if (p[0] === 127) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 0 || p[0] >= 224) return true;
  return false;
}

export function isValidIPv4(ip: string): boolean {
  const p = ip.split('.');
  if (p.length !== 4) return false;
  return p.every((s) => {
    if (!/^\d{1,3}$/.test(s)) return false;
    const n = parseInt(s, 10);
    return n >= 0 && n <= 255;
  });
}

/**
 * Version numbers and timestamps look a lot like IPs and phone numbers to a
 * regex. Cheap guard used by the noisier numeric detectors.
 */
export function looksLikeVersionString(context: string, match: string): boolean {
  const i = context.indexOf(match);
  if (i < 0) return false;
  const before = context.slice(Math.max(0, i - 12), i).toLowerCase();
  return /\b(v|ver|version|node|python|release|build)\s*\.?\s*$/.test(before);
}
