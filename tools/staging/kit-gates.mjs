// Which items a run of the kit (tools/staging-realworld.mjs) runs, by its flags.

/** This week's features, run with `--feature-tests` and in a full run (feature-items.mjs). */
export const FEATURE_ITEMS = ['33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '46'];

/** A flag that runs a gate, and its items; the first flag given wins, then `--only`. */
const GATES = [
  ['feature-tests', () => ['0', '12', ...FEATURE_ITEMS, '17']],
  ['flight-path', () => ['0', '12', '43', '44', '17']],
  ['git-semantics', ({ ssh }) => ['0', '12', '13', '18', '21', '23', '27', '17', ...(ssh ? ['26'] : [])]],
  ['agent-hooks', () => ['0', '12', '28', '17']],
  ['memory-page', () => ['0', '12', '32', '17']],
  ['agents', () => ['0', '12', '29', '17']],
  ['ssh', () => ['0', '26']],
  ['visibility', () => ['0', '31']],
  ['orgs', () => ['0', '24']],
  ['lfs', () => ['0', '25']],
  ['model-check', () => ['0', 'model']],
  ['webhooks', () => ['0', 'hooks']],
  ['members', () => ['0', 'members']],
  ['forks', () => ['0', '22']],
  ['reads-sessions', () => ['0', 'reads']],
  ['browser', () => ['0', 'browser']],
];

/** The items named by `values`, or null for a full run. */
export function chosenItems(values) {
  const gate = GATES.find(([flag]) => values[flag]);
  if (gate) return new Set(gate[1](values));
  return values.only ? new Set(values.only.split(',')) : null;
}

/** A run of feature items alone is no full kit, so its evidence keeps out of what the prod guard
 * reads. */
export const featureRun = (only) => {
  const items = [...FEATURE_ITEMS, '45', 'f1'];
  return Boolean(only) && [...only].every((id) => ['0', '12', '17', ...items].includes(id)) && items.some((id) => only.has(id));
};

/**
 * A skip in the newest realworld evidence refuses a prod deploy (xtask/src/deploy_evidence.rs), so
 * a full run keeps the items behind an off switch out of it and lists them with the reason. Named
 * with --only or --feature-tests, they record their skip.
 */
const SWITCHED = ['34', '41', '43', '44'];
export function offSwitches(items, only) {
  const notRun = only ? [] : items.filter((i) => SWITCHED.includes(i.id) && i.status === 'skip').map(({ id, title, reason }) => ({ id, title, reason }));
  return { ran: items.filter((i) => !notRun.some((n) => n.id === i.id)), notRun };
}
