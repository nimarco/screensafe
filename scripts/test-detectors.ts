/**
 * Detector regression suite. Run with: npm test
 *
 * Every string here is a fabricated example — the tokens are structurally valid
 * but not real credentials.
 */
import { scanLine } from '../src/lib/detectors/scanText.ts';
import { maskValue } from '../src/lib/detectors/catalog.ts';
import { sameSecret } from '../src/lib/detectors/similarity.ts';
import { detectQr, judgeQr } from '../src/lib/vision/qr.ts';
import { canStitchFaceTracks, continuesFace, faceBoxesMatch, isEstablishedFace, tileLadder } from '../src/lib/vision/faces.ts';
import { mosaicGrid } from '../src/lib/video/redact.ts';
import { QR_FIXTURES, QR_URL, QR_WIFI } from './fixtures/qrFixtures.ts';
import { blank, DECOYS, drawQr, qrImage, type RawImage } from './fixtures/patterns.ts';
import type { Box, CategoryId } from '../src/lib/types.ts';

const ALL: Set<CategoryId> = new Set(['developer', 'personal', 'financial', 'network', 'visual']);

// Assemble synthetic credentials at runtime so repository secret scanners do
// not mistake regression fixtures for credentials that can be used.
const fixture = (...parts: string[]) => parts.join('');
const F = {
  stripeLive: fixture('sk', '_live_', '51QjsAbCdEfGhIjKlMnOp9Gh'),
  stripeTest: fixture('sk', '_test_', '4eC39HqLyjWDarjtT1zdp7dc'),
  stripeOcr: fixture('sk', '_live_', '510QjsAbCdEfGhIjKUMnOpQrSt9Gh'),
  githubClassic: fixture('gh', 'p_', '16CharsAtLeastAbcdefghijklmnop'),
  githubPat: fixture('github', '_pat_', '11ABCDEFG0abcdefghijkl_mnopqrstuv'),
  awsId: fixture('A', 'KIAIOSFODNN7EXAMPLE'),
  awsSecret: fixture('wJalrXUtnFEMI', '/K7MDENG/bPxRfiCYEXAMPLEKEY'),
  google: fixture('AI', 'zaSyD-1234567890abcdefghijklmnopqrstu'),
  openai: fixture('sk', '-proj-', 'abcdef1234567890ABCDEFghijkl'),
  anthropic: fixture('sk', '-ant-api03-', 'AbCdEf1234567890xyz'),
  slackToken: fixture('xox', 'b-123456789012-abcdefghijklmn'),
  slackWebhook: fixture('https://hooks.', 'slack.com/services/', 'T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX'),
  sendgridHead: fixture('S', 'G.aBcDeFgHiJkLmNoP'),
  sendgridTail: fixture('qRsTuVwXyZ0123456789abcd'),
  sendgrid: fixture('S', 'G.aBcDeFgHiJkLmNoP', '.', 'qRsTuVwXyZ0123456789'),
  npm: fixture('np', 'm_abcdefghijklmnopqrstuvwxyz0123456789'),
  twilio: fixture('A', 'C1234567890abcdef1234567890abcdef'),
  jwt: fixture('e', 'yJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiIxMjM0NSJ9', '.', 'dBjftJeZ4CVP'),
  privateKey: fixture('-----BEGIN RSA', ' PRIVATE KEY-----'),
  labeledSecret: fixture('hunter2', 'Zx9QpLmVnB4tR'),
  password: fixture('Tr0ub', '4dor&3xKq'),
  database: fixture('postgres', '://admin:', 's3cr3t', 'pw@db.prod.example.com:5432/main'),
  databaseOcr: fixture('postgres', ': //admin: hunter2pass@db. prod. internal :5432/app'),
  mongo: fixture('mongodb+srv', '://user:', 'pass', '123@cluster0.abcd.mongodb.net/test'),
  credentialUrl: fixture('https://root:', 'letmein', '@internal.api.co/v1/users'),
} as const;

interface Case {
  line: string;
  expect: string | null;
  note?: string;
}

const POSITIVE: Case[] = [
  { line: 'STRIPE_SECRET_KEY=' + F.stripeLive, expect: 'stripe-secret' },
  { line: 'const key = "' + F.stripeTest + '"', expect: 'stripe-secret' },
  { line: 'GITHUB_TOKEN=' + F.githubClassic, expect: 'github-token' },
  { line: 'token: ' + F.githubPat, expect: 'github-token' },
  { line: 'AWS_ACCESS_KEY_ID = ' + F.awsId, expect: 'aws-access-key' },
  {
    line: 'aws_secret_access_key = ' + F.awsSecret,
    expect: 'aws-secret-key',
  },
  { line: 'GOOGLE_MAPS=' + F.google, expect: 'google-api-key' },
  { line: 'openai.api_key = "' + F.openai + '"', expect: 'openai-key' },
  { line: 'ANTHROPIC_API_KEY=' + F.anthropic, expect: 'anthropic-key' },
  { line: 'SLACK_BOT_TOKEN=' + F.slackToken, expect: 'slack-token' },
  {
    line: 'curl -X POST ' + F.slackWebhook,
    expect: 'slack-webhook',
  },
  { line: 'SENDGRID_API_KEY=' + F.sendgrid, expect: 'sendgrid-key' },
  { line: 'NPM_TOKEN=' + F.npm, expect: 'npm-token' },
  { line: 'TWILIO_SID=' + F.twilio, expect: 'twilio-key' },
  {
    line: 'Authorization: Bearer ' + F.jwt,
    expect: 'jwt',
    note: 'JWT wins over the bearer-token rule (longer, more specific)',
  },
  { line: F.privateKey, expect: 'private-key-block' },
  { line: 'MY_APP_SECRET=' + F.labeledSecret, expect: 'labeled-secret' },
  { line: 'password = "' + F.password + '"', expect: 'password-assignment' },
  { line: 'Contact me at marco.nunes@gmail.com anytime', expect: 'email' },
  { line: 'Call (314) 555-0192 for support', expect: 'phone-us' },
  { line: 'ring +44 20 7946 0958 tomorrow', expect: 'phone-intl' },
  { line: 'SSN 123-45-6789 on file', expect: 'ssn' },
  { line: 'card 4242 4242 4242 4242 exp 12/28', expect: 'credit-card' },
  {
    line: 'DATABASE_URL=' + F.database,
    expect: 'db-connection-string',
  },
  { line: F.mongo, expect: 'db-connection-string' },
  { line: 'curl ' + F.credentialUrl, expect: 'url-with-credentials' },
  { line: 'ssh deploy@203.0.113.42 -p 22', expect: 'public-ipv4' },
  { line: 'listening on 192.168.1.24:3000', expect: 'private-ipv4' },
  { line: 'resolved buildbox.internal to 10.0.0.4', expect: 'internal-hostname' },

  // Real Tesseract output from the demo recording. It inserts spaces around
  // punctuation, which used to defeat every URL and dotted-token rule.
  {
    line: 'DATABASE_URL=' + F.databaseOcr,
    expect: 'db-connection-string',
    note: 'OCR spacing artifact',
  },
  {
    line: 'SENDGRID_API_KEY=' + F.sendgridHead + ' . ' + F.sendgridTail,
    expect: 'sendgrid-key',
    note: 'OCR split the key at the dot',
  },
  { line: 'deployed to 203.0.113.42', expect: 'public-ipv4' },
  {
    line: 'STRIPE_SECRET_KEY=' + F.stripeOcr,
    expect: 'stripe-secret',
    note: 'OCR read 51Q as 510',
  },
];

/**
 * Names that carry a credential without spelling out "API key".
 *
 * A bare `_KEY` suffix is how most real projects name the thing, and the rule
 * used to require the full word — so a Supabase anon key sitting in plain sight
 * was read correctly and then dropped on the floor.
 */
const KEY_SUFFIX: Case[] = [
  { line: 'VITE_SUPABASE_ANON_KEY=' + F.jwt, expect: 'jwt', note: 'named rule still wins' },
  { line: 'SUPABASE_ANON_KEY=' + F.labeledSecret, expect: 'labeled-secret' },
  { line: 'ENCRYPTION_KEY=' + F.labeledSecret, expect: 'labeled-secret' },
  { line: 'SIGNING_KEY: ' + F.labeledSecret, expect: 'labeled-secret' },
  { line: 'app.publishable_key = "' + F.labeledSecret + '"', expect: 'labeled-secret' },
];

/**
 * A secret-shaped name assigned a value that does not look live.
 *
 * Reported, but not as a critical leak: the reviewer is the one who knows
 * whether `whsec_test_fake` is a placeholder or the real webhook signing secret
 * with a jokey suffix. Staying silent decided that for them.
 */
const PLACEHOLDER_VALUES: Case[] = [
  { line: 'STRIPE_WEBHOOK_SECRET=whsec_fake', expect: 'secret-assignment' },
  { line: 'DB_PASSWORD=pw_2024', expect: 'secret-assignment' },
  { line: 'SESSION_KEY=abc_123', expect: 'secret-assignment' },
];

const NEGATIVE: Case[] = [
  { line: 'Running on node v18.17.1 with npm 9.6.7', expect: null },
  { line: 'KEYBOARD_LAYOUT=dvorak', expect: null, note: 'KEY inside a word is not a key' },
  { line: 'MY_KEYBOARD_SHORTCUT=ctrl_k', expect: null, note: 'KEY inside a word is not a key' },
  { line: 'CACHE_ENABLED=true', expect: null },
  { line: 'SECRET_ROTATION_DAYS=30', expect: null, note: 'a setting, not a secret' },
  { line: 'DEBUG_TOKEN=false', expect: null, note: 'a setting, not a secret' },
  { line: 'API_KEY=your_key_here', expect: null, note: 'placeholder vocabulary' },
  { line: 'new OpenAI({ apiKey: OPENAI_KEY })', expect: null, note: 'passes a secret by reference' },
  { line: 'STRIPE_SECRET_KEY=STRIPE_SECRET_KEY', expect: null, note: 'passes a secret by reference' },
  { line: 'API_KEY=your_api_key_here', expect: null, note: 'placeholder' },
  { line: 'password = changeme', expect: null, note: 'placeholder' },
  { line: 'The quick brown fox jumps over the lazy dog', expect: null },
  { line: 'import { useState } from "react"', expect: null },
  { line: 'card 1234 5678 9012 3456', expect: null, note: 'fails Luhn' },
  { line: 'Released version 1.2.3.4 today', expect: null, note: 'version, not an IP' },
  { line: 'see docs at support@example.com', expect: null, note: 'reserved example domain' },
  { line: 'const secretMessage = hello', expect: null, note: 'low-entropy value' },
  { line: 'git commit -m "fix: update token refresh logic"', expect: null },
  { line: 'Total: 4 items, 2024 revenue up 12%', expect: null },
];

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (const c of [...POSITIVE, ...KEY_SUFFIX, ...PLACEHOLDER_VALUES]) {
  const hits = scanLine(c.line, ALL);
  const ids = hits.map((h) => h.detectorId);
  if (ids.includes(c.expect!)) {
    pass++;
  } else {
    fail++;
    failures.push(`MISS  expected ${c.expect} in "${c.line}"\n      got: [${ids.join(', ') || 'nothing'}]`);
  }
}

for (const c of NEGATIVE) {
  const hits = scanLine(c.line, ALL);
  if (hits.length === 0) {
    pass++;
  } else {
    fail++;
    failures.push(
      `FALSE POSITIVE in "${c.line}"\n      got: [${hits.map((h) => `${h.detectorId}:"${h.value}"`).join(', ')}]`,
    );
  }
}

// Masking must never leak the full secret back out.
const maskCases = [
  ['stripe-secret', F.stripeLive],
  ['email', 'marco.nunes@gmail.com'],
  ['credit-card', '4242 4242 4242 4242'],
  ['jwt', fixture('e', 'yJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'abc')],
  ['password-assignment', F.password],
  ['db-connection-string', 'postgres://db.example.com/main?password=supersecret'],
  ['db-connection-string', 'postgres://admin:secret@db.example.com:5432/main'],
] as const;

console.log('\n  masking preview');
for (const [id, val] of maskCases) {
  const masked = maskValue(id, val);
  const leaks = masked.includes(val) || masked.includes('supersecret') || masked.includes('secret@');
  if (leaks) {
    fail++;
    failures.push(`MASK LEAK ${id}: "${masked}" contains the raw value`);
  } else {
    pass++;
  }
  console.log(`    ${id.padEnd(22)} ${masked}`);
}

/*
 * Duplicate-collapsing. Merging two findings hides one from the review queue,
 * so a false merge is a leak — these cases come from real OCR output.
 */
const SAME_SECRET: Array<[string, string, boolean, string]> = [
  [fixture('sk', '_lLive_', '51Qj'), F.stripeOcr, true, 'half-drawn frame vs settled'],
  [
    F.sendgridHead + '.' + F.sendgridTail,
    F.sendgridHead + '..' + F.sendgridTail,
    true,
    'OCR added a stray period',
  ],
  ['marco.nunes@gmail.com', 'marco.nunes@gmail.com', true, 'identical'],
  ['203.0.113.42', '203.0.113.99', false, 'different IPs must stay separate'],
  ['marco.nunes@gmail.com', 'support@acme.io', false, 'different emails'],
  [F.awsId, F.awsSecret.slice(0, 24), false, 'aws id vs aws secret'],
  [F.stripeLive.slice(0, 20), F.githubClassic.slice(0, 20), false, 'unrelated secrets'],
];

for (const [a, b, want, note] of SAME_SECRET) {
  if (sameSecret(a, b) === want) {
    pass++;
  } else {
    fail++;
    failures.push(`SAME-SECRET expected ${want} for ${note}\n      a="${a}"\n      b="${b}"`);
  }
}

/*
 * QR codes.
 *
 * jsQR returns a result only when a decode passes Reed-Solomon, which sounds
 * like proof and isn't: on camera footage it latches onto three unrelated dark
 * blobs and error-corrects the noise between them into a "valid" read. These
 * cases pin down both directions — real codes must still be found, and the
 * shapes that fooled it in the field must stay rejected.
 */
const asImageData = (img: RawImage) => img as unknown as ImageData;

/*
 * Faces are judged twice: once within a frame, where a box the model doubts is
 * dropped if a box it trusts sits beside it, and once across the whole track,
 * here. The second pass is what stops a recording with no people in it from
 * reporting faces — the synthetic demo did exactly that at 46% and 48%.
 */
/*
 * Tile sizing. BlazeFace needs ~20px of face inside its 128px input, which is a
 * property of the network, so the crop we hand it must be the same number of
 * pixels whatever the frame around it. Sizing tiles as a fraction of the frame
 * instead made a 720p scan magnify 1.5x harder than a 1080p one — which is how
 * a code editor with no people in it came to report two faces.
 */
/*
 * Redaction strength.
 *
 * The mosaic used a fixed ~12.7px block derived from text cap height, so the
 * number of cells left behind grew with the region: a line of text kept 33x2
 * and was destroyed, while a 446x485 face kept 35x38 and was still plainly the
 * person — the face detector re-ran on the redacted pixels and found the face
 * again at 0.89. A redaction has to be judged by what survives it, so the bound
 * is on cells kept, whatever the region's size.
 */
console.log('\n  Redaction: no region may survive with more than 6 cells a side');
const REGIONS: Array<[number, number, string]> = [
  [420, 28, 'line of code'],
  [60, 20, 'short word'],
  [180, 200, 'webcam bubble'],
  [446, 485, 'face, close up'],
  [900, 980, 'face, very close'],
  [1620, 1080, 'whole frame'],
];
for (const [bw, bh, label] of REGIONS) {
  const { sw, sh } = mosaicGrid(bw, bh);
  const worst = Math.max(sw, sh);
  if (worst <= 6) {
    pass++;
  } else {
    fail++;
    failures.push(`REDACTION too weak on ${label} (${bw}x${bh}): keeps ${sw}x${sh} cells`);
  }
  console.log(`    ${label.padEnd(18)} ${(bw + 'x' + bh).padEnd(10)} -> ${sw}x${sh} cells`);
}
// The strength slider drives this parameter, and it must actually move the
// grid — and never past the bounds the UI offers, whatever it is handed.
{
  const face: [number, number] = [446, 485];
  const strong = mosaicGrid(...face, 3);
  const weak = mosaicGrid(...face, 15);
  const clampedLow = mosaicGrid(...face, 1);
  const clampedHigh = mosaicGrid(...face, 999);
  const moves = strong.sw < weak.sw;
  const bounded = clampedLow.sw === strong.sw && clampedHigh.sw === weak.sw;
  if (moves && bounded) {
    pass++;
  } else {
    fail++;
    failures.push(
      `MOSAIC slider broken: 3 cells -> ${strong.sw}, 15 -> ${weak.sw}, ` +
        `clamped 1 -> ${clampedLow.sw}, clamped 999 -> ${clampedHigh.sw}`,
    );
  }
  console.log(
    `    ${'strength range'.padEnd(18)} ${'446x485'.padEnd(10)} -> ${strong.sw}x${strong.sh} … ${weak.sw}x${weak.sh} cells (clamped outside 3–15)`,
  );
}

// And tiny regions must not be crushed to a single cell needlessly.
{
  const { sw, sh } = mosaicGrid(24, 12);
  console.log(`    ${'tiny box'.padEnd(18)} ${'24x12'.padEnd(10)} -> ${sw}x${sh} cells`);
  if (sw >= 1 && sh >= 1) pass++;
  else {
    fail++;
    failures.push('REDACTION produced an empty grid for a tiny box');
  }
}

console.log('\n  Faces: tile size must not depend on the frame it came from');
const LADDER_RESOLUTIONS: Array<[number, number, string]> = [
  [1280, 720, '720p'],
  [1620, 1080, 'webcam 3:2'],
  [1920, 1080, '1080p'],
  [3840, 2160, '4K'],
  [720, 1280, 'portrait'],
];
const firstSides = new Set<number>();
for (const [w, h, name] of LADDER_RESOLUTIONS) {
  const ladder = tileLadder(w, h, 64);
  firstSides.add(ladder[0]);
  console.log(`    ${name.padEnd(12)} ${String(w) + 'x' + h}`.padEnd(30) + `ladder ${JSON.stringify(ladder)}`);
}
if (firstSides.size === 1) {
  pass++;
} else {
  fail++;
  failures.push(`TILE SIZE varies with resolution: saw ${[...firstSides].join(', ')} — the 720p/1080p bug is back`);
}

// No band of face sizes may fall between two levels, or between the top level
// and the letterboxed full-frame pass.
for (const [w, h, name] of LADDER_RESOLUTIONS) {
  const ladder = tileLadder(w, h, 64);
  const frameFloor = (22 * Math.max(w, h)) / 128;
  let gap: string | null = null;
  for (let i = 0; i + 1 < ladder.length; i++) {
    // Level i resolves up to its own side; level i+1 starts at 22/128 of its side.
    if ((22 * ladder[i + 1]) / 128 > ladder[i]) gap = `${ladder[i]}px..${ladder[i + 1]}px`;
  }
  if (ladder.length && ladder[ladder.length - 1] < frameFloor) {
    gap = `${ladder[ladder.length - 1]}px..${frameFloor.toFixed(0)}px (frame pass)`;
  }
  if (!gap) {
    pass++;
  } else {
    fail++;
    failures.push(`FACE SIZE GAP on ${name}: nothing resolves faces of ${gap}`);
  }
}

// And no tiling at all when the plain frame pass already reaches that size.
if (tileLadder(1280, 720, 400).length === 0) {
  pass++;
} else {
  fail++;
  failures.push('TILING ran for a face size the full-frame pass already covers');
}

console.log('\n  Faces: a track the model never trusted is not a face');
const FACE_TRACKS: Array<[number, boolean, string]> = [
  [0.97, true, 'subject facing the camera'],
  [0.72, true, 'small but genuine face, the weakest real score measured'],
  [0.66, false, 'a hand held up near the lens'],
  [0.53, false, 'a chair back'],
  [0.48, false, 'code editor in the synthetic demo — no people on screen'],
  [0.46, false, 'the second one from that demo'],
];
for (const [conf, want, note] of FACE_TRACKS) {
  if (isEstablishedFace(conf) === want) {
    pass++;
  } else {
    fail++;
    failures.push(`FACE TRACK at ${conf} should ${want ? 'redact' : 'be dropped'} — ${note}`);
  }
  console.log(`    ${conf.toFixed(2)}  ${(want ? 'redact' : 'drop').padEnd(6)} ${note}`);
}

console.log('\n  Faces: a nearby impostor cannot inherit a large face track');
const FACE_ASSOCIATION: Array<[boolean, string, { a: Box; b: Box }]> = [
  [false, 'large face vs nearby smaller hand-like box', { a: { x: 914, y: 219, w: 611, h: 539 }, b: { x: 674, y: 357, w: 247, h: 269 } }],
  [true, 'same face, modest movement', { a: { x: 914, y: 219, w: 611, h: 539 }, b: { x: 1040, y: 250, w: 600, h: 530 } }],
];
for (const [want, note, boxes] of FACE_ASSOCIATION) {
  const got = faceBoxesMatch(boxes.a, boxes.b);
  if (got === want) pass++;
  else {
    fail++;
    failures.push(`FACE ASSOCIATION expected ${want} for ${note}`);
  }
  console.log(`    ${(got ? 'match' : 'separate').padEnd(8)} ${note}`);
}

/*
 * Rejoining a face the tracker dropped mid-clip. Strict association is what
 * keeps a chair back out of a real face's track, and the price is that a quick
 * head turn ends one track and starts another — showing the reviewer two
 * identical "Face" rows for one person. Rows are stitched only when one
 * presence ends before the next starts, so two people who are on screen
 * together are never collapsed into a single row.
 */
console.log('\n  Faces: one person, one row — but two people stay two');
const STITCH: Array<[number, number, boolean, string]> = [
  [11.0, 11.5, true, 'same face, tracker lost it for one sample'],
  [11.0, 12.0, true, 'same face, lost for two samples'],
  [48.0, 0.5, false, 'a second person, on screen the whole time'],
  [48.0, 20.0, false, 'a second face that started long before this one ended'],
  [11.0, 11.0, false, 'exactly concurrent — two faces, not one'],
  [11.0, 30.0, false, 'a different person appearing much later'],
];
for (const [prevLast, nextFirst, want, note] of STITCH) {
  if (continuesFace(prevLast, nextFirst, 1.25) === want) {
    pass++;
  } else {
    fail++;
    failures.push(`FACE STITCH expected ${want} for ${note} (${prevLast} -> ${nextFirst})`);
  }
  console.log(`    ${(want ? 'join' : 'keep apart').padEnd(11)} ${note}`);
}

const SPATIAL_STITCH: Array<[boolean, string, { lastT: number; lastBox: Box }, { firstT: number; firstBox: Box }]> = [
  [true, 'same face after a short detector dropout', { lastT: 11, lastBox: { x: 100, y: 80, w: 220, h: 240 } }, { firstT: 11.5, firstBox: { x: 125, y: 90, w: 215, h: 235 } }],
  [false, 'different person appears nearby after the first leaves', { lastT: 11, lastBox: { x: 100, y: 80, w: 220, h: 240 } }, { firstT: 11.5, firstBox: { x: 520, y: 90, w: 220, h: 240 } }],
  [false, 'same time means two people, even if boxes are close', { lastT: 11, lastBox: { x: 100, y: 80, w: 220, h: 240 } }, { firstT: 11, firstBox: { x: 125, y: 90, w: 215, h: 235 } }],
];
for (const [want, note, previous, next] of SPATIAL_STITCH) {
  const got = canStitchFaceTracks(previous, next, 1.25);
  if (got === want) pass++;
  else {
    fail++;
    failures.push(`FACE SPATIAL STITCH expected ${want} for ${note}`);
  }
  console.log(`    ${(got ? 'join' : 'keep apart').padEnd(11)} ${note}`);
}

console.log('\n  QR: real codes must still be found');
for (const fx of QR_FIXTURES) {
  const version = (fx.rows.length - 17) / 4;
  for (const module of [3, 5, 8]) {
    const hits = detectQr(asImageData(qrImage(fx, { module })));
    if (hits.length === 1 && hits[0].data === fx.payload) {
      pass++;
    } else {
      fail++;
      failures.push(
        `QR MISSED a real code (version ${version}, ${module}px/module): got ` +
          `${JSON.stringify(hits.map((h) => h.data))}`,
      );
    }
  }
  const big = detectQr(asImageData(qrImage(fx, { module: 8 })))[0];
  console.log(
    `    version ${version} ${String(fx.rows.length).padStart(2)}x${fx.rows.length}  ` +
      `decoded ${JSON.stringify((big?.data ?? '').slice(0, 34))} (${big?.strength ?? 'MISSED'})`,
  );
  // A comfortable code must not need a second frame to be believed.
  if (big?.strength === 'strong') {
    pass++;
  } else {
    fail++;
    failures.push(`QR at 8px/module should be strong enough for one frame, was ${big?.strength}`);
  }
}

/*
 * Replays of jsQR results captured from real footage containing no QR code
 * (tools/vlog-bench.html). These are the exact corner coordinates jsQR
 * returned, so if a threshold adjustment lets any of them back in, this
 * fails. Note the corners running off the left edge into negative x: the shape
 * jsQR "found" was never on the screen.
 */
const FIELD_FALSE_POSITIVES = [
  {
    note: 'vlog-b 3.5s',
    data: '',
    version: 1,
    corners: {
      tl: { x: 1216.87, y: 1007.34 },
      tr: { x: 1218.01, y: 1012.5 },
      br: { x: -30.38, y: 216.29 },
      bl: { x: -0.48, y: 228.29 },
    },
  },
  {
    note: 'vlog-b 6.5s',
    data: '',
    version: 1,
    corners: {
      tl: { x: 1197.68, y: 1009.88 },
      tr: { x: 1218.44, y: 1023.71 },
      br: { x: -66.95, y: 185.31 },
      bl: { x: -29.38, y: 208.91 },
    },
  },
  {
    // The dangerous one: a near-square quad with sensible angles and 21 pixels
    // per module. Geometry alone would wave it through — only the payload
    // check catches it, which is why both gates exist.
    note: 'vlog-c 40.0s',
    data: '',
    version: 1,
    corners: {
      tl: { x: 479.21, y: 795.81 },
      tr: { x: 83.26, y: 622.32 },
      br: { x: 250.82, y: 67.41 },
      bl: { x: 733.55, y: 88.64 },
    },
  },
] as const;

/*
 * Two codes on one frame. jsQR returns a single result per call, so a slide
 * showing a wifi code beside a payment code used to get one blurred and the
 * other published — the redactor's worst failure mode, since the reviewer sees
 * a QR finding and assumes it covered the QR codes.
 */
{
  const board = blank(900, 460);
  const left = drawQr(board, QR_URL, { module: 6, x: 10, y: 10 });
  const right = drawQr(board, QR_WIFI, { module: 6, x: 470, y: 10 });
  const found = detectQr(asImageData(board));
  const payloads = found.map((h) => h.data).sort();
  const want = [QR_URL.payload, QR_WIFI.payload].sort();
  const covered = [left, right].every((box) =>
    found.some(
      (h) =>
        h.box.x <= box.x + 1 &&
        h.box.y <= box.y + 1 &&
        h.box.x + h.box.w >= box.x + box.w - 1 &&
        h.box.y + h.box.h >= box.y + box.h - 1,
    ),
  );
  if (payloads.join('|') === want.join('|') && covered) {
    pass++;
  } else {
    fail++;
    failures.push(
      `QR MISSED one of two codes on a frame: decoded ${JSON.stringify(payloads)}, ` +
        `both boxes covered: ${covered}`,
    );
  }
  console.log(`\n  QR: two codes on one frame -> ${found.length} found, both boxes covered: ${covered}`);

  // Codes at opposite ends of a full frame are the arrangement the whole-frame
  // pass fails hardest on — it returns nothing at all — so this is the case the
  // tiled sweep exists for. Measured limit: codes closer than about one
  // code-width still defeat the locator in every region that holds both.
  const wide = blank(1620, 1080);
  drawQr(wide, QR_URL, { module: 5, x: 60, y: 400 });
  drawQr(wide, QR_WIFI, { module: 5, x: 1200, y: 400 });
  const wholeFrame = detectQr(asImageData(wide), { sweepTiles: false }).length;
  const swept = detectQr(asImageData(wide)).length;
  if (swept === 2) {
    pass++;
  } else {
    fail++;
    failures.push(`QR sweep failed on codes at opposite ends of a frame: found ${swept} of 2`);
  }
  console.log(`  QR: codes at opposite ends  -> whole-frame pass ${wholeFrame}/2, tiled sweep ${swept}/2`);

  const square = blank(900, 900);
  const squareLeft = drawQr(square, QR_URL, { module: 6, x: 10, y: 10 });
  const squareRight = drawQr(square, QR_WIFI, { module: 6, x: 470, y: 10 });
  const squareFound = detectQr(asImageData(square));
  const squarePayloads = squareFound.map((h) => h.data).sort();
  const squareCovered = [squareLeft, squareRight].every((box) =>
    squareFound.some(
      (h) =>
        h.box.x <= box.x + 1 &&
        h.box.y <= box.y + 1 &&
        h.box.x + h.box.w >= box.x + box.w - 1 &&
        h.box.y + h.box.h >= box.y + box.h - 1,
    ),
  );
  if (squarePayloads.join('|') === want.join('|') && squareCovered) {
    pass++;
  } else {
    fail++;
    failures.push(
      `QR MISSED one of two codes on a square frame: decoded ${JSON.stringify(squarePayloads)}, ` +
        `both boxes covered: ${squareCovered}`,
    );
  }
  console.log(`  QR: two codes on square frame -> ${squareFound.length} found, both boxes covered: ${squareCovered}`);
}

console.log('\n  QR: false positives captured from real video');
for (const c of FIELD_FALSE_POSITIVES) {
  const verdict = judgeQr(c.data, c.version, c.corners);
  if (!verdict.ok) {
    pass++;
  } else {
    fail++;
    failures.push(`QR FALSE POSITIVE accepted again (${c.note}): ${JSON.stringify(verdict.evidence)}`);
  }
  console.log(
    `    ${c.note.padEnd(14)} ${verdict.ok ? 'ACCEPTED (regression!)' : `rejected — ${verdict.evidence.reject}`}` +
      `  [ratio ${verdict.evidence.sideRatio}, angles ${verdict.evidence.minAngle}-${verdict.evidence.maxAngle}, ` +
      `px/module ${verdict.evidence.pxPerModule}]`,
  );
}

console.log('\n  QR: patterns that are not QR codes');
for (const decoy of DECOYS) {
  const img = asImageData(decoy.make());
  const raw = detectQr(img, { validate: false });
  const kept = detectQr(img);
  if (kept.length === 0) {
    pass++;
  } else {
    fail++;
    failures.push(
      `QR FALSE POSITIVE on ${decoy.name}: ${JSON.stringify(kept.map((h) => h.data))} ` +
        `${JSON.stringify(kept[0].evidence)}`,
    );
  }
  console.log(
    `    ${decoy.name.padEnd(18)} jsQR ${raw.length ? 'fired' : 'quiet'}, findings ${kept.length}`,
  );
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (failures.length) {
  console.log(failures.map((f) => '  ' + f).join('\n\n'));
  console.log('');
  process.exit(1);
}
