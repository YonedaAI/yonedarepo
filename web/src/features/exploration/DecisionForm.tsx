import { useState } from 'react';
export function DecisionForm({
  busy,
  alternatives,
  onAccept,
  onClose,
}: {
  busy: boolean;
  alternatives: Record<string, any>[];
  onAccept: (
    rationale: string,
    alternatives: { candidate: string; reason: string }[],
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState('');
  return (
    <form
      className="decision-form"
      onSubmit={(e) => {
        e.preventDefault();
        void onAccept(
          rationale.trim(),
          alternatives.map((c) => ({ candidate: c.id, reason: reasons[c.id]?.trim() ?? '' })),
        );
      }}
    >
      <label htmlFor="rationale">Why choose this approach?</label>
      <textarea
        id="rationale"
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        required
        placeholder="Record the tradeoff future readers should understand."
      />
      {alternatives.map((c) => (
        <label key={c.id}>
          Why keep {c.strategy ?? c.summary} as an alternative?
          <input
            required
            value={reasons[c.id] ?? ''}
            onChange={(e) => setReasons((all) => ({ ...all, [c.id]: e.target.value }))}
            placeholder="Record its tradeoff or why it was rejected"
            maxLength={2048}
          />
        </label>
      ))}
      <p>
        Publishes the selected source after Git verification and updates its website when static
        assets are available.
      </p>
      <div>
        <button type="submit" disabled={busy || !rationale.trim()}>
          Record decision and publish
        </button>
        <button type="button" className="quiet" disabled={busy} onClick={onClose}>
          Keep comparing
        </button>
      </div>
    </form>
  );
}
