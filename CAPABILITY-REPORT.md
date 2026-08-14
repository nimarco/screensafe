# ScreenSafe — Submission Evidence

Date of verification: 2026-08-14

This document records the behavior of the current submission build. The
headline workflow was run through the production bundle: upload, scan, review,
export, playback, and rescan.

## End-to-end proof

1. The bundled recording is loaded through the real file-input workflow.
2. The scan samples 45 frames, reads 24, skips 21 unchanged frames, and groups
   the result into 13 findings in about 2.5 seconds.
3. Findings are blurred by default. A reviewer allows one email while keeping
   the remaining sensitive content covered.
4. The app exports a playable H.264/AAC MP4 with the redactions burned into
   the pixels.
5. The exported file is played back in the app and rescanned with the same
   detection pipeline.
6. The rescan leaves exactly the deliberately allowed email. The credentials,
   phone numbers, card number, connection string, token, and IP are absent
   from the detector result.

This verifies the complete creator workflow: detection, default protection,
per-finding review, destructive export, playback, and post-export validation.

## Production detector catalog

The production pipeline contains 32 text detectors and 2 visual detectors.
All findings share the same local OCR, tracking, review, and export path.

| Area | Included coverage |
| --- | --- |
| Developer secrets | Stripe secret and publishable keys, GitHub tokens, AWS access credentials and account IDs, Google, OpenAI, Anthropic, Slack, SendGrid, npm, and Twilio credentials, JWTs, private-key headers, SSH keys, bearer tokens, passwords, and values assigned to secret-shaped names |
| Personal data | Email addresses, North American and international phone numbers, and US Social Security numbers |
| Financial data | Payment card numbers with Luhn validation and IBANs |
| Infrastructure | Database connection strings, URLs with embedded credentials, public and private IP addresses, and internal hostnames |
| Visual content | Faces with MediaPipe BlazeFace and QR codes with jsQR |

The detector layer also handles common video-OCR artifacts: punctuation
spacing, split tokens, confusable characters, dark-mode text, and overlapping
matches. Values are masked before they appear in the review queue.

## Visual verification

### Photographed screens

The OCR pipeline measures text-block skew and applies a deskewed second pass
when the measured rotation reaches the configured threshold. A simulated phone
photo of an environment file improved from 0 of 6 secrets recognized to 6 of
6. Normal screen recordings measure approximately 0.02–0.10 degrees of skew
and remain on the fast path.

Evidence harnesses:

- tools/photo-scan-e2e.html
- tools/regression-normal-scan.html
- tools/deskew-angle-probe.html

### Faces

Face detection runs on the full frame and overlapping native-resolution tiles.
The default scan floor is about 64 pixels of head height. Three real webcam
clips covered 359 sampled frames, with a face found in 99–100% of frames that
contained one. Track association removes transient low-confidence boxes before
findings reach the review queue.

Evidence harnesses:

- tools/vlog-bench.html
- tools/face-scale-bench.html
- tools/face-stray-probe.html

### QR codes

QR reads are validated for printable payloads, square geometry, pixel size, and
module density. Weak reads are corroborated across nearby frames. A tiled
search handles separate codes that a single whole-frame jsQR call would miss.
The fixture suite covers real payloads, multiple codes, empty reads, and
false-positive camera footage.

## Performance and export

On the bundled 22-second, 720p recording:

- scan: about 2.5 seconds;
- sampling: 45 frames, with 21 skipped by change detection;
- OCR: 4 parallel workers;
- export: H.264/AAC MP4 through the demonstrated Chrome path;
- playback: exported output loads in the app and preserves audio;
- verification: the exported file can be rescanned with the same detectors.

The export uses a destructive mosaic. The grid is bounded so a redacted region
never exceeds 6 cells per side at the face-safe setting. The review UI exposes
the strength tradeoff and warns when a weaker setting can leave a face
recoverable.

## Privacy and runtime

- Video, OCR, face detection, QR detection, and encoding run locally.
- OCR, vision, and encoder assets are served from public/vendor.
- The runtime requires no account, upload service, database, or external API.
- The bundled sample contains fabricated credentials.
- A full scan uses same-origin local assets and does not send the recording to
  a third-party host.

## Automated checks

The current checkout passes:

```text
131 passed, 0 failed
```

The suite covers detector positives and false-positive traps, OCR normalization,
masked values, face tiling and tracking, QR validation, mosaic geometry, and
export helpers. The production build also completes with npm run build.

## Submission demo script

1. Run npm install and npm run dev.
2. Open the app and select Load sample.
3. Point out the grouped findings and masked values.
4. Allow the safe email; leave credentials and other sensitive findings blurred.
5. Change redaction strength and explain the face-safety indicator.
6. Export, scrub the resulting MP4, and download it.
7. Open tools/verify-e2e.html for the scan-export-rescan proof.

## Release scope

ScreenSafe is tuned for screen recordings and browser-decodable video. Its
operating boundaries are:

- English OCR is the supported language.
- Sampling runs at 2 fps, so content visible for less than roughly 500 ms can
  fall between samples.
- Photographed screens receive rotation correction; strong perspective
  distortion can reduce OCR recall.
- The default face floor is about 64 pixels of head height.
- Very small, blurred, or tightly clustered QR codes can fall below geometry
  and corroboration thresholds.
- Private-key coverage is the BEGIN ... PRIVATE KEY header line.
- License plates, street addresses, street signs, bare usernames, and
  arbitrary names are outside the release scope.
- Long or high-resolution recordings require more processing time.

Reviewers should watch the exported file before publishing, which is the final
human check in the workflow.
