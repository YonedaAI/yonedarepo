#!/usr/bin/env node
// Scores real landings with the platform's own Risk code and labels what happened to them.
//   cargo build --release -p yoneda-platform --example compute_lines
//   node tools/risk-calibrate/walk.mjs <bare clone> <out.jsonl> [newest N landings]
// Never point it at this repository: test data is imported open-source history.
import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Blobs, Compute, git } from './git.mjs';
import { isFix, isRevert, markFixes, markReverts } from './labels.mjs';
import { landings, measure } from './landings.mjs';

const [dir, out, limit = '5000'] = process.argv.slice(2);
if (!dir || !out) throw new Error('walk.mjs <bare clone> <out.jsonl> [newest N landings]');
const binary = process.env.COMPUTE_LINES ?? resolve('target/release/examples/compute_lines');

const branch = (await git(dir, ['symbolic-ref', '--short', 'HEAD'])).trim();
const rows = await landings(dir, branch, Number(limit));
const blobs = new Blobs(dir);
const compute = new Compute(binary);
const cache = new Map();
const started = Date.now();
for (const [i, landing] of rows.entries()) {
  Object.assign(landing, await measure(dir, landing, blobs, compute, cache));
  if ((i + 1) % 500 === 0) {
    const seconds = Math.round((Date.now() - started) / 1000);
    console.error(`${basename(dir)}: ${i + 1}/${rows.length} scored, ${seconds}s`);
  }
}
blobs.close();
compute.close();

markReverts(rows);
const fixes = await markFixes(dir, rows);
const newest = rows.at(-1)?.at ?? 0;
const lines = rows.map((l) =>
  JSON.stringify({
    repo: basename(dir),
    sha: l.sha,
    at: l.at,
    age_days: (newest - l.at) / 86400,
    subject: l.subject,
    author: l.author,
    score: l.score,
    level: l.level,
    points: l.points,
    classes: l.classes,
    unclassified: l.unclassified,
    unread: l.unread,
    commits: l.brought.length,
    files: l.fileCount,
    lines: l.lines,
    is_revert: isRevert(l),
    is_fix: isFix(l),
    reverted: l.revertedBy ?? null,
    fixed: l.fixedBy ?? null,
  }),
);
writeFileSync(out, `${lines.join('\n')}\n`);
const reverted = rows.filter((l) => l.revertedBy).length;
const fixed = rows.filter((l) => l.fixedBy).length;
console.error(
  `${basename(dir)}: ${rows.length} landings, ${reverted} reverted, ${fixes} fixes, ${fixed} fixed-later`,
);
