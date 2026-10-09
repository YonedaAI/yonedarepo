/** One failed team task does not imply all parallel attempts stopped. */
export function canCancelRun(run: Record<string, any>, activeAttempts: boolean) {
  if (['accepted', 'cancelled'].includes(run.status)) return false;
  return run.status !== 'failed' || activeAttempts || run.mode === 'collaborate';
}
