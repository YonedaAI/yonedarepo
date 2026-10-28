import { useState } from 'react';

/** Runs one change at a time, then `after` (a reload); a failure becomes `error`. Resolves
 * true when the change succeeded. */
export function useChange(after: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(change: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await change();
      after();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
