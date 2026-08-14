/**
 * Simulates a phone photo of a laptop screen, so the OCR recovery path can be
 * measured against a fixture instead of a one-off attachment.
 *
 * The failure we are reproducing has four ingredients, and all four matter:
 * the screen is a fraction of the frame, it is rotated, it is keystoned by the
 * camera being off-axis, and the whole thing has been through a lossy encoder.
 * Drop any one of them and the baseline pipeline starts working again, which
 * would make the bench useless.
 */

const fakeJwt = [
  ['e', 'y', 'J'].join('') + 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJyb2xlIjoiZGVtbyJ9',
  'c2NyZWVuc2FmZV9maXh0dXJl',
].join('.');
const fakeGoogleKeyPrefix = ['AI', 'za'].join('') + 'SyntheticLocalFixture';
const fakeGoogleKey = fakeGoogleKeyPrefix + '1234567890abc';
const fakeStripeKeyPrefix = ['sk', '_test_'].join('') + '51SyntheticLocalFixture';
const fakeStripeKey = fakeStripeKeyPrefix + '00xyz';
const fakeApiSecret = 'synthetic_local_api_fixture_value';
const fakeWebhookSecret = 'synthetic_local_webhook_fixture_value';
const fakeProjectSecret = 'synthetic_local_project_fixture_value';

/** A .env in the shape people actually record: real formats, synthetic values. */
export const ENV_LINES = [
  '# Supabase',
  'VITE_SUPABASE_URL=https://demo-project-2026.supabase.co',
  'VITE_SUPABASE_ANON_KEY=' + fakeJwt,
  'VITE_GOOGLE_PLACES_API_KEY=' + fakeGoogleKey,
  '',
  'STREAM_API_SECRET=' + fakeApiSecret,
  'STRIPE_SECRET_KEY=' + fakeStripeKey,
  'STRIPE_WEBHOOK_SECRET=' + fakeWebhookSecret,
  'SCREENSAFE_PROJECT_SECRET=' + fakeProjectSecret,
  'DEMO_DISCOVERY_ENGINE=synthetic_discovery_fixture',
  'EDITOR_SAMPLE_LEVEL=synthetic_editor_fixture',
  '',
  '# Fixture Settings',
  'SLEEP_SCHEDULE=undefined',
  'COFFEE_CONSUMPTION=excessive',
  'TOUCH_GRASS_REQUIRED=critically_overdue',
  '',
  '# Sample Metrics',
  'STORES_ONBOARDED=synthetic_status',
  'CLIPS_PROCESSED=synthetic_status_value',
  'PUBLISH_RATE=synthetic_metric_value',
  'REVENUE=synthetic_metric_value',
  '',
  '# Security',
  'HACKER_DETECTION=enabled_with_extreme_prejudice',
  'HACKER_REWARD=synthetic_reward_fixture',
];

/** The values a correct read must surface, keyed by the line that carries them. */
export const EXPECTED_SECRETS = [
  { name: 'VITE_SUPABASE_ANON_KEY', needle: fakeJwt.split('.')[0] },
  { name: 'VITE_GOOGLE_PLACES_API_KEY', needle: fakeGoogleKeyPrefix },
  { name: 'STREAM_API_SECRET', needle: fakeApiSecret },
  { name: 'STRIPE_SECRET_KEY', needle: fakeStripeKeyPrefix },
  { name: 'STRIPE_WEBHOOK_SECRET', needle: fakeWebhookSecret },
  { name: 'SCREENSAFE_PROJECT_SECRET', needle: fakeProjectSecret },
];

const COLORS = {
  bg: '#1e1e1e',
  chrome: '#252526',
  tabbar: '#2d2d2d',
  comment: '#6a9955',
  key: '#ff8c42',
  eq: '#d4d4d4',
  value: '#ce9178',
  url: '#9cdcfe',
};

/** Renders the editor as it would look if you screenshotted it directly. */
export function renderEditor(width = 1440, height = 900) {
  const c = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = c.getContext('2d', { alpha: false });
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = COLORS.chrome;
  ctx.fillRect(0, 0, width, 34);
  ctx.fillStyle = COLORS.tabbar;
  ctx.fillRect(0, 34, width, 36);
  ctx.fillStyle = '#cccccc';
  ctx.font = '15px ui-monospace, Menlo, monospace';
  for (const [i, label] of ['screensafe-app.svg', '.env.example', '.env'].entries()) {
    ctx.fillText(label, 24 + i * 190, 58);
  }

  const fontSize = 21;
  const lineHeight = 30;
  ctx.font = `${fontSize}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'alphabetic';

  let y = 110;
  for (const line of ENV_LINES) {
    if (!line) {
      y += lineHeight;
      continue;
    }
    let x = 96;
    if (line.startsWith('#')) {
      ctx.fillStyle = COLORS.comment;
      ctx.fillText(line, x, y);
    } else {
      const eq = line.indexOf('=');
      const name = line.slice(0, eq);
      const value = line.slice(eq + 1);
      ctx.fillStyle = COLORS.key;
      ctx.fillText(name, x, y);
      x += ctx.measureText(name).width;
      ctx.fillStyle = COLORS.eq;
      ctx.fillText('=', x, y);
      x += ctx.measureText('=').width;
      ctx.fillStyle = value.startsWith('http') ? COLORS.url : COLORS.value;
      ctx.fillText(value, x, y);
    }
    y += lineHeight;
  }
  return c;
}

/* ------------------------------------------------------------ perspective */

/** Solves the 8 unknowns of the homography taking src corners to dst corners. */
export function solveHomography(src, dst) {
  const a = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    a.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    b.push(dx);
    a.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    const p = a[col][col];
    if (Math.abs(p) < 1e-12) throw new Error('degenerate homography');
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r][col] / p;
      if (!f) continue;
      for (let k = col; k < 8; k++) a[r][k] -= f * a[col][k];
      b[r] -= f * b[col];
    }
  }
  const h = b.map((v, i) => v / a[i][i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular matrix');
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

/**
 * Warps `source` so its corners land on `dstCorners` in an outWxoutH frame.
 * Inverse-mapped with bilinear sampling: forward mapping would leave holes,
 * and the whole point of the fixture is that the pixels are plausible.
 */
export function warpPerspective(source, dstCorners, outW, outH, background = '#000000') {
  const sw = source.width;
  const sh = source.height;
  const srcCorners = [
    [0, 0],
    [sw, 0],
    [sw, sh],
    [0, sh],
  ];
  const inv = invert3x3(solveHomography(srcCorners, dstCorners));

  const sctx = source.getContext('2d', { alpha: false });
  const sdata = sctx.getImageData(0, 0, sw, sh).data;

  const out = Object.assign(document.createElement('canvas'), { width: outW, height: outH });
  const octx = out.getContext('2d', { alpha: false });
  octx.fillStyle = background;
  octx.fillRect(0, 0, outW, outH);
  const odata = octx.getImageData(0, 0, outW, outH);
  const o = odata.data;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const w = inv[6] * x + inv[7] * y + inv[8];
      if (Math.abs(w) < 1e-12) continue;
      const sx = (inv[0] * x + inv[1] * y + inv[2]) / w;
      const sy = (inv[3] * x + inv[4] * y + inv[5]) / w;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) continue;

      const x0 = sx | 0;
      const y0 = sy | 0;
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const di = (y * outW + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sdata[i00 + ch] * (1 - fx) + sdata[i10 + ch] * fx;
        const bot = sdata[i01 + ch] * (1 - fx) + sdata[i11 + ch] * fx;
        o[di + ch] = top * (1 - fy) + bot * fy;
      }
      o[di + 3] = 255;
    }
  }
  octx.putImageData(odata, 0, 0);
  return out;
}

/**
 * A phone photo of the editor: the screen sits inside a dark room, rotated and
 * keystoned, then softened and re-encoded the way a recording would be.
 */
export async function simulatePhoto(opts = {}) {
  const {
    outW = 992,
    outH = 1280,
    rotateDeg = -7,
    keystone = 0.05,
    screenScale = 0.78,
    blur = 0.6,
    jpegQuality = 0.55,
  } = opts;

  const editor = renderEditor();

  // Place the screen off-centre and tilt it, then pull the far edge in to make
  // the verticals converge the way an off-axis camera does.
  const cx = outW * 0.5;
  const cy = outH * 0.42;
  const halfW = (outW * screenScale) / 2;
  const halfH = (halfW * editor.height) / editor.width;
  const th = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);

  const base = [
    [-halfW, -halfH],
    [halfW, -halfH * (1 - keystone)],
    [halfW, halfH * (1 - keystone)],
    [-halfW, halfH],
  ];
  // Squeeze the right edge towards the centre: the classic keystone of a screen
  // photographed from its left.
  const corners = base.map(([x, y], i) => {
    const squeeze = i === 1 || i === 2 ? 1 - keystone * 1.6 : 1;
    const px = x;
    const py = y * squeeze;
    return [cx + px * cos - py * sin, cy + px * sin + py * cos];
  });

  const warped = warpPerspective(editor, corners, outW, outH, '#050505');

  const soft = Object.assign(document.createElement('canvas'), { width: outW, height: outH });
  const sctx = soft.getContext('2d', { alpha: false });
  sctx.filter = blur > 0 ? `blur(${blur}px)` : 'none';
  sctx.drawImage(warped, 0, 0);
  sctx.filter = 'none';

  const blob = await new Promise((res) => soft.toBlob(res, 'image/jpeg', jpegQuality));
  const bitmap = await createImageBitmap(blob);
  const final = Object.assign(document.createElement('canvas'), { width: outW, height: outH });
  final.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0);
  bitmap.close();
  return { canvas: final, corners, editor };
}
