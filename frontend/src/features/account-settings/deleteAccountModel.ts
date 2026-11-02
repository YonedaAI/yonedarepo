// Deleting an account, as the dialog says it. The platform decides; this only words it.

export const CLOSURE_PATH = '/account/closure';
/** Where a deleted account lands: the public home, which says so once. */
export const DELETED_HOME = '/?deleted=1';

export type Closure = {
  account: string;
  handle: string | null;
  repos: number;
  credit_usd: number;
  undo_days: number;
  fresh: boolean;
  refusals: { reason: string; message: string }[];
};

/** Whether what was typed names the account. */
export const confirmMatches = (typed: string, expected: string) =>
  typed.trim().toLowerCase() === expected.toLowerCase();

/** What goes, one short line each. */
export function closureLines(closure: Pick<Closure, 'repos' | 'credit_usd'>) {
  const { repos, credit_usd: credit } = closure;
  return [
    ...(repos > 0
      ? [`${repos} ${repos === 1 ? 'repository' : 'repositories'}. Nobody can restore them.`]
      : []),
    'Your tokens, SSH keys, sessions and agents.',
    'Your place in other repositories and organizations.',
    ...(credit > 0
      ? [`$${credit.toFixed(2)} of credit. For a refund of what you paid, email us first.`]
      : []),
  ];
}

/** Whether the address says an account was just deleted; it says so once. */
export function takeDeleted() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (!params.has('deleted')) return false;
  params.delete('deleted');
  const rest = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
  return true;
}
