# ScreenSafe

**The privacy linter for video.** ScreenSafe is the last privacy check before a
creator publishes a screen recording. It finds secrets, personal data, faces,
and QR codes on-device, lets the creator review each finding, and exports a
redacted video.

Everything runs in the browser. The video is never uploaded.

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and click **Load sample**.

## The submission

ScreenSafe automates a publishing workflow that creators currently handle by
scrubbing through a timeline manually:

1. **Scan** the recording at 2 fps and skip frames that have not changed.
2. **Detect** sensitive text with OCR, validators, faces, and QR codes.
3. **Review** grouped findings in one queue, with sensitive values masked.
4. **Decide** per finding: keep the default redaction or allow it through.
5. **Export** a destructive mosaic-redacted video.
6. **Verify** the exported file with the same detection pipeline.

This is a working tool, not an annotated screenshot: the output is a real
encoded video that can be played, scrubbed, and downloaded.

## Judge the demo

The bundled 22-second sample shows the complete loop:

1. Start the app and click **Load sample**.
2. Wait for the scan to finish. The sample produces 13 grouped findings.
3. In **Findings**, keep credentials and other sensitive values blurred.
   Click **Allow** on the safe email example to demonstrate selective review.
4. Adjust **Redaction strength** to show the face-safety tradeoff. The measured
   face-safe setting is 6 mosaic cells per side.
5. Click **Export**, wait for the result to replace the preview, and scrub it.
6. Click **Download redacted video**.

For a deeper browser check, open
[tools/verify-e2e.html](tools/verify-e2e.html) while the dev server is running.
It scans, exports, decodes the output, and rescans it to confirm that only
explicitly allowed content remains.

## Why this matters

Screen recordings expose a different class of privacy problem than ordinary
video. The sensitive thing is often text inside a terminal, editor, billing
page, or dashboard: an API key, token, email, phone number, card number, or
database URL.

ScreenSafe is designed for the creator workflow in the
[Social Media Automation Hackathon](https://social-media-automation-hacks.devpost.com/):
it automates the final safety pass before content is published, keeps the
creator in control of the review, and produces a usable export.

## Detection coverage

| Category | Coverage |
| --- | --- |
| Developer secrets | Stripe, GitHub, AWS access credentials, Google, OpenAI, Anthropic, Slack, SendGrid, npm, Twilio, JWTs, private-key headers, SSH keys, bearer tokens, passwords, and values assigned to secret-shaped names |
| Personal data | Email addresses, North American and international phone numbers, and US Social Security numbers |
| Financial data | Payment cards with Luhn validation and IBANs |
| Infrastructure | Database connection strings, credentialed URLs, public and private IPs, internal hostnames, and AWS account IDs |
| Visual content | Faces detected with MediaPipe BlazeFace and QR codes detected with jsQR |

There are 32 text detectors and 2 visual detectors in the production pipeline.
Findings are assigned a severity, grouped across time, and blurred by default.

## How it works

```
video
  -> 2 fps sampling and change detection
  -> OCR workers plus face and QR detection
  -> validators and severity classification
  -> tracked findings with padded boxes
  -> review queue
  -> mosaic burn-in and encoded export
```

Important implementation choices:

- OCR runs in parallel Web Workers. Dark editor footage is inverted before
  recognition, and photographed screens receive a measured deskew pass.
- Text is classified with readable, deterministic rules and validators. OCR
  spacing and split-token artifacts are repaired before matching.
- Faces are detected over the full frame and native-resolution tiles so small
  faces remain visible to the detector.
- QR reads are validated for payload quality and geometry, then corroborated
  across frames. A tiled sweep handles multiple codes in one frame.
- Repeated observations become one finding with a time range instead of a
  duplicate row for every sampled frame.

## Review and export

The review queue shows the detector source, severity, confidence, timestamp,
occurrence count, masked value, and redaction state. Reviewers can allow or
blur one finding at a time, or apply a bulk decision.

Redaction is a destructive mosaic written into the output pixels. It is not a
visual overlay that can be removed from the exported file. Chrome's demonstrated
path produces H.264/AAC MP4; a MediaRecorder/WebM path is also available when
the browser cannot provide the preferred encoder.

## Privacy model

- Video processing is local to the browser.
- OCR, face detection, QR detection, and encoding use vendored assets in
  public/vendor.
- No account, upload service, database, or external runtime API is required.
- Sensitive values are masked before they appear in the review UI.
- The bundled demo credentials are fabricated.

## Verified result

The current repository has a reproducible end-to-end result:

- the bundled sample scans in about 2.5 seconds on the development machine;
- 45 frames are sampled, 24 are read, and 21 are skipped as unchanged;
- Chrome exports the redacted result as H.264/AAC MP4;
- rescanning the exported file leaves only the email that was deliberately
  allowed through;
- npm test passes 131 deterministic regression checks covering detectors,
  OCR normalization, masking, face tiling and tracking, QR validation,
  redaction geometry, and export behavior;
- npm run build completes the production build.

The detailed measurements and evidence are in
[CAPABILITY-REPORT.md](CAPABILITY-REPORT.md).

## Development

```bash
npm install
npm run dev
npm test
npm run build
```

The browser verification harnesses in [tools](tools) cover the end-to-end
workflow, photographed-screen OCR, change detection, face scale, QR behavior,
and export geometry.

## Project layout

```
src/
  components/       landing, scan progress, preview, and review queue
  lib/detectors/    detector catalog, matching, and validators
  lib/ocr/          worker pool and photographed-screen preprocessing
  lib/vision/       face and QR detection
  lib/video/        sampling, change detection, mosaic, and export
  scan.ts           sampling, gating, tracking, and deduplication
scripts/             deterministic detector and fixture checks
tools/               browser calibration and verification harnesses
public/vendor/       local OCR, face, QR, and encoder assets
```

## Operating boundaries

- English OCR is the supported language.
- Scanning samples at 2 fps; content visible for less than roughly 500 ms can
  fall between samples.
- Photographed screens are deskewed for rotation. Strong perspective
  distortion can reduce OCR recall.
- The practical face floor is about 64 pixels of head height with the default
  scan settings.
- Very small, blurred, or tightly clustered QR codes can fall below the
  detector's geometry and corroboration thresholds.
- Private-key detection covers the BEGIN ... PRIVATE KEY header line.
- License plates, street addresses, street signs, bare usernames, and
  arbitrary names are outside the current detection scope.
- Long or high-resolution recordings require more processing time.

Review the findings and watch the exported file before publishing.

## Built with

React, TypeScript, Vite, Tesseract.js, MediaPipe Tasks Vision, jsQR,
mp4-muxer, WebCodecs, and MediaRecorder.

The app deploys as static files with no backend or database.
