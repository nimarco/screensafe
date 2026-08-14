# ScreenSafe — Capability Report

Compiled by reading the actual source and running the app, not from the README.
Date of verification: 2026-08-13. Verified against both the dev server and a
production build (`npm run build`) served over plain HTTP.

**Status vocabulary**

| Status | Meaning |
| --- | --- |
| **VERIFIED** | Detected in real video, shown in the UI, blurred, exported, and confirmed removed by re-scanning the exported file. |
| **PARTIALLY VERIFIED** | Proven at one level (e.g. unit test on text) but not through the full video→export→re-scan loop. |
| **IMPLEMENTED BUT UNVERIFIED** | Code path is live and runs without error, but has never successfully matched its target in testing. |
| **NOT IMPLEMENTED** | No code exists for it. |

---

## 0. The headline test

The exact demo sequence, run end to end on the production build:

1. Uploaded `leaky-demo.mp4` through the real file input as `my-tutorial-recording.mp4`.
2. Scan produced **13 findings** in ~2.5s (45 frames sampled, 24 OCR'd, 21 skipped).
3. Clicked **Visible** on one finding (an email) — UI moved to "12 blurred", timeline marker dimmed.
4. Exported → `my-tutorial-recording-screensafe.mp4`, MP4 1280×720 @30fps **+ audio**, 585 KB, 13.0s.
5. Exported file played back in-app; at t=10s the OpenAI key and phone are pixelated on lines 4 and 6
   while the allowed email on line 5 is fully readable.
6. **Re-scanned the exported file with the same detectors → exactly 1 finding remained: the email
   that was deliberately allowed.** All 12 kept-blurred findings were gone.

That single result verifies detection, default-blur, per-item allow, burn-in, and export integrity
simultaneously.

---

## 1. Detection capabilities

31 text detectors + 2 visual detectors exist in code.
Text detection pipeline for **all** text categories is identical:

> Frame sampled at 2fps → change-gated → upscaled (~1.5× at 720p) → inverted if the frame is dark →
> Tesseract OCR in Web Workers → word boxes reassembled into lines → line scanned in 3 variants (raw,
> confusable-folded, OCR-despaced) → regex + validators → overlapping matches resolved by
> severity/length → tracked across frames into a time range → duplicates merged.

Every text detector below is: **fully local — yes**, **wired into production UI — yes**,
**auto-blurred by default — yes**, **reviewable/restorable — yes**, **burned into export — yes**.
Those five properties are structural: they come from the shared pipeline, and were verified by the
headline test. So the columns that actually vary per detector are *what it matches*, *whether it has
been tested*, and *how*.

### 1a. Developer secrets (19 detectors, category `developer`)

| Feature | Exactly what it detects | Status | Test performed |
| --- | --- | --- | --- |
| **Stripe secret key** | `sk_live_` / `sk_test_` / `rk_live_` / `rk_test_` + ≥10 alphanumerics. Severity **critical** | **VERIFIED** | Detected in demo at 0:01–0:06, blurred, absent from re-scanned export. Plus 2 unit tests. |
| **Stripe publishable key** | `pk_live_` / `pk_test_` + ≥10 chars. Severity **low** *(deliberately — it is designed to be public)* | IMPLEMENTED BUT UNVERIFIED | No unit test, never seen in video. |
| **SendGrid API key** | `SG.` + ≥16 chars + `.` + ≥16 chars. Severity critical | **VERIFIED** | Detected in demo at 0:02–0:06, blurred, gone from export. Unit test includes the OCR-split form `SG.xxx . yyy`. |
| **OpenAI API key** | `sk-` (not `sk-ant-`), optional `proj-`/`svcacct-`/`admin-`, + ≥20 chars. Severity critical | **VERIFIED** | Detected in demo at 0:06–0:12, blurred, gone from export. Plus unit test. |
| **AWS access key ID** | `AKIA`/`ASIA`/`AGPA`/`AIDA`/`AROA`/`AIPA`/`ANPA`/`ABIA`/`ACCA` + 12–20 uppercase-alphanumerics. Severity critical | **VERIFIED** | Detected in demo at 0:17–0:22, blurred, gone from export. Plus unit test. |
| **AWS secret access key** | Requires the literal label: `aws_secret_access_key` (any case, `_` or `-`) followed by `=`/`:` then 32–45 base64 chars. Severity critical | **VERIFIED** | Detected in demo at 0:18–0:22, blurred, gone from export. Plus unit test. |
| **JSON Web Token** | `eyJ` + ≥6 chars `.` ≥6 chars `.` **≥4 chars**. Severity critical | **PARTIALLY VERIFIED** — see note below | Unit test passes on clean text. In the demo the JWT *was* detected and redacted, but attributed to the **Bearer token** rule instead (see §1a-note). |
| **Bearer token** | `bearer` + whitespace + ≥16 token chars, gated by a randomness check. Severity critical | **VERIFIED (as the JWT catch)** | Fired on the demo's `Authorization: Bearer eyJ…` line, blurred, gone from export. **No unit test.** |
| **Password** | `password` / `passwd` / `pwd` + `=`/`:` + ≥6 non-space chars; rejects `changeme`, `your`, `example`, `hunter2`, etc. Severity critical | PARTIALLY VERIFIED | Unit test passes (`password = "Tr0ub4dor&3xKq"` detected; `password = changeme` correctly ignored). Never exercised in video. |
| **Secret value** (generic API-key catch-all) | A variable name containing `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `APIKEY`, `API_KEY`, `PRIVATE_KEY`, `ACCESS_KEY`, `CLIENT_SECRET` or `CREDENTIAL`, followed by `=`/`:` and a value ≥8 chars that either has ≥2.6 bits/char entropy or is ≥20 chars. Severity critical | PARTIALLY VERIFIED | Unit test passes, incl. correctly rejecting `API_KEY=your_api_key_here`. In the demo it fired transiently on a half-typed key, then merged into the Stripe finding. |
| **GitHub token** | `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` + ≥16, or `github_pat_` + ≥20 | PARTIALLY VERIFIED | 2 unit tests. Never in video. |
| **Google API key** | `AIza` + 30–40 chars | PARTIALLY VERIFIED | Unit test. Never in video. |
| **Anthropic API key** | `sk-ant-` + ≥16 chars | PARTIALLY VERIFIED | Unit test. Never in video. |
| **Slack token** | `xoxb-`/`xoxa-`/`xoxp-`/`xoxr-`/`xoxs-`/`xoxe-` + ≥10 | PARTIALLY VERIFIED | Unit test. Never in video. |
| **Slack webhook URL** | `https://hooks.slack.com/services/` + ≥20 chars. Severity high | PARTIALLY VERIFIED | Unit test. Never in video. |
| **npm access token** | `npm_` + ≥28 alphanumerics | PARTIALLY VERIFIED | Unit test. Never in video. |
| **Twilio credential** | `SK` or `AC` + exactly 32 hex chars. Severity high | PARTIALLY VERIFIED | Unit test. Never in video. |
| **Private key block** | The literal header `-----BEGIN [X] PRIVATE KEY-----`. **Only the header line** — see limitations | PARTIALLY VERIFIED | Unit test. Never in video. |
| **SSH key** | `ssh-rsa` / `ssh-ed25519` / `ssh-dss` + ≥20 base64 chars. Severity medium | IMPLEMENTED BUT UNVERIFIED | No unit test, never in video. |

**§1a-note — the JWT nuance, stated precisely.** In the demo recording the JWT's content *is*
detected, blurred and removed from the export. But it is labelled **"Bearer token"**, not "JSON Web
Token". Reason: OCR split the token as `…eyJzdWIi0iIxMjMONSJ9.dBj ftJeZ4CVPmB92K27u`, leaving the
third segment as 3 characters, and the `jwt` rule requires ≥4. The `bearer-token` rule matched
instead. A clean, unsplit JWT is labelled correctly (unit-tested). **Safe to say:** "it caught the
JWT." **Not safe to say:** "it labels every JWT as a JWT."

### 1b. Personal information (4 detectors, category `personal`)

| Feature | Exactly what it detects | Status | Test performed |
| --- | --- | --- | --- |
| **Email address** | `local@domain.tld`; rejects reserved `@example.com`/`@test.*`/`@localhost` domains. Severity medium | **VERIFIED** | Two separate occurrences detected in the demo (0:06–0:12 in the editor, 0:12–0:18 in the billing panel), correctly kept as **two distinct findings** because they are at different screen positions. One was allowed through and confirmed still readable in the export; the other stayed blurred. |
| **Phone number (NA)** | Optional `+1`, then `(NNN) ` or `NNN` + separator + `NNN` + separator + `NNNN`. Requires separators. Rejects version-strings | **VERIFIED** | Two occurrences detected in demo (0:07–0:12, 0:13–0:18), blurred, gone from export. Plus unit tests incl. rejecting `node v18.17.1`. |
| **Phone number (intl)** | `+` + country code + 9–15 digits with optional separators | PARTIALLY VERIFIED | Unit test (`+44 20 7946 0958`). Never in video. |
| **US Social Security number** | `NNN-NN-NNNN`. Severity critical | PARTIALLY VERIFIED | Unit test. Never in video. |

### 1c. Financial (2 detectors, category `financial`)

| Feature | Exactly what it detects | Status | Test performed |
| --- | --- | --- | --- |
| **Payment card number** | 13–19 digits in 4-digit groups, **validated against the Luhn checksum** | **VERIFIED** | `4242 4242 4242 4242` detected in demo at 0:11–0:18, blurred, gone from export. Unit test also confirms `1234 5678 9012 3456` is correctly **ignored** because it fails Luhn. |
| **IBAN** | 2 letters + 2 digits + 11–28 alphanumerics, ≥15 chars total | IMPLEMENTED BUT UNVERIFIED | No unit test, never in video. Structurally loose — likely to false-positive on other long alphanumeric IDs. |

### 1d. Infrastructure / network (6 detectors, category `network`)

| Feature | Exactly what it detects | Status | Test performed |
| --- | --- | --- | --- |
| **Database connection string** | `postgres://`, `postgresql://`, `mysql://`, `mongodb://`, `mongodb+srv://`, `redis://`, `rediss://`, `amqp(s)://`, `mssql://`, `clickhouse://` + ≥6 chars. Severity critical. Masked as `postgres://••••••••@host:port/db` | **VERIFIED** | Detected in demo at 0:02–0:06, blurred, gone from export. Unit tests include the real OCR-mangled form `postgres: //admin: pw@db. prod. internal :5432/app`. |
| **URL with credentials** | `http(s)://user:pass@host`. Severity critical | PARTIALLY VERIFIED | Unit test. Never in video. |
| **Public IP address** | Valid dotted-quad that is **not** RFC1918/loopback/link-local/multicast, and not preceded by version words. Severity medium | **VERIFIED** | `203.0.113.42` detected in demo at 0:19–0:22, blurred, gone from export. Plus unit test. |
| **Private IP address** | Valid dotted-quad **inside** RFC1918/127.x/169.254.x. Severity **low** (separate rule so it reads as low-risk) | PARTIALLY VERIFIED | Unit test (`192.168.1.24`). Never surfaced in video. |
| **Internal hostname** | `something.internal` / `.local` / `.corp` / `.intranet` / `.lan` / `.test`. Severity low | PARTIALLY VERIFIED | Unit test. In the demo, `db.prod.internal` was absorbed by the higher-severity connection-string finding rather than reported separately (correct behaviour — one region, one row). |
| **AWS account ID** | The 12-digit account field inside an `arn:aws:…` string | IMPLEMENTED BUT UNVERIFIED | No unit test, never in video. |

### 1e. Visual detectors (2, category `visual`) — read this section carefully

These do **not** share the text pipeline's verification. Both are wired in and execute, but neither
has ever successfully matched its target in any test.

| Feature | Reality | Status |
| --- | --- | --- |
| **Faces** | MediaPipe BlazeFace (short-range), model served locally. **Confirmed live:** `initFaceDetector()` returns a real detector, and `detectFaces()` executed on 6/6 sampled frames of the demo with **zero errors** — returning 0 faces, because the demo contains no faces. Boxes would be padded 18% horizontally / 24% vertically, tracked by proximity, listed as "Face" (severity medium, value hidden in the UI), and redacted through the same burn-in path as text. None of that has been observed with an actual face. | **IMPLEMENTED BUT UNVERIFIED** |
| **QR codes** | jsQR, runs on every analysed frame. **Confirmed live:** executed on 6/6 frames with zero errors, found 0 codes; also correctly returned `[]` for a synthetic noise image. Never fed a real QR code. Additionally, **jsQR returns at most one code per frame**, so two QR codes visible simultaneously would yield only one finding. | **IMPLEMENTED BUT UNVERIFIED** |
| **License plates** | No detector, no model, no code path. | **NOT IMPLEMENTED** |
| **Street signs / addresses / location-revealing text** | No detector. There is no address, street-name, city, postcode or geolocation pattern anywhere in the catalog. Such text would be OCR'd but never classified as sensitive. | **NOT IMPLEMENTED** |
| **Usernames** | No dedicated detector. A username is only caught incidentally — if it is assigned to a secret-shaped variable name, or embedded in a connection string / credentialed URL. A bare `@handle` or `username: marco` is **not** detected. | **NOT IMPLEMENTED** |
| **People's names, DOB, passport/licence numbers, national IDs (non-US)** | No detectors. | **NOT IMPLEMENTED** |
| **General URLs** | Deliberately not flagged. Only Slack webhooks, credentialed URLs, connection strings and internal hostnames are treated as sensitive. In the demo, `NEXT_PUBLIC_APP_URL=https://myapp.dev` correctly produced **no** finding. | Working as designed (not a gap) |

---

## 2. Non-detection features

| Feature | State | Status / evidence |
| --- | --- | --- |
| **Upload — file picker** | `accept="video/*"`, click-to-browse | **VERIFIED** — real `File` injected through the input's `change` event; scan started and completed. |
| **Upload — drag & drop** | `onDrop`/`onDragOver` handlers present, with a hover state | IMPLEMENTED BUT UNVERIFIED — the code path exists but no actual drag was simulated. |
| **Upload — bundled demo** | "Try the demo recording" button fetches `/sample/leaky-demo.mp4` | **VERIFIED** — used repeatedly. |
| **Supported formats** | Whatever the browser can decode. **MP4/H.264+AAC verified.** WebM and MOV are claimed by the UI copy but **untested**. | PARTIALLY VERIFIED |
| **Video preview** | Live canvas composite: source frame + mosaic redactions, repainted every animation frame, so toggles apply instantly | **VERIFIED** |
| **Scan progress** | Live counters: frames sampled / read / skipped / exposures found, a progress bar, elapsed position, and a running "skipped N% of frames" line | **VERIFIED** |
| **Frame sampling** | 2 samples/sec, seek-based (deterministic) | **VERIFIED** |
| **Change detection** | 160×90 luma signature; a frame is re-read if ≥8 cells move by >14/255, or mean moves ≥1.0; compared against the last *analysed* frame so slow drips accumulate; plus a forced re-read every 5s | **VERIFIED** — 21 of 45 frames skipped on the demo. Thresholds were chosen from measured data (`tools/sig-res-probe.html`). |
| **Dark-mode OCR handling** | Frames with mean luma <110 are inverted before OCR | **VERIFIED** — the entire demo is dark-mode and OCR'd correctly (probe confirms `inverted=true`). |
| **Review queue** | Findings grouped by category, sorted by severity then time | **VERIFIED** |
| **Categories** | 5 toggles (Developer / Personal / Financial / Infrastructure / Visual), all on by default, **settable only before scanning** | **VERIFIED** — toggles work; with all off, scanning is refused with "Turn on at least one category before scanning." (it does **not** silently report "clean"). |
| **Severity** | 4 levels (critical/high/medium/low) with colour coding, counts chipped in the header | **VERIFIED** — demo shows "8 critical, 5 medium". |
| **Timestamps** | Each finding shows a padded range, e.g. `0:02–0:06` | **VERIFIED** |
| **Timeline markers** | Severity-coloured bars in their own lane under the scrubber; allowed findings dim | **VERIFIED** |
| **Jump to finding** | Button + card click + marker click all seek the preview | **VERIFIED** — clicking "Jump to 0:17" moved playback 22.0s → 17.55s and highlighted the card. |
| **Transport** | Play/pause, mute, scrub | **VERIFIED** — play advanced playback, pause stopped it, mute toggled. |
| **Default-blurred** | Every finding starts `redact: true` | **VERIFIED** |
| **Allow / restore individual finding** | Blurred ⇄ Visible segmented control per finding | **VERIFIED** — the headline test. |
| **Bulk actions** | "Blur all" / "Allow all" | **VERIFIED** — 13 → 0 → 13 blurred. |
| **Masked values** | Findings show `sk_live_••••••••••9Gh`, never the raw secret; faces show no value | **VERIFIED** — unit tests assert no mask leaks its input. |
| **Tracking across frames** | Same value + nearby box = one finding with a time range; a 1.25s gap closes the track | **VERIFIED** |
| **Duplicate merging** | Merges two findings when values match (alphanumeric-only, tolerating OCR errors **only** when one is a truncation of the other), boxes overlap >30%, and sightings are contiguous | **VERIFIED** — collapsed 15 raw tracks → 13 findings. Unit-tested that two *different* IPs are never merged. |
| **Export** | H.264 + AAC MP4 via WebCodecs + mp4-muxer; source frame timestamps preserved | **VERIFIED** — 585 KB, 22.14s, plays back. |
| **Export — audio** | Source audio decoded and re-encoded to AAC; degrades to silent video on any audio failure rather than hanging | **VERIFIED** — export reports "+ audio". |
| **Export — filename** | Derived from the uploaded file: `my-tutorial-recording-screensafe.mp4` | **VERIFIED** |
| **Exported-video playback in-app** | The result replaces the preview with a native player on the exported blob | **VERIFIED** — decoded back to 1280×720 / 22.14s and scrubbed. |
| **Download** | `<a download>` on the blob URL | IMPLEMENTED BUT UNVERIFIED — button renders and is wired; an actual download was not triggered. |
| **Scan another recording** | Resets state and revokes object URLs | IMPLEMENTED BUT UNVERIFIED |
| **Cancel scan** | Abort signal, returns to landing | **VERIFIED** — used twice during development. |
| **Local-only processing** | No uploads, no accounts, no API keys | **VERIFIED — strongest evidence in the report.** Full HTTP log of a production-build scan shows **12 requests, all to our own origin**, including the worker-initiated `/vendor/tess/worker.min.js`, `/vendor/tess/eng.traineddata`, and `/vendor/models/blaze_face_short_range.tflite`. **Zero external hosts, zero CDN.** |
| **Failure: undecodable file** | "This file couldn't be decoded. Try an MP4, WebM or MOV." | IMPLEMENTED BUT UNVERIFIED |
| **Failure: no video track** | "This file has no video track." | IMPLEMENTED BUT UNVERIFIED |
| **Failure: total OCR failure** | Throws explicitly rather than reporting a false "clean" result — "Nothing was checked, so do not treat this as a clean result." | PARTIALLY VERIFIED — the guard was written after observing a real total-OCR-failure incident; the guard itself has not been re-triggered. |
| **Failure: sample missing** | "Sample recording is unavailable." | IMPLEMENTED BUT UNVERIFIED |
| **Sample/demo generation** | `tools/make-sample.html` renders the demo clip with the same WebCodecs encoder the app exports with | **VERIFIED** — produced the 540 KB bundled demo. |
| **Browser support** | Requires WebCodecs for MP4 export; falls back to MediaRecorder/WebM otherwise | Chrome verified. **Fallback path untested.** Safari/Firefox untested. |

---

## 3. Known limitations and failure modes

1. **2fps sampling.** Anything visible for less than ~500ms can be missed entirely.
2. **English OCR only** (`eng` traineddata). Other scripts will not be read.
3. **OCR is the ceiling.** Low-resolution, heavily-compressed, small, italic, low-contrast or
   moving text may not be read, and what isn't read isn't redacted.
4. **Private key blocks:** only the `-----BEGIN … PRIVATE KEY-----` header line is matched. The key
   body on following lines is **not** covered.
5. **Faces and QR codes are unproven** (§1e).
6. **License plates, addresses, street signs, usernames, names: not implemented.**
7. **Redaction covers the OCR word box**, padded. Text that scrolls quickly between samples is
   covered by the union of bracketing observations, but very fast motion could expose an edge.
8. **`hasAudio` probe on load is unreliable** (reports false before playback); it is informational
   only and does not affect export, which decodes audio independently.
9. **Long/high-res video is slow** — practical ceiling a few minutes at 1080p.
10. **Backgrounding the tab during export** switches to the slower seek path (handled, not a hang).
11. **The bundled demo is synthetic** and every credential in it is fabricated.

---

## 4. Safe claims for the demo

Say these confidently — each is verified end to end:

- "ScreenSafe found **13 pieces of sensitive information** in this recording in about **two seconds**."
- "It detected a **Stripe secret key, a SendGrid key, an OpenAI key, an AWS access key ID and secret,
  a bearer token, a Postgres connection string, a credit card number, a public IP, two emails and two
  phone numbers**."
- "Everything is **blurred by default** — I opt things back in, rather than hunting for them."
- "The card number is validated with the **Luhn checksum**, so it's a real card format, not just
  sixteen digits."
- "The findings list shows me **masked values** — it never reprints my secrets on screen."
- "I'll **allow this email through** and keep everything else blurred." *(then show it in the export)*
- "The redaction is a **destructive mosaic burned into the pixels** — not an overlay you can peel off."
- "Here's the exported MP4, **with audio**, playing back — the key is gone, the email I allowed is still there."
- "I re-scanned the **exported file** with the same detectors: **only the one finding I allowed remains.**"
- "**Nothing leaves your machine.** The full network log for a scan is twelve requests, all to the
  app's own origin. No CDN, no API, no upload, no account."
- "It skipped **21 of 45 frames** because nothing on screen changed — that's OCR work it didn't have to do."
- "It reads **dark-mode terminals and editors**, which is what developers actually record."
- "There's **no AI API involved** — OCR finds the text, deterministic rules classify it."

## 5. Claims you should NOT make

- ❌ **"It detects and blurs faces."** The model loads and runs cleanly, but has never detected a real
  face in any test. If asked, say: *"Face detection is wired in using MediaPipe and runs on every
  frame, but I haven't validated it on real footage yet."*
- ❌ **"It detects QR codes."** Same situation — live code path, never fed a real QR code. Also
  limited to one code per frame.
- ❌ **"It blurs license plates."** Not implemented at all.
- ❌ **"It redacts addresses / street signs / location data."** Not implemented — no such pattern exists.
- ❌ **"It redacts usernames."** No dedicated detector.
- ❌ **"It labels every JWT as a JWT."** In this very demo it's labelled "Bearer token" (§1a-note).
- ❌ **"It catches any API key."** Named vendors, plus generic values that sit next to a
  secret-shaped variable name. A bare unknown random string with no label is **not** caught.
- ❌ **"It works on any video format."** Only MP4/H.264 is verified. Don't promise WebM/MOV on camera.
- ❌ **"It works in any browser."** Chrome verified only; MP4 export needs WebCodecs.
- ❌ **"It redacts entire private keys."** Only the BEGIN header line is matched.
- ❌ **"It's guaranteed / it catches everything."** Call it a safety net and a last check.
- ❌ Don't claim IBAN, SSH keys, AWS account IDs, or Stripe publishable keys work — those have
  **neither** a unit test nor a video test.

## 6. Best things to plant in your demo footage

Ranked by reliability and visual impact. The first five are already proven in the bundled demo.

1. **`cat .env` in a dark terminal** showing `STRIPE_SECRET_KEY=sk_live_…` and
   `DATABASE_URL=postgres://admin:pw@db.prod.internal:5432/app` — two critical findings, and the
   connection string masks beautifully as `postgres://••••••••@db.prod.internal:5432/app`.
2. **An editor with three adjacent lines**: an API key, an email, and a phone number. This is your
   money shot — allow the email, keep the other two blurred, and all three sit side by side so the
   selective redaction is unmistakable in one frame.
3. **A billing/settings panel** with `4242 4242 4242 4242`. Say out loud that it passes Luhn — and
   that a number which *fails* Luhn is deliberately ignored.
4. **`aws configure list`** output with `AWS_ACCESS_KEY_ID=AKIA…` and `aws_secret_access_key=…` —
   two criticals, and it demonstrates label-dependent detection.
5. **A `curl -H "Authorization: Bearer eyJ…"` line** plus a `deployed to 203.0.113.42` line —
   token + public IP, and the IP proves it distinguishes public from private addresses.
6. **A deliberate false positive to *not* flag**: leave `API_KEY=your_api_key_here` and
   `node v18.17.1` on screen and point out that ScreenSafe correctly ignores both. Showing restraint
   is more convincing than showing recall.
7. **A `.local`/`.internal` hostname or a `192.168.x.x` address** to show low-severity findings —
   demonstrates the severity system rather than everything screaming critical.
8. **Scroll or switch windows mid-recording** so the change-detection counter visibly climbs and the
   "skipped N% of frames" line moves — that's your performance story on screen.
9. *(Optional, only if you test it first)* A **real face** on a webcam bubble. Do not put this in the
   demo unless you have personally confirmed it detects — see §5.

**Deliberately keep out of frame:** license plates, street addresses, road signs, usernames, and QR
codes. Nothing will happen, and it invites exactly the question you don't want.
