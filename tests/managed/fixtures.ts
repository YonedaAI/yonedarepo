// Fixture changes for each managed agent: one that should trigger its findings and one that
// should not, with the finding a correct reviewer reports. Local tests feed `expected` through
// the harness double (no model runs); the live model evaluation runs each agent's configured
// model on the same diffs and compares against `expected`, which is how a default model earns
// its place (the cheapest one that passes). All code here is invented.
import type { ManagedAgentId } from '../../shared/managed-agents';

export interface Fixture {
  files: { path: string; patch: string }[];
  /** What a correct reviewer reports: at least these anchors for `trigger`, none for `clean`. */
  expected: { path: string; line: number; severity: 'high' | 'medium' | 'low'; title: string; why: string }[];
}

const patch = (start: number, lines: string[]) =>
  [`@@ -${start},${lines.filter((l) => !l.startsWith('+')).length} +${start},${lines.filter((l) => !l.startsWith('-')).length} @@`, ...lines].join('\n');

export const FIXTURES: Record<ManagedAgentId, { trigger: Fixture; clean: Fixture }> = {
  'code-review': {
    trigger: {
      files: [
        {
          path: 'src/batch.js',
          patch: patch(1, [
            ' export function lastN(items, n) {',
            '-  return items.slice(-n);',
            '+  const out = [];',
            '+  for (let i = items.length - n; i <= items.length; i++) out.push(items[i]);',
            '+  return out;',
            ' }',
          ]),
        },
      ],
      expected: [
        { path: 'src/batch.js', line: 3, severity: 'high', title: 'Loop reads one past the end', why: 'i <= items.length pushes undefined as the last element.' },
      ],
    },
    clean: {
      files: [
        {
          path: 'src/batch.js',
          patch: patch(1, [
            '-export function lastN(items, n) {',
            '-  return items.slice(-n);',
            '+export function lastN(items, count) {',
            '+  return items.slice(-count);',
            ' }',
          ]),
        },
      ],
      expected: [],
    },
  },
  'security-review': {
    trigger: {
      files: [
        {
          path: 'src/users.js',
          patch: patch(1, [
            ' export function find(db, id) {',
            "-  return db.query('SELECT * FROM users WHERE id = ?', [id]);",
            "+  const sql = 'SELECT * FROM users WHERE id = ' + id;",
            '+  return db.query(sql);',
            ' }',
            '+export const VERSION = 2;',
          ]),
        },
      ],
      expected: [
        { path: 'src/users.js', line: 2, severity: 'high', title: 'SQL injection through id', why: 'id is concatenated into the query instead of bound as a parameter.' },
      ],
    },
    clean: {
      files: [
        {
          path: 'src/users.js',
          patch: patch(1, [
            ' export function find(db, id) {',
            "-  return db.query('SELECT * FROM users WHERE id = ?', [id]);",
            "+  return db.query('SELECT id, name FROM users WHERE id = ?', [id]);",
            ' }',
          ]),
        },
      ],
      expected: [],
    },
  },
  'slop-review': {
    trigger: {
      files: [
        {
          path: 'src/cart.ts',
          patch: patch(10, [
            ' export function total(items: Item[]) {',
            "+  console.log('items', items);",
            '+  // TODO: fix this later',
            '+  // const old = items.reduce((a, b) => a + b.price, 0);',
            '   return items.reduce((sum, item) => sum + item.price, 0);',
            ' }',
          ]),
        },
      ],
      expected: [
        { path: 'src/cart.ts', line: 11, severity: 'medium', title: 'Debug logging left in', why: 'console.log prints every cart to the console.' },
        { path: 'src/cart.ts', line: 12, severity: 'low', title: 'TODO without an owner', why: 'Nobody owns this note, so it will stay.' },
      ],
    },
    clean: {
      files: [
        {
          path: 'src/cart.ts',
          patch: patch(10, [
            ' export function total(items: Item[]) {',
            '-  return items.reduce((a, b) => a + b.price, 0);',
            '+  return items.reduce((sum, item) => sum + item.price, 0);',
            ' }',
          ]),
        },
      ],
      expected: [],
    },
  },
};
