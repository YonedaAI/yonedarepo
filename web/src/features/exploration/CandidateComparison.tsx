import { useState } from 'react';
import { short } from '../../lib/api';
import { SourceDiff } from './SourceDiff';
export function CandidateComparison({ candidates }: { candidates: Record<string, any>[] }) {
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  return (
    <section className="candidate-comparison" aria-label="Code comparison">
      <h2>Compare captured changes</h2>
      <p>
        Each diff is against this run's frozen base. These are captured revisions, not agent
        summaries.
      </p>
      <div className="comparison-columns">
        {[
          { value: left, set: setLeft, fallback: 0, label: 'First approach' },
          { value: right, set: setRight, fallback: 1, label: 'Second approach' },
        ].map((side) => {
          const candidate =
            candidates.find((c) => c.id === side.value) ?? candidates[side.fallback];
          return (
            <div key={side.label}>
              <label>
                {side.label}
                <select value={candidate?.id ?? ''} onChange={(e) => side.set(e.target.value)}>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.strategy} — {short(c.revision.commit)}
                    </option>
                  ))}
                </select>
              </label>
              {candidate && <SourceDiff diff={candidate.diff} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}
