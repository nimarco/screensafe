# ScreenSafe

**The privacy linter for video.** Drop in a screen recording, and ScreenSafe finds the API keys,
tokens, emails, card numbers, connection strings and faces you left on screen — blurs every one of
them by default — and hands you the list to review before you publish.

Everything runs in the browser. The video is never uploaded anywhere.

```bash
npm install
npm run dev
```

Then open http://localhost:5173 and click **Load sample**.

---

## Why

Developers have secret scanners before they push code. Writers have spellcheck before they publish.
Video has nothing. You record a tutorial, your `.env` is on screen for four seconds in minute two,
and by the time someone tells you, it's been live for a week.

Screen recordings are a distinct problem from the footage that redaction tools are usually built
for. The sensitive thing is rarely a face — it's *text inside a UI*: a terminal, an editor, a
billing page. So that's what ScreenSafe is built around.

## What it does

1. **Samples** the video twice a second.
2. **Skips** frames where nothing changed — screen recordings are static most of the time.
3. **Reads** the remaining frames with OCR running in parallel Web Workers.
4. **Classifies** the text with ~30 deterministic detectors (no LLM, no network call).
5. **Tracks** each hit across frames into a time range with a bounding box.
6. **Shows you the list**, everything blurred by default, and lets you allow items back through.
7. **Exports** a real MP4 with the redactions burned into the pixels.

## Design decisions

**Blurred by default, opt out per item.** A false positive costs the reviewer one click. A false
negative leaks a live credential. The whole system is tuned in that direction — time ranges are
padded outward, boxes are dilated, and uncertain matches are still covered.

**Deterministic detectors, not a model.** OCR locates the text; regex and validators classify it.
Card numbers are checked against Luhn, generic tokens against a Shannon-entropy floor, IPs against
private ranges. It's faster, free, offline, and you can read the rules and know exactly what it
catches.

**Mosaic, not blur.** Gaussian blur is a reversible convolution and has been undone on real
redactions before. ScreenSafe downsamples each region to a handful of pixels and scales it back up
with smoothing off, which throws the information away permanently.

**Values are masked in the UI.** The findings list shows `sk_live_••••••••••9Gh`, not the key. A
review screen that reprints every secret in plain text is its own leak.

**Nothing leaves the device.** No accounts, no uploads, no API keys, no server. OCR (Tesseract),
face detection (MediaPipe) and encoding (WebCodecs) all run locally, and every model and wasm binary
is served from `public/vendor/` rather than a CDN — so it also works offline.

## Detector coverage

| Category | Detects |
| --- | --- |
| Developer secrets | Stripe, GitHub, AWS (id + secret), Google, OpenAI, Anthropic, Slack (token + webhook), SendGrid, npm, Twilio, JWTs, private key blocks, SSH keys, bearer tokens, passwords, and any value assigned to a secret-shaped name |
| Personal | Emails, phone numbers (US + international), US Social Security numbers |
| Financial | Payment cards (Luhn-validated), IBANs |
| Infrastructure | Database connection strings, URLs with embedded credentials, public IPs, private IPs, internal hostnames, AWS account IDs |
| Visual | Faces (MediaPipe BlazeFace), QR codes |

Severity is per-detector and reflects real risk: a Stripe *secret* key is critical, a Stripe
*publishable* key is low, because it's designed to be public.

## The parts that were harder than they looked

Three of these were found by measurement after the obvious implementation looked fine, which is the
main reason the tooling in `tools/` exists.

**Change detection resolution.** Skipping unchanged frames is what makes the scan fast. The first
version compared 64×36 luma signatures — and silently missed secrets. At that resolution each cell
averages a 20×20px block, and thin antialiased UI text vanishes into it: a frame where a whole new
line of credentials appeared registered **0 changed cells**, indistinguishable from a static frame.
At 160×90 the same event registers 45. Measured with `tools/sig-res-probe.html`:

| transition | 64×36 | 160×90 |
| --- | --- | --- |
| line of text appears | 0–3 cells | 13–101 cells |
| static frame | 0 cells | 0 cells |

**OCR punctuation spacing.** Tesseract reads `postgres://admin:pw@db.prod.internal` as
`postgres: //admin: pw@db. prod. internal`, which defeats every URL and dotted-token rule at once.
Each line is now also scanned with spaces adjacent to URL punctuation removed, with an offset map so
the redaction box still lands on the original pixels.

**Split tokens.** OCR breaks long random strings at arbitrary points — a JWT came back as
`...dBj ftJeZ4CVPmB92K27u`. The regex matched up to the space and the tail stayed legible *next to a
redaction box*, which is worse than not redacting at all. Coverage now extends over adjacent
token-shaped fragments.

**Dark mode.** Tesseract is trained on dark-text-on-light-paper, but developers record dark editors.
Frames with low mean luma are inverted before OCR — the brightness comes free from the
change-detection signature.

**Hidden tabs.** A backgrounded tab presents no video frames at all (`requestVideoFrameCallback`
never fires, playback stalls) and throttles timers to ~1/second. Because a privacy export cannot
guess which decoded pixels are drawable, export requires a visible tab and fails closed if the tab
is hidden. A visible stream stall may recover by seeking, but only after a matching
`requestVideoFrameCallback` confirms each frame; the yield primitive remains a `MessageChannel`
message rather than `setTimeout(0)`.

## Performance

On the 22-second 720p demo recording, on a laptop:

- **Scan:** ~2.5s — 45 frames sampled, 24 read, 21 skipped by change detection, 4 OCR workers.
- **Export:** ~10-16s — 662 frames re-encoded to H.264 + AAC.

Two things carry that. OCR runs concurrently across a worker pool: frames must be *grabbed* serially
because there's one decode position, but reading them is the expensive part and it overlaps. And
export pulls frames by *playing* the video rather than seeking to each one — keyframes are seconds
apart, so per-frame seeking re-decodes the same frames repeatedly, while playing decodes each frame
once and delivers it with its true presentation timestamp (which also preserves variable frame rates).

## Verify it yourself

```bash
npm test
```

56 detector cases: every secret type, plus deliberate false-positive traps (`API_KEY=your_api_key_here`,
`node v18.17.1`, a 16-digit number that fails Luhn), plus the real OCR artifacts above, plus the
duplicate-merging rules — including that two *different* IPs must never be merged into one finding.

For the end-to-end claim, open `tools/verify-e2e.html` with the dev server running. It scans the
demo, exports it, then runs **the same detectors over the exported file** and asserts they find
nothing.

## Project layout

```
src/lib/
  detectors/     catalog.ts (the rules) · scanText.ts (matching + OCR repair) · validators.ts · similarity.ts
  ocr/pool.ts    parallel Tesseract workers
  video/         frames.ts (sampling) · diff.ts (change detection) · redact.ts (mosaic) · exportVideo.ts
  vision/        faces.ts (MediaPipe) · qr.ts (jsQR)
  scan.ts        orchestrator: sampling, gating, tracking, dedupe
src/components/  Landing · Scanning · Stage (preview) · Findings (review queue)
tools/           calibration and verification harnesses (dev only)
```

## Limitations

Worth being straight about:

- **English OCR only.** The bundled Tesseract model is `eng`.
- **Between samples is inferred.** Scanning runs at 2 fps and the exported redaction covers the
  padded range. Text that appears and disappears inside a single 500ms window can be missed.
- **License plates aren't detected** as a category; faces and QR codes are.
- **Long or high-resolution video is slow.** Practical ceiling is a few minutes at 1080p.
- **The demo recording is synthetic** — generated by `tools/make-sample.html` — and every credential
  in it is fabricated. It contains no faces, so the face detector is loaded and exercised in the
  demo but has nothing to find.
- **It is a safety net, not a guarantee.** Review the list, and watch your own export before
  publishing.

## Built with

React · TypeScript · Vite · Tesseract.js · MediaPipe Tasks Vision · jsQR · mp4-muxer · WebCodecs

No backend. No database. No AI API. Deploys as static files.
