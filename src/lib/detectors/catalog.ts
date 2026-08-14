import type { CategoryId, Severity } from '../types';
import { isPrivateIPv4, isValidIPv4, looksLikeVersionString, looksRandom, luhn } from './validators';

export interface DetectorDef {
  id: string;
  label: string;
  category: CategoryId;
  severity: Severity;
  /** Must carry the `g` and `d` flags — we read `match.indices` to place boxes. */
  pattern: RegExp;
  /** Capture group holding the sensitive substring. 0 = whole match. */
  group?: number;
  /** Second-stage check. `line` is the full OCR line for context. */
  validate?: (value: string, full: string, line: string) => boolean;
  mask?: (value: string) => string;
  hint: string;
}

/* ---------------------------------------------------------------- masking */

const DOT = '•';

function keepEnds(value: string, head: number, tail: number): string {
  if (value.length <= head + tail + 2) return DOT.repeat(Math.max(4, value.length));
  const hidden = Math.min(10, Math.max(4, value.length - head - tail));
  return value.slice(0, head) + DOT.repeat(hidden) + value.slice(value.length - tail);
}

/** Keeps a recognisable prefix (`sk_live_`) and the last few chars. */
function maskPrefixed(value: string): string {
  const m = value.match(/^([A-Za-z]{2,}[-_](?:live|test|proj|ant|pat)?[-_]?)/);
  const head = m ? m[1].length : 4;
  return keepEnds(value, Math.min(head, 12), 3);
}

function maskEmail(value: string): string {
  const [user, domain] = value.split('@');
  if (!domain) return keepEnds(value, 2, 2);
  const shown = user.slice(0, Math.min(2, user.length));
  return `${shown}${DOT.repeat(Math.max(3, user.length - 2))}@${domain}`;
}

function maskDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  const last = digits.slice(-2);
  return `${DOT.repeat(Math.max(4, digits.length - 2))}${last}`;
}

function maskCard(value: string): string {
  const d = value.replace(/\D/g, '');
  return `${d.slice(0, 4)} ${DOT.repeat(4)} ${DOT.repeat(4)} ${DOT.repeat(2)}${d.slice(-2)}`;
}

function maskUrl(value: string): string {
  // Keep the scheme + host shape, destroy the credentials inside it.
  return value.replace(/\/\/([^@/]+)@/, `//${DOT.repeat(8)}@`).slice(0, 48);
}

/* ------------------------------------------------------------- detectors */

export const DETECTORS: DetectorDef[] = [
  /* ------------------------------------------------ developer secrets */
  {
    id: 'stripe-secret',
    label: 'Stripe secret key',
    category: 'developer',
    severity: 'critical',
    pattern: /\b([sr]k_(?:live|test)_[A-Za-z0-9]{10,})/gd,
    mask: maskPrefixed,
    hint: 'Full API access to a Stripe account.',
  },
  {
    id: 'stripe-publishable',
    label: 'Stripe publishable key',
    category: 'developer',
    severity: 'low',
    pattern: /\b(pk_(?:live|test)_[A-Za-z0-9]{10,})/gd,
    mask: maskPrefixed,
    hint: 'Designed to be public — usually safe to show.',
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    category: 'developer',
    severity: 'critical',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/gd,
    mask: maskPrefixed,
    hint: 'Repository access, possibly write access.',
  },
  {
    id: 'aws-access-key',
    label: 'AWS access key ID',
    category: 'developer',
    severity: 'critical',
    pattern: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ABIA|ACCA)[A-Z0-9]{12,20})\b/gd,
    mask: (v) => keepEnds(v, 4, 4),
    hint: 'Half of an AWS credential pair.',
  },
  {
    id: 'aws-secret-key',
    label: 'AWS secret access key',
    category: 'developer',
    severity: 'critical',
    pattern: /aws[_-]?secret[_-]?access[_-]?key["'\s]*[:=]["'\s]*([A-Za-z0-9/+=]{32,45})/gid,
    group: 1,
    mask: (v) => keepEnds(v, 3, 3),
    hint: 'The other half of an AWS credential pair.',
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    category: 'developer',
    severity: 'critical',
    pattern: /\b(AIza[A-Za-z0-9_\-]{30,40})\b/gd,
    mask: (v) => keepEnds(v, 4, 4),
    hint: 'Billable Google Cloud / Maps / Firebase access.',
  },
  {
    id: 'openai-key',
    label: 'OpenAI API key',
    category: 'developer',
    severity: 'critical',
    pattern: /\b(sk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{20,})/gd,
    mask: maskPrefixed,
    hint: 'Billable model access.',
  },
  {
    id: 'anthropic-key',
    label: 'Anthropic API key',
    category: 'developer',
    severity: 'critical',
    pattern: /\b(sk-ant-[A-Za-z0-9_\-]{16,})/gd,
    mask: maskPrefixed,
    hint: 'Billable model access.',
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    category: 'developer',
    severity: 'critical',
    pattern: /\b(xox[baprse]-[A-Za-z0-9-]{10,})/gid,
    mask: maskPrefixed,
    hint: 'Workspace read/write access.',
  },
  {
    id: 'slack-webhook',
    label: 'Slack webhook URL',
    category: 'developer',
    severity: 'high',
    pattern: /(https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,})/gid,
    mask: (v) => v.slice(0, 34) + DOT.repeat(8),
    hint: 'Anyone with this URL can post to the channel.',
  },
  {
    id: 'sendgrid-key',
    label: 'SendGrid API key',
    category: 'developer',
    severity: 'critical',
    pattern: /\b(SG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,})/gd,
    mask: (v) => keepEnds(v, 3, 3),
    hint: 'Can send mail as your domain.',
  },
  {
    id: 'npm-token',
    label: 'npm access token',
    category: 'developer',
    severity: 'critical',
    pattern: /\b(npm_[A-Za-z0-9]{28,})/gd,
    mask: maskPrefixed,
    hint: 'Can publish packages under your account.',
  },
  {
    id: 'twilio-key',
    label: 'Twilio credential',
    category: 'developer',
    severity: 'high',
    pattern: /\b((?:SK|AC)[a-f0-9]{32})\b/gid,
    mask: (v) => keepEnds(v, 4, 3),
    hint: 'Telephony account access.',
  },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    category: 'developer',
    // A live JWT is a bearer credential: whoever reads it is logged in as you
    // until it expires. Ranked above the generic bearer rule so the review
    // queue names it precisely.
    severity: 'critical',
    pattern: /\b(eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{4,})/gd,
    mask: (v) => `eyJ${DOT.repeat(10)}.${DOT.repeat(6)}`,
    hint: 'A signed session or service token.',
  },
  {
    id: 'private-key-block',
    label: 'Private key block',
    category: 'developer',
    severity: 'critical',
    pattern: /(-{3,5}\s?BEGIN[ A-Z]{0,20}PRIVATE KEY\s?-{3,5})/gid,
    mask: () => '-----BEGIN PRIVATE KEY-----',
    hint: 'The start of a private key. Everything below it is sensitive.',
  },
  {
    id: 'ssh-public-key',
    label: 'SSH key',
    category: 'developer',
    severity: 'medium',
    pattern: /\b(ssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/]{20,})/gid,
    mask: (v) => v.slice(0, 12) + DOT.repeat(8),
    hint: 'Identifies a machine or user.',
  },
  {
    id: 'bearer-token',
    label: 'Bearer token',
    category: 'developer',
    severity: 'critical',
    pattern: /\bbearer\s+([A-Za-z0-9_\-.=+/]{16,})/gid,
    group: 1,
    validate: (v) => looksRandom(v, 2.6),
    mask: (v) => keepEnds(v, 4, 3),
    hint: 'An active authorization header.',
  },
  {
    id: 'password-assignment',
    label: 'Password',
    category: 'developer',
    severity: 'critical',
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"',;]{6,})/gid,
    group: 1,
    validate: (v) => !/^(your|the|a|example|placeholder|changeme|hunter2)$/i.test(v),
    mask: (v) => DOT.repeat(Math.min(12, v.length)),
    hint: 'A password in plain text.',
  },
  {
    id: 'labeled-secret',
    label: 'Secret value',
    category: 'developer',
    severity: 'critical',
    // KEY-ish name, then an assignment, then something that looks random.
    pattern:
      /\b([A-Za-z0-9_.\-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API[_-]KEY|PRIVATE[_-]KEY|ACCESS[_-]KEY|CLIENT[_-]SECRET|CREDENTIAL)[A-Za-z0-9_.\-]*)\s*[:=]\s*["']?([^\s"',;]{8,})/gid,
    group: 2,
    validate: (v) => looksRandom(v, 2.6) || v.length >= 20,
    mask: (v) => keepEnds(v, 3, 3),
    hint: 'A value assigned to a secret-looking name.',
  },

  /* ---------------------------------------------------- personal info */
  {
    id: 'email',
    label: 'Email address',
    category: 'personal',
    severity: 'medium',
    pattern: /\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/gd,
    validate: (v) => !/@(example|test|localhost)\.(com|org|net)$/i.test(v),
    mask: maskEmail,
    hint: 'Personal or work email address.',
  },
  {
    id: 'phone-us',
    label: 'Phone number',
    category: 'personal',
    severity: 'medium',
    pattern: /((?:\+?1[\s\-.])?(?:\(\d{3}\)\s?|\d{3}[\s\-.])\d{3}[\s\-.]\d{4})\b/gd,
    validate: (v, _f, line) => !looksLikeVersionString(line, v),
    mask: maskDigits,
    hint: 'Looks like a North American phone number.',
  },
  {
    id: 'phone-intl',
    label: 'Phone number',
    category: 'personal',
    severity: 'medium',
    pattern: /(\+(?!1[\s\-.])\d{1,3}[\s\-.]?\d{2,4}[\s\-.]?\d{3,4}[\s\-.]?\d{2,4})\b/gd,
    validate: (v) => v.replace(/\D/g, '').length >= 9,
    mask: maskDigits,
    hint: 'Looks like an international phone number.',
  },
  {
    id: 'ssn',
    label: 'US Social Security number',
    category: 'personal',
    severity: 'critical',
    pattern: /\b(\d{3}-\d{2}-\d{4})\b/gd,
    mask: () => `${DOT.repeat(3)}-${DOT.repeat(2)}-${DOT.repeat(4)}`,
    hint: 'Government identifier.',
  },

  /* -------------------------------------------------------- financial */
  {
    id: 'credit-card',
    label: 'Payment card number',
    category: 'financial',
    severity: 'critical',
    pattern: /\b((?:\d{4}[\s\-]?){3}\d{1,7})\b/gd,
    validate: (v) => luhn(v),
    mask: maskCard,
    hint: 'Passes the Luhn checksum — this is a real card format.',
  },
  {
    id: 'iban',
    label: 'IBAN',
    category: 'financial',
    severity: 'high',
    pattern: /\b([A-Z]{2}\d{2}[A-Z0-9]{11,28})\b/gd,
    validate: (v) => /^[A-Z]{2}\d{2}/.test(v) && v.length >= 15,
    mask: (v) => keepEnds(v, 4, 3),
    hint: 'International bank account number.',
  },

  /* --------------------------------------------------- infrastructure */
  {
    id: 'db-connection-string',
    label: 'Database connection string',
    category: 'network',
    severity: 'critical',
    pattern:
      /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|clickhouse):\/\/[^\s"'<>]{6,})/gid,
    mask: maskUrl,
    hint: 'Usually embeds a username and password.',
  },
  {
    id: 'url-with-credentials',
    label: 'URL with credentials',
    category: 'network',
    severity: 'critical',
    pattern: /(https?:\/\/[^\s:@/]+:[^\s@/]+@[^\s"'<>]+)/gid,
    mask: maskUrl,
    hint: 'Username and password embedded in a URL.',
  },
  {
    id: 'public-ipv4',
    label: 'Public IP address',
    category: 'network',
    severity: 'medium',
    pattern: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/gd,
    validate: (v, _f, line) => isValidIPv4(v) && !isPrivateIPv4(v) && !looksLikeVersionString(line, v),
    mask: (v) => v.split('.').slice(0, 1).join('.') + `.${DOT.repeat(3)}.${DOT.repeat(3)}.${DOT.repeat(3)}`,
    hint: 'A routable server address.',
  },
  {
    id: 'private-ipv4',
    label: 'Private IP address',
    category: 'network',
    severity: 'low',
    pattern: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/gd,
    validate: (v, _f, line) => isValidIPv4(v) && isPrivateIPv4(v) && !looksLikeVersionString(line, v),
    mask: (v) => v,
    hint: 'Internal network address — usually harmless.',
  },
  {
    id: 'internal-hostname',
    label: 'Internal hostname',
    category: 'network',
    severity: 'low',
    pattern: /\b([a-z0-9][a-z0-9\-]{1,30}\.(?:internal|local|corp|intranet|lan|test))\b/gid,
    mask: (v) => keepEnds(v, 2, 6),
    hint: 'Reveals internal infrastructure naming.',
  },
  {
    id: 'aws-account-id',
    label: 'AWS account ID',
    category: 'network',
    severity: 'medium',
    pattern: /arn:aws:[a-z0-9\-]*:[a-z0-9\-]*:(\d{12})/gid,
    group: 1,
    mask: (v) => keepEnds(v, 2, 2),
    hint: 'Identifies your AWS account.',
  },
];

export const DETECTORS_BY_ID = new Map(DETECTORS.map((d) => [d.id, d]));

export function maskValue(detectorId: string, value: string): string {
  const det = DETECTORS_BY_ID.get(detectorId);
  if (det?.mask) {
    try {
      return det.mask(value);
    } catch {
      /* fall through */
    }
  }
  return keepEnds(value, 3, 3);
}
