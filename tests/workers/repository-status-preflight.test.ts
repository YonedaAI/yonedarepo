import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { sitePolicy } from '../../cloudflare/worker/site-policy';
import { ledger } from '../../cloudflare/worker/storage';
import { platformProject } from './platform-fixture';
import { bindings } from './reviewer-fixture';

afterEach(reset);
const repo = 'compact-diff';

it('exposes workspace authority in the real lightweight repository_status preflight', async () => {
  await platformProject(bindings, 'diff_owner', repo, { 'README.md': '# Diff\n' }, sitePolicy);
  const status = await ledger(bindings, repo, { op: 'repository_status', _workspace: 'diff_owner' });
  expect(status).toMatchObject({ workspace: 'diff_owner', capabilities: { workspace_authority: 1 } });
  expect(status.candidates).toBeUndefined();
  await expect(ledger(bindings, repo, { op: 'snapshot', _workspace: 'foreign_owner' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
