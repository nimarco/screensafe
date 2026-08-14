/**
 * Detector regression suite. Run with: npm test
 *
 * Every string here is a fabricated example — the tokens are structurally valid
 * but not real credentials.
 */
import { scanLine } from '../src/lib/detectors/scanText.ts';
import { maskValue } from '../src/lib/detectors/catalog.ts';
import { sameSecret } from '../src/lib/detectors/similarity.ts';
import type { CategoryId } from '../src/lib/types.ts';

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

const NEGATIVE: Case[] = [
  { line: 'Running on node v18.17.1 with npm 9.6.7', expect: null },
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

for (const c of POSITIVE) {
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
] as const;

console.log('\n  masking preview');
for (const [id, val] of maskCases) {
  const masked = maskValue(id, val);
  const leaks = masked.includes(val);
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

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (failures.length) {
  console.log(failures.map((f) => '  ' + f).join('\n\n'));
  console.log('');
  process.exit(1);
}
