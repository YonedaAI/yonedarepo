import { useId, useState } from 'react';

// Roughly three lines at the paragraph's 90ch measure.
const PREVIEW_CHARACTERS = 270;
const PREVIEW_LINES = 3;

/** Whether a brief is long enough to preview instead of showing in full. */
export function intentNeedsPreview(intent: string) {
  return intent.length > PREVIEW_CHARACTERS || intent.split('\n').length > PREVIEW_LINES;
}

/** The full brief stays in the DOM; collapsing only clamps it visually. */
export function RunIntent({ intent }: { intent: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const preview = intentNeedsPreview(intent);
  return (
    <>
      <p id={id} className={`review-intent${preview && !expanded ? ' collapsed' : ''}`}>
        <strong>Intent:</strong> {intent}
      </p>
      {preview && (
        <button
          type="button"
          className="text-button review-intent-toggle"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show full brief'}
        </button>
      )}
    </>
  );
}
