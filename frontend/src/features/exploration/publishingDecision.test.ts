import type { ReactElement, ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

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

import { PublishingDecision } from './PublishingDecision';

function find(
  node: ReactNode,
  predicate: (el: ReactElement<Record<string, any>>) => boolean,
): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement<Record<string, any>>;
  return predicate(el) ? el : find(el.props.children, predicate);
}
const alert = (node: ReactNode) => find(node, (el) => el.props.role === 'alert');
const form = (node: ReactNode) => find(node, (el) => typeof el.props.onAccept === 'function');
beforeEach(() => {
  hooks.cells = [];
  hooks.cursor = 0;
});
it('does not report its own recorded decision as an error while publication finishes', async () => {
  let finish: (published: boolean) => void = () => {};
  const onAccept = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
  const onClose = vi.fn();
  const render = (blocker?: string) => {
    hooks.cursor = 0;
    return PublishingDecision({
      chosen: { id: 'left', strategy: 'auto approach 1', revision: { commit: 'abc' } },
      candidates: [],
      busy: false,
      blocker,
      onClose,
      onAccept,
    });
  };
  const accepting = form(render())?.props.onAccept('Owner choice', []);
  // The snapshot refresh after the decision is recorded now reports it as already recorded.
  expect(
    alert(render('A shipping decision has already been recorded for this run.')),
  ).toBeUndefined();
  finish(true);
  await accepting;
  expect(onClose).toHaveBeenCalledOnce();
});
it('still shows a blocker before anything is submitted, and again after a failed publication', async () => {
  const onAccept = vi.fn().mockResolvedValue(false);
  const render = (blocker?: string) => {
    hooks.cursor = 0;
    return PublishingDecision({
      chosen: { id: 'left' },
      candidates: [],
      busy: false,
      blocker,
      onClose: () => {},
      onAccept,
    });
  };
  expect(alert(render('This run was cancelled.'))?.props.children).toBe('This run was cancelled.');
  await form(render())?.props.onAccept('Owner choice', []);
  expect(alert(render('Another publication is in progress in this repository.'))).toBeDefined();
});
