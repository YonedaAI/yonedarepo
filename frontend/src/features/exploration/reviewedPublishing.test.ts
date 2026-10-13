import type { ReactElement, ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { comparisonFixture } from '../../../../tests/frontend/comparisonFixture';

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0 }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.cells)) hooks.cells[index] = initial;
    return [
      hooks.cells[index],
      (value: unknown) => {
        hooks.cells[index] = value;
      },
    ];
  },
}));

import { ReviewedDecisionForm } from './ReviewedDecisionForm';

function find(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, any>>) => boolean,
): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement<Record<string, any>>;
  return predicate(el) ? el : find(el.props.children, predicate);
}
beforeEach(() => {
  hooks.cells = [];
  hooks.cursor = 0;
});
it('publishes stored agent reasons only after an explicit checkbox, without requiring a human note or rejected-reason retyping', () => {
  const input = comparisonFixture();
  const accept = vi.fn().mockResolvedValue(undefined);
  const render = () => {
    hooks.cursor = 0;
    return ReviewedDecisionForm({
      comparison: input.comparison,
      candidate: 'left',
      busy: false,
      onAccept: accept,
      onClose: () => {},
      confirmationKey: 'left:check:v1',
    });
  };
  render().props.onSubmit({ preventDefault() {} });
  expect(accept).not.toHaveBeenCalled();
  find(render(), (el) => el.type === 'input' && el.props.type === 'checkbox')?.props.onChange({
    target: { checked: true },
  });
  expect(find(render(), (el) => el.type === 'textarea')?.props.required).toBeUndefined();
  render().props.onSubmit({ preventDefault() {} });
  expect(accept).toHaveBeenCalledOnce();
  expect(accept.mock.calls[0][0]).toContain(input.comparison.latest_review?.rationale);
  expect(accept.mock.calls[0][1]).toEqual([
    { candidate: 'right', reason: input.comparison.latest_review?.alternatives[1].reason },
  ]);
});
it('preserves the publishing note but requires new confirmation when exact check or selection metadata changes', () => {
  const input = comparisonFixture();
  const accept = vi.fn();
  const render = (confirmationKey: string) => {
    hooks.cursor = 0;
    return ReviewedDecisionForm({
      comparison: input.comparison,
      candidate: 'left',
      busy: false,
      onAccept: accept,
      onClose: () => {},
      confirmationKey,
    });
  };
  find(render('original'), (el) => el.type === 'textarea')?.props.onChange({
    target: { value: 'Preserve the exporter.' },
  });
  find(render('original'), (el) => el.type === 'input')?.props.onChange({
    target: { checked: true },
  });
  render('changed-evaluation').props.onSubmit({ preventDefault() {} });
  expect(accept).not.toHaveBeenCalled();
  expect(find(render('changed-evaluation'), (el) => el.type === 'textarea')?.props.value).toBe(
    'Preserve the exporter.',
  );
  expect(find(render('changed-evaluation'), (el) => el.type === 'input')?.props.checked).toBe(
    false,
  );
});
