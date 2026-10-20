import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SourcePreparationPanel } from './SourcePreparationPanel';
import { preparationView } from './sourcePreparation';

it('shows preparing source before agent work even when an agent is already queued', () => {
  const view = preparationView('api-source-v1', { version: 1, status: 'preparing' }, 'working');
  expect(view?.title).toBe('Preparing source');
  expect(view?.stage).toBe('preparing');
  expect(view?.detail).not.toMatch(/DO|manifest|kernel|epoch|materializ/i);
});
it('moves to working and human review only from the supplied recorded workflow stage', () => {
  expect(preparationView('api-source-v1', { version: 1, status: 'ready' }, 'working')?.title).toBe(
    'Agent working',
  );
  expect(preparationView('api-source-v1', { version: 1, status: 'ready' }, 'review')?.title).toBe(
    'Ready for human review',
  );
  expect(preparationView('api-source-v1', { version: 1, status: 'ready' }, 'checking')?.title).toBe(
    'Checking the result',
  );
});
it('does not require a new source preparation state for historical Git transport approvals', () => {
  expect(preparationView('json-v1', undefined, 'working')).toBeNull();
  const html = renderToStaticMarkup(
    createElement(SourcePreparationPanel, { transport: 'json-v1', stage: 'working' }),
  );
  expect(html).toBe('');
});
it('a failed preparation has a plain refresh action without exposing raw diagnostics or starting new work', () => {
  let actions = 0;
  const html = renderToStaticMarkup(
    createElement(SourcePreparationPanel, {
      transport: 'api-source-v1',
      preparation: { version: 1, status: 'failed', reason: 'source_changed' },
      stage: 'waiting',
      onRefresh: () => {
        actions++;
      },
    }),
  );
  expect(html).toContain('Refresh source status');
  expect(html).toContain('The approved source changed');
  expect(html).toContain('role="alert"');
  expect(html).not.toContain('Start a Run');
  expect(actions).toBe(0);
});
