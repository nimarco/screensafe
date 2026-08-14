export type CategoryId = 'developer' | 'personal' | 'financial' | 'network' | 'visual';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type FindingSource = 'ocr' | 'face' | 'qr';

/** Box in *video pixel* coordinates, origin top-left. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a finding was seen at one sampled instant. */
export interface Occurrence {
  t: number;
  box: Box;
}

export interface Finding {
  id: string;
  detectorId: string;
  label: string;
  category: CategoryId;
  severity: Severity;
  /** Raw matched text. Never rendered directly in the UI — `masked` is. */
  value: string;
  masked: string;
  /** Seconds. Already padded conservatively outward from observed samples. */
  start: number;
  end: number;
  occurrences: Occurrence[];
  /** Default true: we redact unless a human explicitly allows it through. */
  redact: boolean;
  source: FindingSource;
  /** 0..1 — OCR confidence, or detector confidence for vision sources. */
  confidence: number;
}

export interface CategoryMeta {
  id: CategoryId;
  label: string;
  blurb: string;
}

export const CATEGORIES: CategoryMeta[] = [
  {
    id: 'developer',
    label: 'Developer secrets',
    blurb: 'API keys, access tokens, JWTs, private keys, .env values',
  },
  {
    id: 'personal',
    label: 'Personal information',
    blurb: 'Emails, phone numbers, government IDs',
  },
  {
    id: 'financial',
    label: 'Financial',
    blurb: 'Card numbers, IBANs, routing numbers',
  },
  {
    id: 'network',
    label: 'Infrastructure',
    blurb: 'Connection strings, public IPs, internal hostnames',
  },
  {
    id: 'visual',
    label: 'Visual identifiers',
    blurb: 'Faces and QR codes',
  },
];

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
