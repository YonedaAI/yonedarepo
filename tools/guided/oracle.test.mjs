import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { checkTaskBoard } from '../../fixtures/guided-task-board/oracle/check.mjs';
import {
  starterFiles,
  profile,
  protectedBundle,
  guidedPolicy,
  guidedProfile,
  root,
} from './profile.mjs';

// Offline module controls, not an app fixture, agent result or context-benefit measurement.
const baseline = `
export const addTask=(tasks,title,id)=>[...tasks,{id,title,completed:false}];
export const completeTask=(tasks,id)=>tasks.map(t=>t.id===id?{...t,completed:true}:t);
export const visibleTasks=(tasks,options={})=>tasks.filter(t=>t.title.toLowerCase().includes((options.query??'').toLowerCase()));
`;
const links = `
export const taskLink=t=>'#task='+encodeURIComponent(t.id);
export const resolveTaskLink=(tasks,fragment)=>tasks.find(t=>taskLink(t)===fragment)??null;
`;
function control(module, fn) {
  const directory = mkdtempSync(resolve(tmpdir(), 'guided-oracle-'));
  mkdirSync(resolve(directory, 'public'));
  writeFileSync(resolve(directory, 'public/tasks.mjs'), module);
  writeFileSync(
    resolve(directory, 'public/index.html'),
    '<html><title>Control</title><meta name="viewport"><script type="module" src="/app.mjs"></script></html>',
  );
  writeFileSync(
    resolve(directory, 'public/app.mjs'),
    "import {addTask,completeTask,visibleTasks} from './tasks.mjs';\nexport const add=(a,b,c)=>addTask(a,b,c);export const done=(a,b)=>completeTask(a,b);export const view=(a,b)=>visibleTasks(a,b);",
  );
  try {
    return fn(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const filtering = baseline.replace(
  'tasks.filter(t=>t.title',
  "tasks.filter(t=>!options.status||options.status==='all'||t.completed===(options.status==='completed')).filter(t=>t.title",
);
const sorting = baseline.replace(
  'tasks.filter(t=>t.title',
  "(options.sort? [...tasks].sort((a,b)=>a.title.localeCompare(b.title)*(options.sort==='title-desc'?-1:1)):tasks).filter(t=>t.title",
);
const both = filtering.replace(
  'tasks.filter(t=>!options.status',
  "(options.sort? [...tasks].sort((a,b)=>a.title.localeCompare(b.title)*(options.sort==='title-desc'?-1:1)):tasks).filter(t=>!options.status",
);

test('starter is actually unfinished and owner oracle is disjoint/digest pinned', () => {
  const files = starterFiles();
  assert.deepEqual(Object.keys(files), profile.source_paths);
  assert.equal(checkTaskBoard(resolve(root, profile.starter), 'build').pass, false);
  assert.ok(
    checkTaskBoard(resolve(root, profile.starter), 'build').checks.some(
      (c) => c.name === 'add_task' && c.status === 'fail',
    ),
  );
  assert.equal(protectedBundle().digest, guidedPolicy().build.test_bundle.digest);
  assert.ok(Object.keys(protectedBundle().files).every((path) => !Object.hasOwn(files, path)));
});

test('version 2 changes only the brief: same bare starter, same unfinished scaffold', () => {
  assert.equal(guidedProfile(2).starter, profile.starter);
  assert.deepEqual(starterFiles(2), starterFiles(1));
  const starter = resolve(root, guidedProfile(2).starter);
  for (const phase of ['build', 'extend', 'final']) {
    const result = checkTaskBoard(starter, phase);
    assert.equal(result.pass, false);
    assert.equal(result.checks.find((c) => c.name === 'add_task').status, 'fail');
  }
  assert.ok(
    Object.keys(protectedBundle(2).files).every((path) => !Object.hasOwn(starterFiles(2), path)),
  );
});

test('build has no future bookmark criteria; extension must preserve the same task after completion/reorder', () => {
  control(baseline, (directory) => {
    assert.equal(checkTaskBoard(directory, 'build').pass, true);
    assert.equal(checkTaskBoard(directory, 'extend').pass, false);
  });
  control(baseline + links, (directory) =>
    assert.equal(checkTaskBoard(directory, 'extend').pass, true),
  );
  const lossy = links.replace(
    'tasks.find(t=>taskLink(t)===fragment)',
    "tasks.find((t,index)=>'#task='+index===fragment)",
  );
  control(baseline + lossy, (directory) => {
    const result = checkTaskBoard(directory, 'extend');
    assert.equal(result.pass, false);
    assert.equal(
      result.checks.find((c) => c.name === 'bookmark_after_completion_and_reorder').status,
      'fail',
    );
  });
});

test('parallel variants check their actual own feature; final requires their composition and old behavior', () => {
  control(filtering + links, (directory) => {
    assert.equal(checkTaskBoard(directory, 'parallel', 'filter').pass, true);
    assert.equal(checkTaskBoard(directory, 'parallel', 'sort').pass, false);
    assert.equal(checkTaskBoard(directory, 'final').pass, false);
  });
  control(sorting + links, (directory) => {
    assert.equal(checkTaskBoard(directory, 'parallel', 'sort').pass, true);
    assert.equal(checkTaskBoard(directory, 'parallel', 'filter').pass, false);
  });
  control(both + links, (directory) => assert.equal(checkTaskBoard(directory, 'final').pass, true));
});

test('missing phase/variant and candidate forged verdict or process access cannot create success', () => {
  assert.throws(() => checkTaskBoard('.', undefined));
  assert.throws(() => checkTaskBoard('.', 'parallel', undefined));
  assert.throws(() => checkTaskBoard('.', 'final', 'filter'));
  for (const module of [
    "process.env.GUIDED_CHECK_PHASE='build';" + both + links,
    'export const addTask=()=>({pass:true,checks:[]});export const completeTask=()=>[];export const visibleTasks=()=>[];',
  ]) {
    control(module, (directory) => assert.equal(checkTaskBoard(directory, 'final').pass, false));
  }
});

test('UI wiring accepts the root-relative module path the starter itself uses', () => {
  const wiring = (specifier) =>
    control(baseline, (directory) => {
      writeFileSync(
        resolve(directory, 'public/app.mjs'),
        `import {addTask,completeTask,visibleTasks} from '${specifier}';\naddTask([],'a','1');completeTask([],'1');visibleTasks([]);`,
      );
      return checkTaskBoard(directory, 'build').checks.find((c) => c.name === 'ui_module_wiring')
        .status;
    });
  assert.equal(wiring('./tasks.mjs'), 'pass');
  assert.equal(wiring('/tasks.mjs'), 'pass');
  assert.equal(wiring('./lib/tasks.mjs'), 'fail');
  assert.equal(wiring('https://example.com/tasks.mjs'), 'fail');
});

test('UI wiring accepts any same-directory spelling of the app module script', () => {
  const page = (script) =>
    control(baseline, (directory) => {
      writeFileSync(
        resolve(directory, 'public/index.html'),
        `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>T</title></head><body>${script}</body></html>`,
      );
      writeFileSync(
        resolve(directory, 'public/app.mjs'),
        `import {addTask,completeTask,visibleTasks} from './tasks.mjs';\naddTask([],'a','1');completeTask([],'1');visibleTasks([]);`,
      );
      return checkTaskBoard(directory, 'build').checks.find((c) => c.name === 'ui_module_wiring')
        .status;
    });
  assert.equal(page('<script type="module" src="./app.mjs"></script>'), 'pass');
  assert.equal(page('<script type="module" src="/app.mjs"></script>'), 'pass');
  assert.equal(page('<script type="module" src="app.mjs"></script>'), 'pass');
  assert.equal(page('<script src="./app.mjs" type="module"></script>'), 'pass');
  assert.equal(page('<script src="./app.mjs"></script>'), 'fail');
  assert.equal(page('<script type="module" src="./lib/app.mjs"></script>'), 'fail');
});
