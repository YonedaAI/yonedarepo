// Host assertions consume bounded observations; candidate code never supplies verdicts.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';

export function checkTaskBoard(root, phase, variant) {
  if (!['build', 'extend', 'parallel', 'final'].includes(phase))
    throw new Error('Frozen guided phase required');
  if (phase === 'parallel' && !['filter', 'sort'].includes(variant))
    throw new Error('Frozen parallel variant required');
  if (phase !== 'parallel' && variant !== undefined)
    throw new Error('Only parallel checks accept a variant');
  root = resolve(root);
  const nonce = randomUUID();
  const tasks = [
    { id: `${nonce}:gamma`, title: 'Zulu design', completed: false },
    { id: `${nonce}:alpha`, title: 'Alpha review', completed: true },
    { id: `${nonce}:beta &?`, title: 'Beta DESIGN', completed: false },
  ];
  const calls = [];
  const expected = [];
  function call(name, method, args, verify) {
    calls.push({ method, args });
    expected.push({ name, verify });
  }
  const completed = tasks.map((task) =>
    task.id === tasks[2].id ? { ...task, completed: true } : task,
  );
  call('add_task', 'addTask', [tasks, 'New task', `${nonce}:new`], (value) =>
    equal(value, [...tasks, { id: `${nonce}:new`, title: 'New task', completed: false }]),
  );
  call('completion_keeps_identity', 'completeTask', [tasks, tasks[2].id], (value) =>
    equal(value, completed),
  );
  call('source_order', 'visibleTasks', [tasks, {}], (value) => equal(value, tasks));
  call('case_insensitive_search', 'visibleTasks', [tasks, { query: 'design' }], (value) =>
    equal(value, [tasks[0], tasks[2]]),
  );
  call('no_search_matches', 'visibleTasks', [tasks, { query: `${nonce} missing` }], (value) =>
    equal(value, []),
  );
  if (phase !== 'build') {
    const fragment = `#task=${encodeURIComponent(tasks[2].id)}`;
    call('bookmark_fragment', 'taskLink', [tasks[2]], (value) => value === fragment);
    call(
      'bookmark_after_completion_and_reorder',
      'resolveTaskLink',
      [[...completed].reverse(), fragment],
      (value) => equal(value, completed[2]),
    );
    call(
      'unknown_bookmark',
      'resolveTaskLink',
      [tasks, `#task=${nonce}:absent`],
      (value) => value === null,
    );
  }
  if (phase === 'final' || (phase === 'parallel' && variant === 'filter')) {
    for (const status of ['all', 'active', 'completed']) {
      const matches = tasks.filter(
        (task) => status === 'all' || task.completed === (status === 'completed'),
      );
      call(`status_${status}`, 'visibleTasks', [tasks, { status }], (value) =>
        equal(value, matches),
      );
    }
    call(
      'status_and_search',
      'visibleTasks',
      [tasks, { query: 'review', status: 'active' }],
      (value) => equal(value, []),
    );
  }
  if (phase === 'final' || (phase === 'parallel' && variant === 'sort')) {
    call('title_ascending', 'visibleTasks', [tasks, { sort: 'title-asc' }], (value) =>
      equal(value, [tasks[1], tasks[2], tasks[0]]),
    );
    call('title_descending', 'visibleTasks', [tasks, { sort: 'title-desc' }], (value) =>
      equal(value, [tasks[0], tasks[2], tasks[1]]),
    );
    call(
      'sort_and_search',
      'visibleTasks',
      [tasks, { query: 'design', sort: 'title-asc' }],
      (value) => equal(value, [tasks[2], tasks[0]]),
    );
  }
  if (phase === 'final')
    call(
      'both_enhancements_together',
      'visibleTasks',
      [tasks, { status: 'active', sort: 'title-asc', query: 'design' }],
      (value) => equal(value, [tasks[2], tasks[0]]),
    );
  const observer = fileURLToPath(new URL('./observe.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--permission',
      `--allow-fs-read=${root}`,
      `--allow-fs-read=${observer}`,
      observer,
      root,
    ],
    {
      input: JSON.stringify(calls),
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 256 * 1024,
      env: {},
    },
  );
  let observations;
  try {
    observations = JSON.parse(result.stdout);
  } catch {
    observations = null;
  }
  const protocol =
    result.status === 0 && Array.isArray(observations) && observations.length === calls.length;
  const checks = [{ name: 'isolated_module_protocol', status: protocol ? 'pass' : 'fail' }];
  for (let index = 0; index < expected.length; index++) {
    let pass = false;
    try {
      pass = protocol && expected[index].verify(observations[index]?.value) === true;
    } catch {
      /* Failed observation. */
    }
    checks.push({ name: expected[index].name, status: pass ? 'pass' : 'fail' });
  }
  let ui = false;
  try {
    const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');
    const app = readFileSync(resolve(root, 'public/app.mjs'), 'utf8');
    ui =
      /<html[\s>]/i.test(html) &&
      /<title[\s>]/i.test(html) &&
      /<meta[^>]*viewport/i.test(html) &&
      /<script[^>]*type=["']module["'][^>]*src=["']\/?app\.mjs["']/i.test(html) &&
      /(?:from\s*|import\s*)["']\.\/tasks\.mjs["']/.test(app) &&
      ['addTask', 'completeTask', 'visibleTasks'].every((name) =>
        new RegExp(`\\b${name}\\s*\\(`).test(app),
      );
  } catch {
    /* Missing UI files. */
  }
  checks.push({ name: 'ui_module_wiring', status: ui ? 'pass' : 'fail' });
  return {
    version: 1,
    phase,
    ...(phase === 'parallel' ? { variant } : {}),
    checks,
    pass: checks.every((check) => check.status === 'pass'),
    coverage: 'module behavior and static UI wiring; browser interaction requires separate review',
  };
}
