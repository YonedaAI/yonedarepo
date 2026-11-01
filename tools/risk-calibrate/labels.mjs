// Ground truth from what happened after a landing, read from history alone.
// `reverted`: a later landing says it undoes this one. `fixed`: a later fix deleted lines this
// landing wrote (SZZ, Sliwerski, Zimmermann, Zeller 2005). Reverts are precise and rare; SZZ is
// plentiful and noisy, and a big landing owns more lines, so it leans toward size by construction.
import { git, pool } from './git.mjs';

export const REVERT_DAYS = 90;
export const FIX_DAYS = 30;
const DAY = 86400;
const MAX_FIX_FILES = 30;

const PR = /\(#(\d+)\)\s*$|^Merge pull request #(\d+)|^Merge PR #?(\d+)/;
const REVERT_SUBJECT = /^\s*\[?revert\]?(?:\([^)]*\))?!?[:\s]/i;
const QUOTED = /^\s*revert\s+"(.+)"/i;
const SHAS = /this reverts (?:commit )?([0-9a-f]{7,40})/gi;
const PR_REFS = /\brevert(?:s|ing|ed)?\b[^\n]*?(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;

/** A subject without its pull request tail or conventional prefix. */
export function normal(subject) {
  return subject
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/^\s*\[?revert\]?(?:\([^)]*\))?!?:\s*/i, '')
    .trim()
    .toLowerCase();
}

export const isRevert = (l) => REVERT_SUBJECT.test(l.subject) || /this reverts /i.test(l.body);

/** The earlier landing each revert names, by sha first, then pull request, then subject. */
export function markReverts(rows) {
  const bySha = new Map();
  const byPr = new Map();
  const bySubject = new Map();
  for (const [i, l] of rows.entries()) {
    bySha.set(l.sha, i);
    for (const c of l.brought) bySha.set(c, i);
    const m = l.subject.match(PR);
    if (m) byPr.set(m[1] ?? m[2] ?? m[3], i);
  }
  const prefixes = [...bySha.keys()];
  const shaFind = (text) => {
    const exact = bySha.get(text);
    if (exact !== undefined) return exact;
    if (text.length === 40) return undefined;
    const hit = prefixes.find((s) => s.startsWith(text));
    return hit === undefined ? undefined : bySha.get(hit);
  };
  for (const [i, l] of rows.entries()) {
    const text = `${l.subject}\n${l.body}`;
    const targets = new Set();
    let how = null;
    for (const m of text.matchAll(SHAS)) {
      const t = shaFind(m[1].toLowerCase());
      if (t !== undefined && t < i) {
        targets.add(t);
        how = 'sha';
      }
    }
    if (isRevert(l) && targets.size === 0) {
      const own = l.subject.match(PR)?.[1];
      for (const m of text.matchAll(PR_REFS)) {
        const t = m[1] !== own ? byPr.get(m[1]) : undefined;
        if (t !== undefined && t < i) {
          targets.add(t);
          how = 'pr';
        }
      }
    }
    if (isRevert(l) && targets.size === 0) {
      const quoted = l.subject.match(QUOTED)?.[1];
      const named = normal(quoted ?? l.subject);
      const t = bySubject.get(named);
      if (t !== undefined) {
        targets.add(t);
        how = 'subject';
      }
    }
    for (const t of targets) {
      const target = rows[t];
      target.revertedBy ??= { sha: l.sha, how, days: (l.at - target.at) / DAY };
    }
    bySubject.set(normal(l.subject), i);
  }
}

const FIX = /^(bug)?fix(es|ed)?\b|^hotfix\b|^fix(\([^)]*\))?!?:|\bfix(es|ed)?\b|\bbug\b|\bregression\b/i;
const NOT_A_FIX = /\b(typos?|spelling|docs?|documentation|lint|linter|format(ting)?|flaky|flake|ci|tests?|changelog|comments?)\b/i;
const NOT_CODE = /\.(md|mdx|rst|txt|adoc|json|lock|ya?ml|toml|snap|svg|png|jpe?g|gif)$|(^|\/)(test|tests|__tests__|testdata|docs?|examples?)\//i;
const COMMENT = /^\s*(\/\/|#|\*|\/\*|\*\/|$)/;

export const isFix = (l) => FIX.test(l.subject) && !NOT_A_FIX.test(l.subject) && !isRevert(l);

/** Old-side line numbers `git diff -U0` deletes in one file. */
async function deleted(dir, base, head, path) {
  const out = await git(dir, ['diff', '-U0', '-w', '--no-ext-diff', '--no-textconv', base, head, '--', path]);
  const ranges = [];
  for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)) {
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) ranges.push([Number(m[1]), count]);
  }
  return ranges;
}

async function blamed(dir, base, path, ranges) {
  const args = ['blame', '--first-parent', '-w', '-l', '-s'];
  for (const [start, count] of ranges) args.push('-L', `${start},+${count}`);
  const out = await git(dir, [...args, base, '--', path]).catch(() => '');
  const owners = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^\^?([0-9a-f]{39,40})\s+(?:\S+\s+)?\d*\)? ?(.*)$/);
    const text = line.slice(line.indexOf(') ') + 2);
    if (m && !COMMENT.test(text)) owners.add(m[1]);
  }
  return owners;
}

/** Marks each landing whose code a later fix deleted, within `FIX_DAYS`. */
export async function markFixes(dir, rows, limit = 6) {
  const bySha = new Map(rows.map((l, i) => [l.sha, i]));
  const shortShas = new Map(rows.map((l, i) => [l.sha.slice(0, 39), i]));
  const fixes = rows.filter((l) => isFix(l) && l.parents.length > 0 && l.fileCount <= MAX_FIX_FILES);
  await pool(fixes, limit, async (fix) => {
    const base = fix.parents[0];
    const names = await git(dir, ['diff', '--name-only', '--no-renames', base, fix.sha]);
    for (const path of names.split('\n').filter((p) => p && !NOT_CODE.test(p))) {
      const ranges = await deleted(dir, base, fix.sha, path);
      if (ranges.length === 0) continue;
      for (const owner of await blamed(dir, base, path, ranges)) {
        const i = bySha.get(owner) ?? shortShas.get(owner.slice(0, 39));
        if (i === undefined) continue;
        const target = rows[i];
        const days = (fix.at - target.at) / DAY;
        if (days >= 0 && days <= FIX_DAYS && target.sha !== fix.sha) {
          target.fixedBy ??= { sha: fix.sha, days };
        }
      }
    }
  });
  return fixes.length;
}
