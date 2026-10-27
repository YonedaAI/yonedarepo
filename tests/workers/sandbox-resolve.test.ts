// "Resolve conflict" as a sandbox run: the brief names each conflicting path with its base, head
// and candidate versions, read from the real platform; without sandboxes the ledger's harness
// resolver stays in charge.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { projectPlatform, repositoryPlatform } from '../../cloudflare/worker/agents-platform';
import {
  type ConflictFile,
  conflictBrief,
  fileAt,
  resolveInSandbox,
} from '../../cloudflare/worker/sandbox-resolve';
import { platformSource } from '../../cloudflare/worker/source-objects';
import type { Env, Principal } from '../../cloudflare/worker/types';
import { platformCommit } from './platform-fixture';
import { readyReviewer } from './reviewer-fixture';

const bindings = env as unknown as Env;
afterEach(reset);

it('briefs the resolver with every side of each conflicting path', async () => {
  const owner = 'resolve_brief';
  const fixture = await readyReviewer(owner);
  const platform = await projectPlatform(bindings, owner, fixture.repo);
  const base = await platformCommit(platform, fixture.head, { 'src/math.js': 'export const add = 0;\n' });
  const head = await platformCommit(platform, base.commit, { 'src/math.js': 'export const add = (a, b) => a + b;\n' });
  const theirs = await platformCommit(platform, base.commit, {
    'src/math.js': 'export function add(a, b) { return a + b; }\n',
    'src/new.js': 'export {};\n',
  });
  const source = platformSource(await repositoryPlatform(bindings, fixture.repo));
  const file = async (path: string): Promise<ConflictFile> => ({
    path,
    base: await fileAt(source, base.commit, path),
    head: await fileAt(source, head.commit, path),
    candidate: await fileAt(source, theirs.commit, path),
  });
  const files = [await file('src/math.js'), await file('src/new.js')];
  expect(files[1]).toMatchObject({ base: null, head: null, candidate: { size: 11, text: 'export {};\n' } });
  const record = {
    id: 'conflict:r1',
    head_commit: head.commit,
    candidate: {
      id: 'cand',
      run_id: 'run-1',
      summary: 'Added add(a,b)',
      base: { commit: base.commit },
      revision: { commit: theirs.commit },
    },
  };
  const brief = conflictBrief(record, files, 2, 'Keep the arrow form');
  expect(brief).toContain('Owner guidance: Keep the arrow form');
  expect(brief).toContain(`commit ${theirs.commit}`);
  expect(brief).toContain(`head has since moved to ${head.commit}`);
  expect(brief).toContain('- src/math.js: base 22 bytes, head 36 bytes, candidate 44 bytes');
  expect(brief).toContain('- src/new.js: base absent, head absent, candidate 11 bytes');
  expect(brief).toContain('export const add = (a, b) => a + b;');
  expect(brief).toContain('export function add(a, b) { return a + b; }');
  expect(brief).toContain(`git cherry-pick --no-commit ${theirs.commit}`);
});

it('leaves the harness resolver in charge where runs take no sandbox', async () => {
  const fixture = await readyReviewer('resolve_none');
  const { AGENT_SANDBOX: _, ...withoutSandbox } = bindings as Env & { AGENT_SANDBOX?: unknown };
  const principal = { workspace: 'resolve_none', role: 'user' } as Principal;
  const started = await resolveInSandbox(withoutSandbox as Env, principal, fixture.repo, {
    conflict_id: 'conflict:r1',
    request_id: 'r1',
  });
  expect(started).toBeNull();
});
