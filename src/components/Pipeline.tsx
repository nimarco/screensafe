import type { ReactNode } from 'react';
import { DETECTORS } from '../lib/detectors/catalog';
import { ChevronIcon } from './ui';

/** The seven stages, in the order the code runs them. Order is the point —
 *  each stage only exists because the one before it narrowed the work. */
const STAGES: Array<[string, ReactNode]> = [
  ['Sample', <>Decode the video at 2 fps through <code>requestVideoFrameCallback</code>, never seeking.</>],
  ['Diff', <>Compare a <code>160×90</code> luma signature per frame; unchanged frames skip OCR entirely.</>],
  ['Read', <>Tesseract wasm across a Web Worker pool, plus MediaPipe face detection and jsQR.</>],
  [
    'Classify',
    <>
      {DETECTORS.length} deterministic detectors — regex with Luhn, Shannon-entropy and IP-range validators.
      No model, no inference.
    </>,
  ],
  ['Track', <>Merge repeat hits across frames into one time range with a dilated bounding box.</>],
  ['Review', <>Every finding blurred by default; you allow items back through one at a time.</>],
  ['Export', <>Mosaic downsample burned into the pixels, re-encoded with WebCodecs and muxed to MP4.</>],
];

export function Pipeline() {
  return (
    <details className="pipe">
      <summary>
        <ChevronIcon />
        How it works
        <span className="sum-note">on-device pipeline</span>
      </summary>
      <div className="pipe-body">
        {STAGES.map(([name, desc], i) => (
          <div className="pipe-step" key={name}>
            <span className="pipe-n">{String(i + 1).padStart(2, '0')}</span>
            <span className="pipe-name">{name}</span>
            <span className="pipe-desc">{desc}</span>
          </div>
        ))}
        <div className="pipe-foot">
          <b>0 external requests during processing.</b>
          <span>OCR, face and QR models are served from /vendor, not a CDN — it works offline.</span>
        </div>
      </div>
    </details>
  );
}
