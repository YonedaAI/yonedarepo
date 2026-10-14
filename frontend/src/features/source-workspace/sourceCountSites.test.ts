import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { EvidenceTrail } from '../graph/EvidenceTrail';
import { TeamTaskCard } from '../team/TeamTaskCard';

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
function task(extra: Record<string, unknown>) {
  const item = {
    task_id: 'task',
    title: 'Captured contribution',
    role: 'backend',
    status: 'complete',
    output: { revision: { commit: 'a'.repeat(40) }, ...extra },
  };
  return renderToStaticMarkup(
    createElement(TeamTaskCard, {
      task: item,
      tasks: [item],
      run,
      snapshot,
      busy: false,
      onRetry: () => {},
      onRepair: async () => false,
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
it('keeps a paged task output visible as 20000 changed paths without a false no-changes body', () => {
  const html = task({ paths_ref: reference });
  expect(html).toContain('20000 changed paths');
  expect(html).not.toContain('No changed paths');
});
it('distinguishes unavailable metadata from a genuinely empty legacy path array in both views', () => {
  expect(trail({})).toContain('Changed paths (count unavailable)');
  expect(task({})).toContain('Changed-path count unavailable');
  expect(trail({ paths: [] })).toContain('Changed paths (0)');
  expect(task({ paths: [] })).toContain('0 changed paths');
});
