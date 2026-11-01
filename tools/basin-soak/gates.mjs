// What must hold before prod binds the change log (docs/load-testing.md, "Basin soak"), judged
// from the daily checks' evidence alone. Anything a check can't see is listed as for a person.
export const GATES = { days: 7, landings: 1000, repositories: 3, burst_landings: 1000, cost_month_usd: 5 };

/** People's parts: none of these can be read from a metric. */
export const BY_HAND = [
  'privacy.md names the stream: actor, branch name and commit id per landing, kept after an erase (the owner reviews it)',
  'A way to remove an erased repository from the table, or the owner accepts it: Basin SQL is read-only',
  'Unbinding on dev: landings, compaction and reads carry on, and no hold is left',
  'A compaction crossing while the stream is stopped, tested on dev: `compaction.stalled` stays quiet and the hold releases',
];

const dayOf = (check) => check.checked_at.slice(0, 10);

/** Each gate, passed or not, with what it saw. */
export function judgeGates(checks, { days: asked = GATES.days } = {}) {
  const passing = checks.filter((c) => c.summary.verdict === 'pass');
  const days = new Set(passing.map(dayOf));
  const landings = passing.reduce((n, c) => Math.max(n, c.summary.landings_in_log), 0);
  const repositories = passing.reduce((n, c) => Math.max(n, c.summary.repositories_compared), 0);
  const failing = checks.filter((c) => c.summary.verdict === 'fail');
  const dropped = checks.reduce((n, c) => n + (c.metrics?.dropped_total ?? 0), 0);
  const unread = checks.filter((c) => Object.keys(c.metrics?.unreadable ?? {}).length).length;
  const month = Math.max(0, ...checks.map((c) => c.metrics?.month_after_included_usd ?? 0));
  const gate = (name, passed, saw) => ({ name, passed, saw });
  return [
    gate(`${asked} days with a passing check`, days.size >= asked, `${days.size} days`),
    gate('No check failed', failing.length === 0, `${failing.length} of ${checks.length} failed`),
    gate(`At least ${GATES.landings} landings compared in one check`, landings >= GATES.landings, `${landings}`),
    gate(`At least ${GATES.repositories} repositories compared in one check`, repositories >= GATES.repositories, `${repositories}`),
    gate('No event dropped or undecodable', dropped === 0, `${dropped}`),
    gate('Every metric read', unread === 0, `${unread} checks with an unreadable source`),
    gate(`Under $${GATES.cost_month_usd} a month at dev's busiest day`, checks.length > 0 && unread === 0 && month < GATES.cost_month_usd, `$${month}`),
  ];
}
