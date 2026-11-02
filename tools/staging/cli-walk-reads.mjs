// Kit item 48: the server-side reads on a repository whose history the walk wrote, so each answer
// is compared with what is known to be there, and `--at` with what was there then.
import assert from 'node:assert/strict';

const lines = (text) => text.split('\n').filter(Boolean);
const at = (tree, version) => ['--at', String(version ?? tree.version.a)];

async function logRows(w, me, tree) {
  const repo = ['--repo', tree.id];
  await w.row('log (--repo --origin, outside a clone)', async () => {
    const ran = await me.ok(['log', ...repo, '--origin', w.api]);
    const first = lines(ran.stdout)[0];
    assert.match(first, new RegExp(`^${tree.b3} v\\d+ By name$`), first);
    assert.ok(lines(ran.stdout).some((l) => l.startsWith(tree.a)), 'the first commit is missing');
    const out = await me.j(['log', ...repo]);
    assert.equal(out.commits?.[0]?.commit ?? out.entries?.[0]?.commit, tree.b3, JSON.stringify(out).slice(0, 200));
  });
  await w.row('log (in a clone)', async () => {
    assert.ok((await me.ok(['log'], { cwd: tree.dir })).stdout.startsWith(tree.b3), 'the clone is not the default repository');
  });
  await w.row('log <path>', async () => {
    const ran = await me.ok(['log', 'src/app/main.rs', ...repo]);
    assert.deepEqual(lines(ran.stdout).map((l) => l.split(' ')[0]), [tree.b, tree.a], ran.stdout);
  });
  await w.row('log --ref', async () => {
    assert.ok((await me.ok(['log', '--ref', 'topic', ...repo])).stdout.startsWith(tree.t), 'not the branch');
  });
  await w.row('log --limit', async () => {
    assert.equal(lines((await me.ok(['log', '--limit', '1', ...repo])).stdout).length, 1);
  });
  await w.row('log --at', async () => {
    const ran = await me.ok(['log', ...repo, ...at(tree)]);
    assert.ok(ran.stdout.startsWith(tree.a), `at ${tree.version.a}: ${ran.stdout}`);
    assert.ok(!ran.stdout.includes(tree.b), 'a later commit showed');
    await me.refused(['log', '--at', 'soon'], 64, /--at must be a number/);
  });
}

async function grepRows(w, me, tree) {
  const repo = ['--repo', tree.id];
  await w.row('grep <query>', async () => {
    const ran = await me.ok(['grep', 'walker', ...repo]);
    assert.match(ran.stdout, /^src\/app\/main\.rs:6: .*Hello walker, again/m, ran.stdout);
    assert.ok(!ran.stdout.includes('docs/guide.md'), `a case-sensitive grep matched Walker: ${ran.stdout}`);
    assert.deepEqual((await me.j(['grep', 'walker', ...repo])).results.map((r) => r.path).sort(), ['README.md', 'src/app/main.rs']);
  });
  await w.row('grep -i', async () => {
    assert.match((await me.ok(['grep', 'WALKER', '-i', ...repo])).stdout, /^docs\/guide\.md:3: Walker notes\.$/m);
  });
  await w.row('grep -w, --word', async () => {
    for (const flag of ['-w', '--word']) {
      assert.equal((await me.ok(['grep', 'walk', flag, ...repo])).stdout, '', `${flag} matched inside a word`);
      assert.match((await me.ok(['grep', 'walker', flag, ...repo])).stdout, /main\.rs/, flag);
    }
  });
  await w.row('grep --ignore-case', async () => {
    assert.match((await me.ok(['grep', 'WALKER', '--ignore-case', ...repo])).stdout, /guide\.md/);
  });
  await w.row('grep --path', async () => {
    const ran = await me.ok(['grep', 'walker', '-i', '--path', 'docs', ...repo]);
    assert.ok(ran.stdout && lines(ran.stdout).every((l) => l.startsWith('docs/')), ran.stdout);
  });
  await w.row('grep --at', async () => {
    const then = await me.ok(['grep', 'again', ...repo, ...at(tree)]);
    assert.equal(then.stdout, '', `the older version matched: ${then.stdout}`);
    assert.match((await me.ok(['grep', 'again', ...repo])).stdout, /main\.rs/, 'the head did not match');
  });
}

async function searchRows(w, me, tree) {
  const repo = ['--repo', tree.id];
  const search = (...args) => me.j(['search', ...args, ...repo]);
  await w.row('search <query>', async () => {
    const out = await search('walker');
    assert.ok(JSON.stringify(out).includes('main.rs'), JSON.stringify(out).slice(0, 300));
    assert.ok((await me.ok(['search', 'walker', ...repo])).stdout.includes('main.rs'), 'the text lacks the hit');
  });
  await w.row('search --in', async () => {
    const out = await search('First commit', '--in', 'commits');
    assert.deepEqual(out.groups, ['commits']);
    assert.deepEqual(out.commits.results.map((c) => c.commit), [tree.a], JSON.stringify(out).slice(0, 300));
    assert.deepEqual(out.code, [], 'a group it was not asked for answered');
  });
  await w.row('search --limit', async () => {
    assert.equal((await search('walker')).code.length, 2, 'two files hold the word');
    assert.equal((await search('walker', '--limit', '1')).code.length, 1, '--limit did not cut it');
  });
  await w.row('search --path', async () => {
    const text = JSON.stringify(await search('walker', '--path', 'src'));
    assert.ok(text.includes('src/app/main.rs') && !text.includes('docs/guide.md'), text.slice(0, 300));
  });
  await w.row('search -w, --word', async () => {
    assert.ok(!JSON.stringify(await search('walk', '-w', '--in', 'code')).includes('main.rs'), '-w matched inside a word');
    assert.ok(JSON.stringify(await search('walker', '--word', '--in', 'code')).includes('main.rs'), '--word lost the hit');
  });
  await w.row('search --ref', async () => {
    assert.ok(JSON.stringify(await search('Only on topic', '--in', 'code', '--ref', 'topic')).includes('docs/topic.md'), 'not on the branch');
    assert.ok(!JSON.stringify(await search('Only on topic', '--in', 'code')).includes('docs/topic.md'), 'main has it');
  });
  await w.row('search --at', async () => {
    assert.ok(!JSON.stringify(await search('again', '--in', 'code', ...at(tree))).includes('main.rs'), 'the older version matched');
  });
}

async function searchAllRows(w, me, tree) {
  const unique = `walker${w.ts}`;
  const dir = tree.dir;
  await me.gitOk(dir, 'pull', '-q', 'origin', 'main');
  await me.commit(dir, { 'docs/needle.md': `The ${unique} needle\n` }, `Needle ${unique}`);
  await me.gitOk(dir, 'push', '-q', 'origin', 'main');
  let first;
  await w.row('search --all', async () => {
    first = await w.soon(async () => {
      const out = await me.j(['search', unique, '--all']);
      return JSON.stringify(out).includes(tree.id) && out;
    }, 'the word in search --all');
    assert.ok(!JSON.stringify(first).includes('[secret]'));
  });
  await w.row('search --all --in --limit --word', async () => {
    await w.soon(async () => JSON.stringify(await me.j(['search', unique, '--all', '--in', 'code', '--limit', '1', '--word'])).includes('needle.md'), 'the word in the code group');
    const none = JSON.stringify(await me.j(['search', unique.slice(0, -3), '--all', '--in', 'code', '--word']));
    assert.ok(!none.includes('needle.md'), '--word matched inside a word');
    await me.refused(['search', 'x', '--all', '--repo', tree.id], 64, /--all goes with search/);
  });
  await w.row('search --all --after', async () => {
    const page = await me.j(['search', 'walker', '--all', '-w']);
    const next = page.next;
    if (!next) return 'one page: no next to walk';
    const after = await me.j(['search', 'walker', '--all', '-w', '--after', String(next)]);
    assert.notDeepEqual(after, page, '--after answered the same page');
    return 'second page read';
  });
}

async function blameRows(w, me, tree) {
  const repo = ['--repo', tree.id];
  await w.row('blame <path>', async () => {
    const { blame } = await me.j(['blame', 'src/app/main.rs', ...repo]);
    const text = JSON.stringify(blame);
    assert.ok(text.includes(tree.b) && text.includes(tree.a), `both commits should own lines: ${text.slice(0, 300)}`);
    const row = (blame.lines ?? blame.hunks ?? []).find((l) => (l.text ?? '').includes('Hello walker'));
    assert.equal(row?.commit, tree.b, `line 6 is not the second commit's: ${JSON.stringify(row)}`);
  });
  await w.row('blame and symbols print text, not a JSON dump', async () => {
    for (const args of [['blame', 'README.md'], ['symbols', 'src/app/main.rs']]) {
      const ran = await me.ok([...args, ...repo]);
      assert.doesNotMatch(ran.stdout, /^\{/, `yoneda ${args[0]} prints raw JSON for a person: ${ran.stdout.slice(0, 80)}`);
    }
  });
  await w.row('blame --ref', async () => {
    assert.ok((await me.ok(['blame', 'docs/topic.md', '--ref', 'topic', ...repo])).stdout.includes('Only on topic'));
  });
  await w.row('blame --at', async () => {
    const ran = await me.ok(['blame', 'src/app/main.rs', ...repo, ...at(tree)]);
    assert.ok(!ran.stdout.includes('again') && !ran.stdout.includes(tree.b.slice(0, 7)), ran.stdout);
  });
}

async function diffRows(w, me, tree) {
  const repo = ['--repo', tree.id];
  await w.row('diff <base> <head>', async () => {
    const ran = await me.ok(['diff', tree.a, tree.b, ...repo]);
    assert.match(ran.stdout, /^\+.*Hello walker, again/m, ran.stdout);
    assert.match(ran.stdout, /^-.*Hello walker"/m, ran.stdout);
    assert.deepEqual((await me.j(['diff', tree.a, tree.b, ...repo])).changes.map((c) => c.path), ['src/app/main.rs']);
  });
  await w.row('diff names the files it shows', async () => {
    const ran = await me.ok(['diff', tree.a, tree.t, ...repo]);
    assert.match(ran.stdout, /docs\/topic\.md/, `the diff names no file: ${ran.stdout.slice(0, 120)}`);
  });
  await w.row('diff (no arguments)', async () => {
    const ran = await me.ok(['diff', ...repo]);
    assert.match(ran.stdout, /^\+The walker\d+ needle$/m, `not main's newest commit: ${ran.stdout.slice(0, 120)}`);
  });
  await w.row('diff --path', async () => {
    const out = await me.j(['diff', tree.a, tree.t, '--path', 'docs', ...repo]);
    assert.deepEqual(out.changes.map((c) => c.path), ['docs/topic.md']);
  });
  await w.row('diff --at', async () => {
    const ran = await me.y(['diff', tree.a, tree.a, ...repo, ...at(tree)]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.ok(!ran.stdout.includes('again'), ran.stdout);
  });
}

async function symbolRows(w, me, tree) {
  const repo = ['--repo', tree.id];
  await w.row('symbols <path>', async () => {
    const text = JSON.stringify((await me.j(['symbols', 'src/app/main.rs', ...repo])).symbols);
    assert.ok(text.includes('main') && text.includes('helper'), text.slice(0, 200));
  });
  await w.row('symbols --at', async () => {
    const dir = tree.dir;
    await me.commit(dir, { 'src/lib/util.rs': 'pub fn util() -> u32 {\n    7\n}\n\npub fn later() {}\n' }, 'Later');
    await me.gitOk(dir, 'push', '-q', 'origin', 'main');
    assert.match((await me.ok(['symbols', 'src/lib/util.rs', ...repo])).stdout, /later/);
    assert.doesNotMatch((await me.ok(['symbols', 'src/lib/util.rs', ...repo, ...at(tree)])).stdout, /later/, 'a later symbol showed');
  });
}

export async function readRows(w, me, tree) {
  await logRows(w, me, tree);
  await grepRows(w, me, tree);
  await searchRows(w, me, tree);
  await searchAllRows(w, me, tree);
  await blameRows(w, me, tree);
  await diffRows(w, me, tree);
  await symbolRows(w, me, tree);
}
