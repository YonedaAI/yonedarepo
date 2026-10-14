import { ClampedText, needsPreview } from '../../components/ClampedText';

// Roughly three lines at the paragraph's 90ch measure.
const PREVIEW_CHARACTERS = 270;
const PREVIEW_LINES = 3;

/** Whether a brief is long enough to preview instead of showing in full. */
export function intentNeedsPreview(intent: string) {
  return needsPreview(intent, PREVIEW_LINES, PREVIEW_CHARACTERS);
}

export function RunIntent({ intent }: { intent: string }) {
  return (
    <ClampedText
      text={intent}
      lines={PREVIEW_LINES}
      characters={PREVIEW_CHARACTERS}
      className="review-intent"
      toggleClassName="review-intent-toggle"
      prefix={
        <>
          <strong>Intent:</strong>{' '}
        </>
      }
      showLabel="Show full brief"
      hideLabel="Show less"
    />
  );
}
