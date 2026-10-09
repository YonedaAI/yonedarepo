import { useState } from 'react';
export function DecisionForm({
  busy,
  blocked = false,
  alternatives,
  onAccept,
  onClose,
}: {
  busy: boolean;
  blocked?: boolean;
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
      <label htmlFor="rationale">Why publish this result?</label>
      <textarea
        id="rationale"
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        required
        placeholder="Record the tradeoff future readers should understand."
      />
      {alternatives.map((c) => (
        <label key={c.id}>
          Why wasn’t “{c.strategy ?? c.summary}” selected?
          <input
            required
            value={reasons[c.id] ?? ''}
            onChange={(e) => setReasons((all) => ({ ...all, [c.id]: e.target.value }))}
            placeholder="Explain why it wasn’t selected or when it might be useful."
            maxLength={2048}
          />
        </label>
      ))}
      <p>
        Publishes the selected source after Git verification and updates its website when static
        assets are available.
      </p>
      <div>
        <button type="submit" disabled={busy || blocked || !rationale.trim()}>
          Record decision and publish
        </button>
        <button type="button" className="quiet" disabled={busy} onClick={onClose}>
          {alternatives.length ? 'Keep comparing' : 'Continue reviewing'}
        </button>
      </div>
    </form>
  );
}
