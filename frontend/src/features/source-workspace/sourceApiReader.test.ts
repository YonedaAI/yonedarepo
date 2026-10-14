import { expect, it, vi } from 'vitest';
import type { SourceSelection } from '../../lib/sourceWorkspace';
import { createSourceApiReader } from './sourceApiReader';

const revision = { repository: 'git/source', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const source: SourceSelection = {
  repo_id: 'repo',
  kind: 'checked',
  candidate_id: 'candidate',
  evaluation_id: 'eval',
  policy_version: 'policy',
  revision,
};
const file = {
  path: 'src/café.ts',
  blob_id: 'c'.repeat(40),
  file_version: 0,
  size_bytes: 2,
  encoding: 'unknown' as const,
};
const frame = { version: 1, authority: 'git', revision, candidate_id: 'candidate' };
it('uses GET-only recorded candidate selectors and bounded list metadata', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _options?: RequestInit) =>
    Response.json({
      ...frame,
      items: [{ path: file.path, mode: '100644', size: 2, file_version: 0, blob_id: file.blob_id }],
      next_cursor: null,
      has_more: false,
    }),
  );
  const reader = createSourceApiReader(fetcher as typeof fetch);
  const page = await reader.list(source, null, 50);
  expect(page.items[0]).toMatchObject(file);
  const [path, options] = fetcher.mock.calls[0];
  expect(String(path)).toContain('/api/repos/repo/source/list?candidate_id=candidate');
  expect(String(path)).toContain('limit=50');
  expect(options?.method).toBe('GET');
  expect(options?.body).toBeUndefined();
});
it('verifies streamed file identity, offset and response length before returning source bytes', async () => {
  const metadata = {
    ...frame,
    file: { path: file.path, mode: '100644', size: 2, file_version: 0, blob_id: file.blob_id },
    offset: 0,
    length: 2,
  };
  const fetcher = vi.fn(
    async () =>
      new Response(new Uint8Array([65, 66]), {
        headers: {
          'x-yoneda-source': encodeURIComponent(JSON.stringify(metadata)),
          'content-length': '2',
        },
      }),
  );
  expect(
    (await createSourceApiReader(fetcher as typeof fetch).read(source, file, 0, 2)).bytes,
  ).toEqual(new Uint8Array([65, 66]));
  for (const patch of [
    { candidate_id: 'other' },
    { revision: { ...revision, commit: 'd'.repeat(40) } },
    { offset: 1 },
    { file: { ...metadata.file, blob_id: 'e'.repeat(40) } },
  ]) {
    const bad = async () =>
      new Response(new Uint8Array([65, 66]), {
        headers: {
          'x-yoneda-source': encodeURIComponent(JSON.stringify({ ...metadata, ...patch })),
        },
      });
    await expect(
      createSourceApiReader(bad as typeof fetch).read(source, file, 0, 2),
    ).rejects.toThrow(/source response/);
  }
});
it('shows proposed source as unavailable without reviving or querying a producer grant', async () => {
  const fetcher = vi.fn(),
    reader = createSourceApiReader(fetcher as typeof fetch);
  await expect(
    reader.list(
      {
        repo_id: 'repo',
        kind: 'proposed',
        workspace_id: 'staged',
        workspace_version: 1,
        epoch: 2,
        base: revision,
      },
      null,
      50,
    ),
  ).rejects.toThrow(/proposed source/);
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not turn placeholder provenance into recorded file attribution or causal context benefit', async () => {
  const fetcher = async () =>
    Response.json({
      ...frame,
      path: file.path,
      coverage: 'recorded',
      checks: [],
      risks: [],
      context: [],
      recorded_candidate_id: 'candidate',
      explanation: 'Source identity is recorded.',
    });
  const trail = await createSourceApiReader(fetcher as typeof fetch).provenance(source, file.path);
  expect(trail.coverage).toBe('unknown');
  expect(trail.context).toEqual([]);
  expect(trail.checks).toEqual([]);
  expect(trail.explanation).toBeUndefined();
});
it('keeps actual capture attempts separate from prior context and binds historical checks to the exact revision', async () => {
  const response = {
    ...frame,
    path: file.path,
    provenance_authority: 'recorded_file_provenance',
    coverage: 'recorded',
    lineage: [
      {
        id: 'file-receipt',
        authority: 'trusted_capture',
        candidate: 'candidate',
        revision,
        commit: revision.commit,
        path: file.path,
        change: 'modify',
        capture_epoch: 4,
        candidate_summary: 'Preserve input while normalizing.',
      },
    ],
    revisions: [{ candidate_id: 'candidate', revision, label: 'modify' }],
    context: [],
    risks: [],
    evaluation: {
      id: 'eval',
      revision,
      policy: 'policy',
      suite: 'independent',
      environment: 'clean',
      authority: 'historical_checked_revision',
      evidence: 'd'.repeat(64),
    },
    checks: [{ name: 'input not mutated', status: 'pass' }],
  };
  const reader = createSourceApiReader((async () => Response.json(response)) as typeof fetch);
  const trail = await reader.provenance(source, file.path);
  expect(trail.coverage).toBe('recorded');
  expect(trail.context).toEqual([]);
  expect(trail.capture_receipts?.[0]).toMatchObject({ id: 'file-receipt', capture_epoch: 4 });
  expect(trail.reasons?.[0]).toMatchObject({
    authority: 'agent_assertion',
    text: 'Preserve input while normalizing.',
  });
  expect(trail.evaluation).toMatchObject({ id: 'eval', policy_version: 'policy' });
  expect(trail.checks).toEqual([{ name: 'input not mutated', status: 'pass' }]);
  const changed = async () =>
    Response.json({
      ...response,
      evaluation: { ...response.evaluation, revision: { ...revision, commit: 'e'.repeat(40) } },
    });
  expect(
    (await createSourceApiReader(changed as typeof fetch).provenance(source, file.path)).checks,
  ).toEqual([]);
});
it('turns bounded source-index preparation into an explicit safe refresh, never an empty successful list', async () => {
  const fetcher = async () =>
    Response.json(
      {
        ...frame,
        preparation: 'preparing',
        retry_action: 'refresh_source',
        error: { code: 'SOURCE_PREPARING', message: 'internal diagnostic must not appear' },
      },
      { status: 409 },
    );
  await expect(
    createSourceApiReader(fetcher as typeof fetch).list(source, null, 50),
  ).rejects.toThrow(/Refresh files to continue preparation/);
});
