import { type RunSample, runSamples } from '../../../../shared/run-samples';

export function RunSamples({
  onChoose,
  disabled,
}: {
  onChoose: (sample: RunSample) => void;
  disabled: boolean;
}) {
  return (
    <section className="run-samples" aria-label="Sample run profiles">
      <p>Try a sample brief</p>
      <div className="run-actions">
        {runSamples.map((sample) => (
          <button
            key={sample.id}
            type="button"
            className="quiet sample-choice"
            aria-label={sample.label}
            aria-describedby={`sample-${sample.id}-summary`}
            disabled={disabled}
            onClick={() => onChoose(sample)}
          >
            <span>{sample.label}</span>
            <small id={`sample-${sample.id}-summary`}>{sample.summary}</small>
          </button>
        ))}
      </div>
      <small>Choose a sample, review its brief, then start the run.</small>
    </section>
  );
}
