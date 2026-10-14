import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GuidedSessionPanel } from './GuidedSessionPanel';
import { sessionFixture } from './guidedFixture';

const render = (changes = {}) =>
  renderToStaticMarkup(
    createElement(GuidedSessionPanel, {
      session: sessionFixture(),
      busy: false,
      onStart: () => {},
      onInspect: () => {},
      onRefresh: () => {},
      ...changes,
    }),
  );
describe('fresh guided project stage presentation', () => {
  it('keeps human review actionable when native review is awaiting publication with no new run', () => {
    const session = sessionFixture();
    session.next_step = 'review';
    session.steps = session.steps.map((step) => ({
      ...step,
      status: step.id === 'review' ? 'running' : 'complete',
      candidate_id: 'final',
      run_ids: step.id === 'review' ? [] : ['actual'],
      next_action: step.id === 'review' ? 'review_and_publish' : null,
    }));
    const html = render({ session });
    expect(html).toContain('class="primary"');
    expect(html).toContain('Review result');
    expect(html).toContain('Awaiting your decision');
    expect(html).not.toContain('This stage is in progress.');
  });
  it('shows one explicit build action and locked later stages without fake results or auto-launch', () => {
    const html = render();
    expect(html).toContain('Build together');
    expect(html).toContain('Continue from context');
    expect(html).toContain('Reconcile concurrent changes');
    expect(html).toContain('Review and publish');
    expect(html.match(/class="primary"/g)).toHaveLength(1);
    expect(html).not.toContain('Captured revision');
    expect(html).not.toContain('Verified');
  });
  it('makes a running stage nonclickable and does not enable future stages from client candidate claims', () => {
    const session = sessionFixture();
    session.steps[0].status = 'running';
    session.steps[0].run_ids = ['actual-run'];
    const html = render({ session });
    expect(html).not.toContain('class="primary"');
    expect(html).toContain('In progress');
    expect(html).toContain('Open run');
    expect(html).not.toContain('>Continue from context</button>');
    expect(html).toContain('class="guided-running-note"');
    expect(html).toContain('The next step unlocks when this one finishes.');
    expect(html).toContain('aria-label="Refresh guide"');
  });
  it('leads to human review only when server next_step permits it, retaining actual evidence and source ties', () => {
    const session = sessionFixture();
    session.next_step = 'review';
    session.steps = session.steps.map((step) => ({
      ...step,
      status: step.id === 'review' ? 'ready' : 'complete',
      run_ids: ['checked-run'],
      candidate_id: 'checked',
      revision: { repository: 'source', commit: 'a'.repeat(40) },
      evidence: [
        {
          kind: 'checks',
          label: 'Final independent checks',
          verified: true,
          run_id: 'checked-run',
        },
      ],
      next_action: step.id === 'review' ? 'Review result' : null,
    }));
    const html = render({ session });
    expect(html).toContain('Review result');
    expect(html).toContain('Final independent checks');
    expect(html).toContain('Verified');
    expect(html).toContain('rev aaaaaaaaa');
    expect(html).not.toContain('>Publish</button>');
  });
});
