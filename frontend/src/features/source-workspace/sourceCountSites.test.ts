import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { EvidenceTrail } from '../graph/EvidenceTrail';

const run = { id: 'run', status: 'exploring', base: { commit: 'a'.repeat(40) } };
const snapshot = {
  repository: { id: 'repo', head_commit: 'a'.repeat(40), published_commit: 'a'.repeat(40) },
  runs: [run],
  executions: [],
  candidates: [],
  evaluations: [],
  decisions: [],
  artifacts: [],
  nodes: [],
  edges: [],
  seq: 0,
} as unknown as Snapshot;
const reference = { version: 1, id: 'paths:source', digest: 'b'.repeat(64), count: 20000 };
function trail(extra: Record<string, unknown>) {
  return renderToStaticMarkup(
    createElement(EvidenceTrail, {
      snapshot: {
        ...snapshot,
        candidates: [
          {
            id: 'candidate',
            run_id: 'run',
            revision: { commit: 'a'.repeat(40) },
            base: { commit: 'a'.repeat(40) },
            status: 'captured',
            ...extra,
          },
        ],
      },
      runId: 'run',
      graph: { nodes: [], edges: [] },
      onSelect: () => {},
    }),
  );
}
it('keeps a paged capture visible as 20000 changed paths in the evidence trail rather than empty evidence', () => {
  const html = trail({ paths_ref: reference });
  expect(html).toContain('Changed paths (20000)');
  expect(html.split('<summary>Changed paths')[1]?.split('</details>')[0]).not.toContain(
    'None recorded',
  );
});
it('distinguishes unavailable metadata from a genuinely empty legacy path array', () => {
  expect(trail({})).toContain('Changed paths (count unavailable)');
  expect(trail({ paths: [] })).toContain('Changed paths (0)');
});
