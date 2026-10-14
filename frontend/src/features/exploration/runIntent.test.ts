import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { intentNeedsPreview, RunIntent } from './RunIntent';
import { runStatusLabel } from './runReviewState';

const longBrief = Array.from(
  { length: 15 },
  (_, line) => `Step ${line + 1}: keep the board usable.`,
).join('\n');

describe('run intent preview', () => {
  it('collapses a long brief behind an accessible toggle without dropping its text', () => {
    const html = renderToStaticMarkup(createElement(RunIntent, { intent: longBrief }));
    expect(html).toContain('class="review-intent collapsed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Show full brief');
    expect(html).toContain('Step 15: keep the board usable.');
    const id = /<p id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-controls="${id}"`);
  });

  it('shows a short brief in full with no toggle', () => {
    const html = renderToStaticMarkup(createElement(RunIntent, { intent: 'Add a due date.' }));
    expect(html).not.toContain('collapsed');
    expect(html).not.toContain('<button');
    expect(intentNeedsPreview('one\ntwo\nthree')).toBe(false);
    expect(intentNeedsPreview('one\ntwo\nthree\nfour')).toBe(true);
    expect(intentNeedsPreview('x'.repeat(271))).toBe(true);
  });
});

describe('run history status wording', () => {
  const snapshot = (decisions: Snapshot['decisions']) =>
    ({
      decisions,
      executions: [],
      candidates: [],
      evaluations: [],
      runs: [],
    }) as unknown as Snapshot;
  it('uses plain labels instead of internal review states', () => {
    expect(runStatusLabel(snapshot([]), { id: 'r', status: 'cancelled' })).toBe('Cancelled');
    expect(runStatusLabel(snapshot([{ run_id: 'r', status: 'published' }]), { id: 'r' })).toBe(
      'Published',
    );
    expect(runStatusLabel(snapshot([{ run_id: 'r', status: 'pending' }]), { id: 'r' })).toBe(
      'Publishing',
    );
    expect(
      runStatusLabel(snapshot([{ run_id: 'r', status: 'publication_failed' }]), { id: 'r' }),
    ).toBe('Needs attention');
  });
});
