#!/usr/bin/env node
// Public kit evidence. A kit run's full evidence names accounts and repositories and stays on
// the runner; what leaves it is this minimal pass table: each item's id, title, status and time,
// the tree and item 0's revisions, which are all the prod guard reads
// (xtask/src/deploy_evidence.rs). Allowed fields only, so a new metric can never leak.
//   node tools/ship/evidence.mjs <out dir>       writes <out dir>/realworld-<tree>.json; fails unless every item passed
//   node tools/ship/evidence.mjs --table <prefix>   only the pass table of the newest <prefix>-*.json
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STAGING = '.local/staging';
const OBJECT_ID = /^[0-9a-f]{40}$/;

/** The newest `<prefix>-*.json` in `dir`, parsed. */
export function newest(dir, prefix) {
  const files = readdirSync(dir)
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.json'))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files.length) throw new Error(`No ${prefix}-*.json evidence in ${dir}`);
  return JSON.parse(readFileSync(files[0], 'utf8'));
}

/** The allowed fields of one evidence file. */
export function minimal(evidence) {
  const revision = (item, name) => {
    const value = item.metrics?.[name];
    if (!OBJECT_ID.test(value ?? '')) throw new Error(`Item 0 has no ${name} revision`);
    return value;
  };
  if (!OBJECT_ID.test(evidence.tree ?? '')) throw new Error('The evidence records no tree');
  return {
    schema: evidence.schema,
    tree: evidence.tree,
    recorded_at: evidence.recorded_at,
    items: evidence.items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      ms: item.ms,
      metrics: item.id === '0' ? { front: revision(item, 'front'), platform: revision(item, 'platform') } : {},
    })),
  };
}

export const allPassed = (evidence) => evidence.items.length > 0 && evidence.items.every((item) => item.status === 'pass');

/** The pass table of evidence that may not have a tree (a prod smoke's, or a failed run's). */
export function table(evidence) {
  const rows = evidence.items.map((item) => `| ${item.id} | ${item.title} | ${item.status} | ${(item.ms / 1000).toFixed(1)} s |`);
  const passed = evidence.items.filter((item) => item.status === 'pass').length;
  return [`### Kit: ${passed} of ${evidence.items.length} passed`, '', '| # | Item | Result | Time |', '|---|---|---|---|', ...rows, ''].join('\n');
}

function summary(evidence) {
  console.log(table(evidence));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table(evidence)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [first, second] = process.argv.slice(2);
  if (first === '--table') summary(newest(STAGING, second));
  else {
    const full = newest(STAGING, 'realworld');
    summary(full);
    if (!allPassed(full)) {
      console.log('::error::Not every kit item passed: no evidence uploaded.');
      process.exit(1);
    }
    const public_ = minimal(full);
    mkdirSync(first, { recursive: true });
    writeFileSync(join(first, `realworld-${public_.tree}.json`), `${JSON.stringify(public_, null, 2)}\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tree=${public_.tree}\n`);
  }
}
