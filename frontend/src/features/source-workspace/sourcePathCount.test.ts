import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { CandidateCard } from '../exploration/CandidateCard';
import { ChangedPathList } from './ChangedPathList';
import { capturedPathCount } from './sourcePathCount';

const run = { id: 'run', status: 'exploring' },
  candidate = {
    id: 'candidate',
    run_id: 'run',
    status: 'captured',
    revision: { repository: 'git/source', commit: 'a'.repeat(40) },
    base: { commit: 'a'.repeat(40) },
  };
const snapshot = {
  repository: { id: 'repo', head_commit: 'a'.repeat(40), status: 'ready' },
  runs: [run],
  candidates: [],
  executions: [],
  evaluations: [],
  decisions: [],
  artifacts: [],
  nodes: [],
  edges: [],
  seq: 0,
} as unknown as Snapshot;
function card(extra: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(CandidateCard, {
      repo: 'repo',
      strategy: 'Captured result',
      candidate: { ...candidate, ...extra },
      snapshot,
      run,
      selected: false,
      disabled: true,
      onSelect: () => {},
      onContext: () => {},
      onGraph: () => {},
    }),
  );
}
it('renders the exact large-capture path count when native omits the inline array', () => {
  const html = card({
    paths_ref: { version: 1, id: 'paths:candidate', digest: 'b'.repeat(64), count: 10000 },
  });
  expect(html).toContain('10000 paths');
  expect(html).not.toMatch(/>0 paths</);
});
it('keeps an unknown count distinct from an actual zero-length legacy capture', () => {
  expect(card({})).toContain('Path count unavailable');
  expect(card({ paths: [] })).toContain('0 paths');
  expect(card({ paths: ['src/a'] })).toContain('1 path');
});
it('does not cap a deletion-plus-addition path union at the 10000-file source limit', () => {
  expect(
    capturedPathCount({
      paths_ref: { version: 1, id: 'paths:union', digest: 'b'.repeat(64), count: 20000 },
    }),
  ).toBe(20000);
  expect(
    capturedPathCount({
      paths: ['old'],
      paths_ref: { version: 1, id: 'paths:union', digest: 'b'.repeat(64), count: 20000 },
    }),
  ).toBe(20000);
});
it('rejects an invalid path-reference count instead of inventing an empty change set', () => {
  for (const count of [-1, 1.5, Number.POSITIVE_INFINITY])
    expect(
      capturedPathCount({
        paths_ref: { version: 1, id: 'paths:bad', digest: 'b'.repeat(64), count },
      }),
    ).toBeUndefined();
  expect(capturedPathCount({ paths_count: 3 })).toBeUndefined();
});
it('keeps large changed paths collapsed and does not fetch source, graph or pages on render', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const html = renderToStaticMarkup(
    createElement(ChangedPathList, {
      repo: 'repo',
      candidateId: 'candidate',
      pathRef: { version: 1, id: 'paths:candidate', digest: 'b'.repeat(64), count: 20000 },
    }),
  );
  expect(html).toContain('Changed paths (20000)');
  expect(html).not.toContain('Loading recorded');
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();
});
