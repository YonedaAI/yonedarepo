// The changes web-agents-flow.mjs commits from the browser: one that should fly, one with no plan,
// one sloppy, one that drifts from its flight plan. All invented code. `expect` is what a sensible reviewer would
// say, read against the runs afterwards.
const lines = (...text) => `${text.join('\n')}\n`;

export const SLOPPY_FILE = 'src/cart.js';
export const DRIFT_FILE = 'src/payments.js';

const CLEAN = lines(
  '/** How long to wait before retry `attempt` (from 0): doubles, and never passes `limitMs`. */',
  'export function backoffMs(attempt, baseMs = 100, limitMs = 5000) {',
  '  return Math.min(limitMs, baseMs * 2 ** attempt);',
  '}',
);

// Six or more medium readings on distinct lines: Slop reads high only from five (HIGH_LEVEL_FINDINGS).
const SLOPPY = lines(
  '// Returns the tax on an order.',
  'export function total(items) {',
  "  console.log('items', items);",
  "  console.log('DEBUG total called');",
  '  // TODO: fix this later',
  '  // const old = items.reduce((a, b) => a + b.price, 0);',
  '  // return old;',
  '  const unused = items.length * 2;',
  '  const alsoUnused = items.map((i) => i.price);',
  '  let result = 0;',
  '  // Sorts the items by name.',
  '  for (let i = 0; i < items.length; i++) {',
  '    // Removes the item from the cart.',
  '    result = result + items[i].price;',
  '  }',
  '  return result;',
  '}',
  '',
  '// Returns the tax on an order.',
  'export function total2(items) {',
  "  console.log('items', items);",
  '  // TODO: fix this later',
  '  // const old = items.reduce((a, b) => a + b.price, 0);',
  '  const unused = items.length * 2;',
  '  let result = 0;',
  '  for (let i = 0; i < items.length; i++) {',
  '    result = result + items[i].price;',
  '  }',
  '  return result;',
  '}',
  '',
  '// Returns the tax on an order.',
  'export function total3(items) {',
  "  console.log('items', items);",
  '  // TODO: fix this later',
  '  const unused = items.length * 2;',
  '  let result = 0;',
  '  for (let i = 0; i < items.length; i++) {',
  '    result = result + items[i].price;',
  '  }',
  '  return result;',
  '}',
);

const TIDY = lines(
  '/** The sum of `items` prices. */',
  'export function total(items) {',
  '  return items.reduce((sum, item) => sum + item.price, 0);',
  '}',
);

const OFF_COURSE = lines(
  '/** Charges a card and records the payment. */',
  'export async function charge(gateway, ledger, card, amountCents) {',
  '  const receipt = await gateway.charge({ card, amountCents });',
  '  await ledger.record({ id: receipt.id, amountCents });',
  '  return receipt.id;',
  '}',
  '',
  '/** Refunds a recorded payment in full. */',
  'export async function refund(gateway, ledger, id) {',
  '  await gateway.refund(id);',
  '  await ledger.reverse(id);',
  '}',
);

const NO_PLAN = lines(
  '/** `value`, held between `low` and `high`. */',
  'export function clamp(value, low, high) {',
  '  return Math.min(high, Math.max(low, value));',
  '}',
);

const CLEAN_GOAL = 'Add a backoffMs helper that doubles the wait on each retry and caps it at a limit';
const DRIFT_GOAL = 'Fix the spelling of "recieve" in the README';
export const FIXED_GOAL = 'Add a total() that sums item prices';

export const CASES = {
  clean: {
    id: 'clean',
    path: 'src/backoff.js',
    content: CLEAN,
    message: 'Add a capped backoff helper',
    branch: 'clean-backoff',
    goal: CLEAN_GOAL,
    expect: { slop: 'low', drift: 'low', outcome: 'landed' },
  },
  noplan: {
    id: 'noplan',
    path: 'src/clamp.js',
    content: NO_PLAN,
    message: 'Add a clamp helper',
    branch: 'no-plan-clamp',
    goal: '',
    expect: { slop: 'low', drift: 'no_plan', outcome: 'landed' },
  },
  sloppy: {
    id: 'sloppy',
    path: SLOPPY_FILE,
    content: SLOPPY,
    message: 'Add a cart total',
    branch: 'sloppy-cart',
    goal: FIXED_GOAL,
    expect: { slop: 'high', drift: 'low', outcome: 'go-around' },
  },
  drift: {
    id: 'drift',
    path: DRIFT_FILE,
    content: OFF_COURSE,
    message: 'Fix a README spelling mistake',
    branch: 'drift-readme',
    goal: DRIFT_GOAL,
    expect: { slop: 'low', drift: 'high', outcome: 'go-around' },
  },
  // Committed while automation is paused: nothing runs or fails until the resume.
  paused: {
    id: 'paused',
    path: 'src/paused.js',
    content: NO_PLAN.replaceAll('clamp', 'paused'),
    message: 'Add a helper during a pause',
    branch: 'during-a-pause',
    goal: CLEAN_GOAL,
    expect: { slop: 'low', drift: 'low', outcome: 'landed' },
  },
  // The same off-course work, with an owner who chose Never: an explicit setting wins.
  never: {
    id: 'never',
    path: 'src/payments-never.js',
    content: OFF_COURSE,
    message: 'Fix another README spelling mistake',
    branch: 'drift-never',
    goal: DRIFT_GOAL,
    expect: { drift: 'high', outcome: 'landed' },
  },
};

/** The answer to the sloppy change's go-around: the same file, tidied, on its branch. */
export const FIX = {
  id: 'sloppy-fixed',
  path: SLOPPY_FILE,
  content: TIDY,
  message: 'Tidy the cart total',
  // A Landing keeps the title of the commit that opened it.
  landing: 'Add a cart total',
  expect: { slop: 'low', drift: 'low', outcome: 'landed' },
};
