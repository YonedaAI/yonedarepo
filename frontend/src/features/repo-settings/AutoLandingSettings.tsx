// Settings → Landing rules: the repository's two automatic Landings switches, both off until
// the owner turns them on. They live beside the policy, not in it (`PUT /auto-landings`), so
// each saves at once and no recorded check is voided.
import { useState } from 'react';
import type { AutoLandings } from '../../../../shared/contracts/repo-status';
import { Failure } from '../source-platform/SourceStatus';
import { sourceApi } from '../source-platform/sourceApi';

export const autoLandingsRequest = (repo: string, body: Partial<AutoLandings>) => ({
  path: `/repos/${repo}/auto-landings`,
  method: 'PUT' as const,
  body,
});

export function AutoLandingSettings({
  repo,
  landings,
  onChanged,
}: {
  repo: string;
  landings: AutoLandings;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function set(body: Partial<AutoLandings>) {
    setBusy(true);
    setError('');
    try {
      const { path, ...request } = autoLandingsRequest(repo, body);
      await sourceApi(path, request);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="auto-landings-heading">
      <h3 id="auto-landings-heading">Automatic Landings</h3>
      <fieldset className="source-checks" disabled={busy}>
        <legend className="sr-only">Automatic Landings</legend>
        <label>
          <input
            type="checkbox"
            checked={landings.create}
            onChange={(e) => set({ create: e.target.checked })}
          />
          <span>
            Open a Landing for every pushed branch
            <small className="subtle">
              Costs nothing and starts no agent. Skips main, release and fork branches. A Landing
              someone closed stays closed until reopened.
            </small>
          </span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={landings.agents}
            disabled={!landings.create}
            onChange={(e) => set({ agents: e.target.checked })}
          />
          <span>
            Run agents on automatic Landings
            <small className="subtle">
              The agents set up on this repository run on them, at their usual price. Off, they run
              only on Landings someone opened on purpose.
            </small>
          </span>
        </label>
      </fieldset>
      {error && <Failure error={error} />}
    </section>
  );
}
