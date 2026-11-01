// One landing per first-parent commit, measured the way the platform measures a head: the
// commits the head brings over its base (`change_instruments.rs`), each with its recorded class
// (`repo-classify.ts`), and the head's diff against the merge base (`repo-instruments.ts`).
import { git } from './git.mjs';

const SEP = '\u0001';
const END = '\u0002';

/** The walks and budgets of the platform, so a dry run reads what a real head would. */
const WALK = 256; // land_gates.rs
const CLASSIFY_COMMITS = 32; // repo-classify.ts: a longer push is left alone
const CLASSIFIED_FILES = 200; // repo-code.ts: past it, `unknown` with nothing read
const CLASSIFY_BYTES = 8 * 1024 * 1024; // repo-classify.ts: past it, no class
const PATCH_FILES = 200; // repo-diff.ts: past it, no line counts

/** The newest `limit` landings of `branch`, oldest first. */
export async function landings(dir, branch, limit) {
  const format = ['%H', '%P', '%T', '%ct', '%an', '%s', '%b'].join(SEP) + END;
  const out = await git(dir, [
    'log',
    '--first-parent',
    `--format=${format}`,
    `-n${limit}`,
    branch,
  ]);
  const rows = out
    .split(END)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha, parents, tree, at, author, subject, body] = r.split(SEP);
      return {
        sha,
        parents: parents.split(' ').filter(Boolean),
        tree,
        at: Number(at),
        author,
        subject,
        body: body ?? '',
      };
    });
  return rows.reverse();
}

/** Base and head of a landing: a merge lands its second parent over its merge base, anything
 * else is one commit over its parent. */
async function ends(dir, landing) {
  const [first, second] = landing.parents;
  if (!second) return { base: first ?? null, head: landing.sha };
  const out = await git(dir, ['merge-base', first, second]).catch(() => '');
  return { base: out.trim() || null, head: second };
}

/** Commits the head brings, parents first, and whether the platform's walk could read them. */
async function brought(dir, base, head) {
  if (!base) return { commits: [head], unread: false };
  const out = await git(dir, ['rev-list', '--reverse', '--parents', `${base}..${head}`]);
  const rows = out.trim().split('\n').filter(Boolean);
  const merge = rows.some((r) => r.split(' ').length > 2);
  return {
    commits: rows.map((r) => r.split(' ')[0]),
    unread: merge || rows.length > WALK,
  };
}

const MODES = { 100644: 'blob', 100755: 'exec', 120000: 'symlink' };
const ZERO = /^0+$/;

/** A commit's touches, as the authority records them. */
async function touches(dir, commit) {
  const out = await git(dir, [
    'diff-tree', '-r', '--root', '--no-commit-id', '--no-renames', '--raw', '--abbrev=40', '-z', commit,
  ]);
  const parts = out.split('\0');
  const list = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, oldId, newId] = parts[i].slice(1).split(' ');
    list.push({
      path: parts[i + 1],
      old: ZERO.test(oldId) ? null : oldId,
      new: ZERO.test(newId) ? null : newId,
      mode: ZERO.test(newId) ? null : (MODES[newMode] ?? 'other'),
      submodule: oldMode === '160000' || newMode === '160000',
    });
  }
  return list;
}

/** The commit's class from the platform's classifier, null where the platform records none. */
async function classOf(dir, commit, blobs, compute, cache) {
  const known = cache.get(commit);
  if (known !== undefined) return known;
  const list = await touches(dir, commit);
  let answer;
  if (list.length > CLASSIFIED_FILES || list.some((t) => t.submodule)) {
    answer = 'unknown';
  } else {
    const contents = {};
    let bytes = 0;
    for (const id of new Set(list.flatMap((t) => [t.old, t.new].filter(Boolean)))) {
      const blob = await blobs.read(id);
      if (!blob) continue;
      bytes += blob.length;
      contents[id] = blob.toString('base64');
    }
    if (bytes > CLASSIFY_BYTES) answer = null;
    else {
      const changes = list.map(({ path, old, mode, new: side }) => ({ path, old, new: side, mode }));
      const out = await compute.call({ op: 'review_classes', changes, blobs: contents });
      answer = out.overall ?? null;
    }
  }
  cache.set(commit, answer);
  return answer;
}

async function commitFacts(dir, read, blobs, compute, cache) {
  const facts = { classes: {}, unclassified: 0, unread: read.unread };
  if (read.commits.length > CLASSIFY_COMMITS) {
    facts.unclassified = read.commits.length;
    return facts;
  }
  for (const commit of read.commits) {
    const name = await classOf(dir, commit, blobs, compute, cache);
    if (name === null) facts.unclassified += 1;
    else facts.classes[name] = (facts.classes[name] ?? 0) + 1;
  }
  return facts;
}

/** The head's diff with exact renames, as `tree_diff` pairs them. */
async function fileFacts(dir, base, head) {
  const out = await git(dir, [
    'diff', '--numstat', '-z', '-M100%', '--no-ext-diff', '--no-textconv', base, head,
  ]);
  const parts = out.split('\0');
  const files = [];
  for (let i = 0; i < parts.length && parts[i]; i += 1) {
    const [added, removed, path] = parts[i].split('\t');
    const lines = added === '-' ? {} : { additions: Number(added), deletions: Number(removed) };
    if (path) files.push({ path, ...lines });
    else {
      files.push({ path: parts[i + 2], old_path: parts[i + 1], ...lines });
      i += 2;
    }
  }
  return files.map((f, n) =>
    n < PATCH_FILES ? f : { path: f.path, ...(f.old_path ? { old_path: f.old_path } : {}) },
  );
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Scores one landing with the platform's own `change_instruments`. */
export async function measure(dir, landing, blobs, compute, cache) {
  const { base, head } = await ends(dir, landing);
  const read = await brought(dir, base, head);
  const commits = await commitFacts(dir, read, blobs, compute, cache);
  const files = await fileFacts(dir, base ?? EMPTY_TREE, head);
  const facts = {
    number: 0,
    heads: [{
      commit: landing.sha,
      tree: landing.tree,
      at: landing.at,
      compared: { base_tree: null },
      commits,
      open_findings: 0,
      checks: [],
    }],
  };
  const out = await compute.call({ op: 'change_instruments', facts, files: [files] });
  const risk = out.heads[0].risk;
  const points = Object.fromEntries(risk.reasons.map((r) => [r.input, r.points]));
  const lines = files.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0);
  return {
    score: risk.score,
    level: risk.level,
    points,
    classes: commits.classes,
    unclassified: commits.unclassified,
    unread: commits.unread,
    brought: read.commits,
    fileCount: files.length,
    lines,
  };
}
