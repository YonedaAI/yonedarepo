import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { SourceReader, SourceSelection } from '../../lib/sourceWorkspace';
import type { Snapshot } from '../../lib/types';
import { CandidateSourcePreview } from '../exploration/CandidateSourcePreview';
import { publishedSourceSelection } from './PublishedSourceViewer';
import { ReadOnlySourceViewer } from './ReadOnlySourceViewer';
import { recordedCandidateSelection } from './RecordedSourceViewer';
import { SourceFilePreview } from './SourceFilePreview';
import { SourceTrailDetails } from './SourceTrailDetails';
import { SourceVersionBadge } from './SourceVersionBadge';
import { SourceWorkspaceIntegration } from './SourceWorkspaceIntegration';
import { createSourceReadSession } from './sourceReader';

const revision = { repository: 'canonical/source', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
const proposed: SourceSelection = {
  repo_id: 'repo',
  kind: 'proposed',
  workspace_id: 'attempt-2',
  epoch: 2,
  workspace_version: 4,
  base: revision,
};
const captured: SourceSelection = {
  repo_id: 'repo',
  kind: 'captured',
  candidate_id: 'candidate',
  revision,
};
const checked: SourceSelection = {
  ...captured,
  kind: 'checked',
  evaluation_id: 'evaluation',
  policy_version: 'policy-v2',
};
const published: SourceSelection = {
  repo_id: 'repo',
  kind: 'published',
  decision_id: 'decision',
  revision,
};
function reader(): SourceReader {
  return { list: vi.fn(), read: vi.fn(), provenance: vi.fn() };
}
it('distinguishes proposed change sets, captures, checked revisions and canonical publication', () => {
  const htmls = [proposed, captured, checked, published].map((source) =>
    renderToStaticMarkup(createElement(SourceVersionBadge, { source })),
  );
  expect(htmls[0]).toContain('<h3>Proposed changes — not checked or published</h3>');
  expect(htmls[0]).toContain('Change set version 4');
  expect(htmls[0]).toContain('attempt-2');
  expect(htmls[1]).toContain('<h3>Captured source — inspect its recorded checks</h3>');
  expect(htmls[2]).toContain('Checked source — publication is a separate decision');
  expect(htmls[2]).toContain('policy-v2');
  expect(htmls[3]).toContain('Published source — canonical Git revision recorded');
  for (const html of htmls) {
    expect(html).toContain(revision.commit);
    expect(html).toContain(revision.tree);
  }
});
it('opening the source panel requires no default whole-source or graph request, and provides no mutation action', () => {
  const r = reader();
  const html = renderToStaticMarkup(
    createElement(ReadOnlySourceViewer, { selection: checked, reader: r }),
  );
  expect(r.list).not.toHaveBeenCalled();
  expect(r.read).not.toHaveBeenCalled();
  expect(r.provenance).not.toHaveBeenCalled();
  expect(html).toContain('Read source files');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toMatch(/Publish result|Start review|Save changes|Graph/);
});
it('binary and deleted files retain metadata/history without reading or inventing text content', () => {
  const r = reader(),
    session = createSourceReadSession(proposed, r);
  const file = {
    path: 'images/banner.bin',
    blob_id: 'blob',
    file_version: 2,
    size_bytes: 100,
    encoding: 'binary' as const,
  };
  const binary = renderToStaticMarkup(createElement(SourceFilePreview, { file, session }));
  const deleted = renderToStaticMarkup(
    createElement(SourceFilePreview, { file: { ...file, change: 'delete' }, session }),
  );
  expect(binary).toContain('Binary file');
  expect(deleted).toContain('deletes the file');
  expect(binary).toContain('prior context');
  expect(r.read).not.toHaveBeenCalled();
  expect(r.provenance).not.toHaveBeenCalled();
});
it('a staged seal never becomes checked or published merely because source preparation finished', () => {
  const html = renderToStaticMarkup(createElement(SourceVersionBadge, { source: proposed }));
  expect(html).not.toContain('<h3>Checked source');
  expect(html).not.toContain('<h3>Published source');
  expect(html).toContain('not checked or published');
});
it('rejects provenance from another revision rather than linking its context as evidence for this file', async () => {
  const r = reader();
  r.provenance = async () => ({
    source: published,
    path: 'src/search.ts',
    coverage: 'recorded',
    checks: [],
    risks: [],
    revisions: [],
    context: [{ id: 'context:other', label: 'Other constraint', record_version: 2 }],
  });
  await expect(createSourceReadSession(checked, r).provenance('src/search.ts')).rejects.toThrow(
    /different source version/,
  );
});
it('capability gating preserves old approvals and makes no source requests on an older deployment', () => {
  const r = reader();
  const props = {
    transport: 'git-native-v1',
    stage: 'working' as const,
    selection: checked,
    reader: r,
  };
  expect(renderToStaticMarkup(createElement(SourceWorkspaceIntegration, props))).toBe('');
  expect(r.list).not.toHaveBeenCalled();
  expect(r.read).not.toHaveBeenCalled();
  const html = renderToStaticMarkup(
    createElement(SourceWorkspaceIntegration, { ...props, sourceApi: 1 }),
  );
  expect(html).toContain('Checked source');
  expect(html).not.toContain('Preparing source');
});
it('integrates the paged source reader for a historical capture only when the server capability is present', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const props = { repo: 'repo', candidate: { id: 'candidate', revision } };
  const old = renderToStaticMarkup(createElement(CandidateSourcePreview, props));
  const current = renderToStaticMarkup(
    createElement(CandidateSourcePreview, { ...props, sourceApi: 1 }),
  );
  expect(old).toContain('500 files and 8 MiB');
  expect(current).toContain('Read source files');
  expect(current).not.toContain('500 files and 8 MiB');
  expect(current).not.toContain('Preparing source');
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();
});
it('labels checks only when a passing evaluation is bound to this exact captured candidate and revision', () => {
  const candidate = { id: 'candidate', revision, evaluation: 'evaluation' };
  const evaluation = {
    id: 'evaluation',
    candidate: 'candidate',
    revision,
    policy: 'policy',
    suite: 'independent',
    environment: 'clean',
    evidence: 'd'.repeat(64),
    checks: [{ name: 'build', status: 'pass' }],
  };
  expect(recordedCandidateSelection('repo', candidate, evaluation)?.kind).toBe('checked');
  for (const patch of [
    { candidate: 'other' },
    { revision: { ...revision, commit: 'e'.repeat(40) } },
    { checks: [{ name: 'build', status: 'fail' }] },
  ])
    expect(recordedCandidateSelection('repo', candidate, { ...evaluation, ...patch })?.kind).toBe(
      'captured',
    );
});
it('never substitutes a newer canonical revision under an older published decision', () => {
  const snapshot = {
    capabilities: { source_api: 1 },
    repository: {
      id: 'repo',
      published_commit: revision.commit,
      remote: { namespace: 'canonical', name: 'source' },
    },
    decisions: [{ id: 'decision', run_id: 'run', status: 'published', target: revision }],
  } as unknown as Snapshot;
  expect(publishedSourceSelection(snapshot, 'run')).toMatchObject({
    kind: 'published',
    revision: { repository: 'canonical/source', commit: revision.commit },
  });
  expect(
    publishedSourceSelection(
      { ...snapshot, repository: { ...snapshot.repository, published_commit: 'e'.repeat(40) } },
      'run',
    ),
  ).toBeUndefined();
});
it('presents capture attempts, actual prior context and historical check policy without inventing causal benefit', () => {
  const trail = {
    source: checked,
    path: 'src/a',
    coverage: 'recorded' as const,
    checks: [{ name: 'build', status: 'pass' as const }],
    risks: [],
    context: [],
    revisions: [],
    capture_receipts: [
      { id: 'receipt', commit: revision.commit, path: 'src/a', change: 'modify', capture_epoch: 4 },
    ],
    evaluation: {
      id: 'eval',
      policy_version: 'old-policy',
      suite: 'independent',
      environment: 'clean',
      evidence_digest: 'd'.repeat(64),
    },
  };
  const html = renderToStaticMarkup(createElement(SourceTrailDetails, { trail }));
  expect(html).toContain('Capture attempt 4');
  expect(html).toContain('No prior context references');
  expect(html).not.toContain('Recorded version 4');
  expect(html).toContain('old-policy');
  expect(html).toContain('does not establish current publication eligibility');
  expect(html).toContain('does not establish outcome benefit');
});
