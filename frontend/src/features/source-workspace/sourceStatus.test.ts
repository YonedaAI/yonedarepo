import { expect, it } from 'vitest';
import { parseSourceStatus } from './sourceStatus';

const status = {
  version: 1,
  capabilities: { source_api: 1 },
  transport: 'api-source-v1',
  workspace_id: 'source-workspace:test',
  workspace_version: 3,
  status: 'sealed',
  base: { repository: 'git/source', commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
  view_digest: 'c'.repeat(64),
  access: 'read_only',
  latest_checkpoint_id: 'checkpoint',
  seal_id: 'seal',
  authority: 'staged_source',
  checked: false,
  published: false,
};
it('parses the native SourceStatus without promoting a sealed changeset to Git authority', () => {
  const parsed = parseSourceStatus(status);
  expect(parsed.status).toBe('sealed');
  expect(parsed.authority).toBe('staged_source');
  expect(parsed.checked).toBe(false);
  expect(parsed.published).toBe(false);
});
it.each([
  { checked: true },
  { published: true },
  { authority: 'canonical_publication' },
  { capabilities: { source_api: 0 } },
  { workspace_version: -1 },
  { base: { ...status.base, tree: 'caller-tree' } },
])('rejects inconsistent native source status %j', (patch) => {
  expect(() => parseSourceStatus({ ...status, ...patch })).toThrow(/source information/);
});
