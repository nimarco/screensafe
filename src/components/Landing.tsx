import { useRef, useState } from 'react';
import { DETECTORS } from '../lib/detectors/catalog';
import { CATEGORIES, type CategoryId } from '../lib/types';
import { Pipeline } from './Pipeline';
import { CheckIcon, FileIcon, Spinner } from './ui';

interface Props {
  categories: Set<CategoryId>;
  onToggleCategory: (id: CategoryId) => void;
  onFile: (file: File) => void;
  onSample: () => void;
  loadingSample: boolean;
}

/** The two vision detectors don't live in the regex catalog, so they're
 *  counted alongside it rather than reported as zero. */
const VISION_RULES: Partial<Record<CategoryId, number>> = { visual: 2 };

const RULE_COUNT: Record<CategoryId, number> = CATEGORIES.reduce(
  (acc, c) => {
    acc[c.id] = DETECTORS.filter((d) => d.category === c.id).length + (VISION_RULES[c.id] ?? 0);
    return acc;
  },
  {} as Record<CategoryId, number>,
);

const TOTAL_RULES = Object.values(RULE_COUNT).reduce((a, b) => a + b, 0);

export function Landing({ categories, onToggleCategory, onFile, onSample, loadingSample }: Props) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const activeRules = CATEGORIES.filter((c) => categories.has(c.id)).reduce(
    (n, c) => n + RULE_COUNT[c.id],
    0,
  );

  return (
    <div className="work">
      <div className="intro">
        <h1>Scan a screen recording for exposed secrets.</h1>
        <p>
          OCR reads every frame that changed, {TOTAL_RULES} deterministic detectors classify what it finds, and
          the export burns mosaics into the pixels. Decoding, detection and encoding all run in this tab — the
          video is never uploaded.
        </p>
      </div>

      <div className="spec">
        <span>
          <b>{TOTAL_RULES}</b> detectors
        </span>
        <span>
          <b>{CATEGORIES.length}</b> categories
        </span>
        <span>text + faces + QR</span>
        <span>
          in <b>MP4 / WebM / MOV</b>
        </span>
        <span>
          out <b>H.264 MP4</b>
        </span>
        <span>
          <b>0</b> network requests
        </span>
      </div>

      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        onClick={() => input.current?.click()}
      >
        <span className="dz-icon">
          <FileIcon />
        </span>
        <div className="dz-text">
          <h2>Drop a screen recording</h2>
          <p>MP4, WebM or MOV · best under 5 minutes · read straight off disk</p>
        </div>
        <input
          ref={input}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
        <div className="dz-actions">
          <button
            type="button"
            className="btn"
            onClick={(e) => {
              e.stopPropagation();
              input.current?.click();
            }}
          >
            Choose file
          </button>
          <button
            type="button"
            className="btn"
            disabled={loadingSample}
            onClick={(e) => {
              e.stopPropagation();
              onSample();
            }}
          >
            {loadingSample ? <Spinner /> : null} Load sample
          </button>
        </div>
      </div>

      <section className="sec">
        <div className="sec-head">
          <h3>Scan scope</h3>
          <span className="sec-note">
            {categories.size}/{CATEGORIES.length} on · {activeRules} detectors active
          </span>
        </div>
        <div className="scope">
          {CATEGORIES.map((c) => {
            const on = categories.has(c.id);
            return (
              <button
                type="button"
                key={c.id}
                className={`scope-row${on ? ' on' : ''}`}
                onClick={() => onToggleCategory(c.id)}
                aria-pressed={on}
              >
                <span className="check">{on ? <CheckIcon /> : null}</span>
                <span className="scope-main">
                  <span className="scope-label">{c.label}</span>
                  <span className="scope-blurb">{c.blurb}</span>
                </span>
                <span className="scope-count">{RULE_COUNT[c.id]}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="sec">
        <Pipeline />
      </section>
    </div>
  );
}
