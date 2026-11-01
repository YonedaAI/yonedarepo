// The changes web-agents-flow.mjs commits from the browser: one that should fly, one sloppy, one
// that drifts from its flight plan. All invented code. `expect` is what a sensible reviewer would
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

const SLOPPY = lines(
  'export function total(items) {',
  "  console.log('items', items);",
  "  console.log('DEBUG total called');",
  '  // TODO: fix this later',
  '  // const old = items.reduce((a, b) => a + b.price, 0);',
  '  // return old;',
  '  const unused = items.length * 2;',
  '  const alsoUnused = items.map((i) => i.price);',
  '  let result = 0;',
  '  // loop over items',
  '  for (let i = 0; i < items.length; i++) {',
  '    // add price to result',
  '    result = result + items[i].price;',
  '  }',
  '  return result;',
  '}',
  '',
  '// total but again, copied so we have it',
  'export function total2(items) {',
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
  sloppy: {
    id: 'sloppy',
    path: SLOPPY_FILE,
    content: SLOPPY,
    message: 'Add a cart total',
    branch: 'sloppy-cart',
    goal: FIXED_GOAL,
    expect: { slop: 'medium or high', drift: 'low', outcome: 'go-around' },
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
  default: {
    id: 'default',
    path: 'src/payments-default.js',
    content: OFF_COURSE,
    message: 'Fix another README spelling mistake',
    branch: 'drift-default',
    goal: DRIFT_GOAL,
    expect: { drift: 'high', outcome: 'lands: nothing blocks by default' },
  },
};

/** The answer to the sloppy change's go-around: the same file, tidied, on its branch. */
export const FIX = {
  id: 'sloppy-fixed',
  path: SLOPPY_FILE,
  content: TIDY,
  message: 'Tidy the cart total',
  expect: { slop: 'low', drift: 'low', outcome: 'landed' },
};
