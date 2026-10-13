import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { comparisonFixture } from '../../../../tests/frontend/comparisonFixture';
import { ComparisonResults } from './ComparisonResults';
import { LegacyReviewApproval } from './LegacyReviewApproval';
import { reviewedPublishingInput } from './ReviewedDecisionForm';

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
  expect(html).toContain('Review now');
  expect(html.match(/Use this result<\/button>/g)).toHaveLength(2);
  expect(html.match(/Preview website<\/button>/g)).toHaveLength(2);
  expect(html.match(/Review changes<\/summary>/g)).toHaveLength(2);
  expect(html).not.toContain('Selected output');
  expect(html).not.toContain('Why this approach was proposed');
});
it('leads with the selected output and recorded assessment, preserving the other preview and independent checks', () => {
  const input = comparisonFixture();
  const run = { ...input.run, comparison: input.comparison };
  input.snapshot.working_branches = input.snapshot.working_branches?.map((b) => ({
    ...b,
    working_commit: 'left',
    working_revision: input.candidates[0].revision,
    latest_candidate_id: 'left',
    version: 3,
  }));
  const html = markup({ ...input, run });
  expect(html.indexOf('Selected output')).toBeLessThan(html.indexOf('Alternative 2'));
  expect(html).toContain(input.comparison.latest_review?.rationale);
  expect(html.indexOf('Why this approach was proposed')).toBeLessThan(
    html.indexOf('Behavior checks'),
  );
  expect(html).toContain('agent assertion');
  expect(html).toContain('Large event catalogs still need load testing');
  expect(html.match(/Preview website<\/button>/g)).toHaveLength(2);
});
it('does not erase the reviewer proposal when the owner chooses the other checked result', () => {
  const input = comparisonFixture();
  const state = {
    ...input.comparison,
    selected_by: 'owner' as const,
    selected_candidate_id: 'right',
    selection_reason: 'Prefer compatibility with our event exporter.',
  };
  const html = markup({ ...input, run: { ...input.run, comparison: state } });
  expect(html).toContain('Reviewer’s original proposal');
  expect(html).toContain(state.selection_reason);
  expect(input.comparison.latest_review?.selected_candidate_id).toBe('left');
  const publication = reviewedPublishingInput(state, 'right', 'Verified the export flow.');
  expect(publication.rationale).toContain(state.latest_review?.rationale);
  expect(publication.rationale).toContain(state.selection_reason);
  expect(publication.rationale).toContain('Owner note: Verified the export flow.');
  expect(publication.alternatives.map((a) => a.candidate)).toEqual(['left']);
});
it('opening legacy review approval is read-only and has one explicit approval covering review and bounded repairs', () => {
  const input = comparisonFixture();
  const approve = vi.fn();
  const html = renderToStaticMarkup(
    createElement(LegacyReviewApproval, {
      goal: input.run.intent,
      candidates: input.candidates,
      busy: false,
      onApprove: approve,
      onClose: noop,
    }),
  );
  expect(approve).not.toHaveBeenCalled();
  expect(html).toContain(input.run.intent);
  expect(html).toContain('repair the most promising alternative up to two times');
  expect(html).toContain('builders are not restarted');
  expect(html).toContain('Start review');
  expect(html).not.toContain('<textarea');
  expect(html).not.toContain('Maximum spend');
});
it('preserves legacy three-builder manual choices without suggesting an automatic reviewer or Review now', () => {
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
  expect(html).not.toContain('Review now');
  expect(html).not.toContain('Automatic reviewer · Auto');
});
it('keeps manual selection available for a historical one-builder comparison without offering AI review', () => {
  const input = comparisonFixture();
  input.snapshot.candidates = input.snapshot.candidates.slice(0, 1);
  input.snapshot.executions = input.snapshot.executions.slice(0, 1);
  const html = markup(input);
  expect(html).toContain('Use this result');
  expect(html).not.toContain('Review now');
});
it('shows the recorded manual choice without inventing a reviewer proposal', () => {
  const input = comparisonFixture();
  const manual = {
    ...input.comparison,
    approval: null,
    latest_review: null,
    latest_review_id: null,
    selected_by: 'owner' as const,
    selection_reason: 'Preserves our existing export format.',
  };
  const html = markup({ ...input, run: { ...input.run, comparison: manual } });
  expect(html).toContain(manual.selection_reason);
  expect(html).not.toContain('Reviewer’s original proposal');
  expect(html).not.toContain('agent assertion');
});
it('allows legacy effectively disabled delegation but withholds AI approval for extra delegation capacity or descendants', () => {
  const input = comparisonFixture();
  const effectivelyDisabled = {
    ...input.run,
    agents: [{}, {}],
    delegation: { enabled: true, max_executions: 2 },
  };
  expect(markup({ ...input, run: effectivelyDisabled })).toContain('Review now');
  const extraCapacity = markup({
    ...input,
    run: { ...effectivelyDisabled, delegation: { enabled: true, max_executions: 3 } },
  });
  expect(extraCapacity).not.toContain('Review now');
  expect(extraCapacity).toContain('delegated');
  expect(extraCapacity.match(/Use this result<\/button>/g)).toHaveLength(2);
  const descendantSnapshot = {
    ...input.snapshot,
    executions: [
      ...input.snapshot.executions,
      {
        id: 'child',
        run_id: input.run.id,
        role: 'coding',
        parent_execution: 'left',
        status: 'completed',
      },
    ],
  };
  const descendant = markup({ ...input, snapshot: descendantSnapshot, run: effectivelyDisabled });
  expect(descendant).not.toContain('Review now');
  expect(descendant).toContain('delegated');
  expect(descendant.match(/Use this result<\/button>/g)).toHaveLength(2);
  const additional = markup({ ...input, snapshot: { ...input.snapshot, executions: [...input.snapshot.executions, {id:'extra',run_id:input.run.id,role:'research',status:'completed'}] }, run: effectivelyDisabled });
  expect(additional).not.toContain('Review now');
  expect(additional.match(/Use this result<\/button>/g)).toHaveLength(2);
  const wrongRoots = markup({ ...input, snapshot: { ...input.snapshot, executions: input.snapshot.executions.map(e=>({...e,id:`replacement-${e.id}`})) }, run: effectivelyDisabled });
  expect(wrongRoots).not.toContain('Review now');
});
it.each(['reviewing', 'repairing', 'stale', 'needs_attention'] as const)(
  'shows %s clearly without presenting a nonexistent winner',
  (status) => {
    const input = comparisonFixture();
    const html = markup({
      ...input,
      run: {
        ...input.run,
        comparison: {
          ...input.comparison,
          status,
          selected_candidate_id: null,
          latest_review: null,
          latest_review_id: null,
        },
      },
    });
    expect(html).not.toContain('Selected output');
    expect(html).not.toContain('Publish result');
    if (status === 'reviewing' || status === 'repairing') expect(html).toContain('disabled=""');
  },
);
