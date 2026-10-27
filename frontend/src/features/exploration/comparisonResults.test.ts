import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { comparisonFixture } from '../../../../tests/frontend/comparisonFixture';
import { ComparisonResults } from './ComparisonResults';
import { selectionRationale } from './ReviewedDecisionForm';

const noop = () => {};
function markup(
  input: Omit<ReturnType<typeof comparisonFixture>, 'run'> & {
    run: Record<string, any>;
  } = comparisonFixture(),
) {
  return renderToStaticMarkup(
    createElement(ComparisonResults, {
      snapshot: input.snapshot,
      run: input.run,
      busy: false,
      onPublish: noop,
      onAction: async () => true,
      onContext: noop,
      onGraph: noop,
    }),
  );
}
it('keeps both exact checked alternatives accessible before any winner or branch promotion exists', () => {
  const html = markup();
  expect(html).toContain('Manual comparison');
  expect(html).not.toContain('Review now');
  expect(html.match(/Use this result<\/button>/g)).toHaveLength(2);
  expect(html.match(/Preview website<\/button>/g)).toHaveLength(2);
  expect(html.match(/Review changes<\/summary>/g)).toHaveLength(2);
  expect(html).not.toContain('Selected output');
  expect(html).not.toContain('Why this approach was proposed');
});
it('leads with the owner’s selected output and reason, preserving the other preview and independent checks', () => {
  const input = comparisonFixture();
  const comparison = {
    ...input.comparison,
    selected_by: 'owner',
    selection_reason: 'Prefer compatibility with our event exporter.',
  };
  input.snapshot.working_branches = input.snapshot.working_branches?.map((b) => ({
    ...b,
    working_commit: 'left',
    working_revision: input.candidates[0].revision,
    latest_candidate_id: 'left',
    version: 3,
  }));
  const html = markup({ ...input, run: { ...input.run, comparison } });
  expect(html.indexOf('Selected output')).toBeLessThan(html.indexOf('Alternative 2'));
  expect(html.indexOf('Why this result was chosen')).toBeLessThan(html.indexOf('Behavior checks'));
  expect(html).toContain(comparison.selection_reason);
  expect(html.match(/Preview website<\/button>/g)).toHaveLength(2);
  expect(selectionRationale(comparison, 'Verified the export flow.')).toBe(
    'Owner choice: Prefer compatibility with our event exporter.\n\nOwner note: Verified the export flow.',
  );
});
it('shows a historical reviewer selection without its retired assessment or review controls', () => {
  const input = comparisonFixture();
  const html = markup({ ...input, run: { ...input.run, comparison: input.comparison } });
  expect(html).toContain('Selected output');
  expect(html).not.toContain('preserves the existing access contract');
  expect(html).not.toContain('Why this result was chosen');
  expect(html).not.toContain('Review now');
});
it('offers a manual choice among three builders', () => {
  const input = comparisonFixture();
  const third = {
    ...input.candidates[0],
    id: 'third',
    summary: 'third filtering implementation',
    execution: 'third',
    evaluation: 'check-third',
    revision: { repository: 'source', commit: 'third' },
  };
  input.snapshot.candidates.push(third);
  input.snapshot.executions.push({ ...input.snapshot.executions[0], id: 'third', agent_index: 2 });
  input.snapshot.evaluations.push({
    ...input.snapshot.evaluations[0],
    id: 'check-third',
    candidate: 'third',
    revision: third.revision,
  });
  const html = markup(input);
  expect(html).toContain('third filtering');
  expect(html.match(/Use this result<\/button>/g)).toHaveLength(3);
});
it('keeps manual selection available for a one-builder comparison', () => {
  const input = comparisonFixture();
  input.snapshot.candidates = input.snapshot.candidates.slice(0, 1);
  input.snapshot.executions = input.snapshot.executions.slice(0, 1);
  const html = markup(input);
  expect(html).toContain('Use this result');
});
it('shows the recorded manual choice without inventing a reviewer proposal', () => {
  const input = comparisonFixture();
  const manual = {
    version: 1 as const,
    status: 'selected',
    selected_candidate_id: 'left',
    selected_by: 'owner',
    selection_reason: 'Preserves our existing export format.',
  };
  const html = markup({ ...input, run: { ...input.run, comparison: manual } });
  expect(html).toContain(manual.selection_reason);
  expect(html).not.toContain('agent assertion');
});
