import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ cells: [] as unknown[], cursor: 0, api: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: hooks.api }));
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

import { AddProviderModel } from './AddProviderModel';

const source = {
  id: 'saved',
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  label: 'Internal key name',
  version: 3,
};
function find(node: ReactNode, type: string): ReactElement<Record<string, any>> | undefined {
  if (Array.isArray(node)) return node.map((item) => find(item, type)).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  const element = node as ReactElement<Record<string, any>>;
  return element.type === type ? element : find(element.props.children, type);
}
beforeEach(() => {
  hooks.cells = [];
  hooks.cursor = 0;
  hooks.api.mockReset();
});
it('offers another supported model with the saved key and no secret field or automatic mutation', () => {
  const html = renderToStaticMarkup(
    createElement(AddProviderModel, {
      source,
      connections: [source],
      disabled: false,
      onSaved: async () => {},
      onCancel: () => {},
    }),
  );
  expect(html).toContain('Claude Haiku 5.5');
  expect(html).not.toContain('Internal key name');
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain('name="key"');
  expect(hooks.api).not.toHaveBeenCalled();
});
it('only an explicit submission sends the model and guarded source version, never a key', async () => {
  const onSaved = vi.fn().mockResolvedValue(undefined);
  const props = { source, connections: [source], disabled: false, onSaved, onCancel: () => {} };
  const render = () => {
    hooks.cursor = 0;
    return AddProviderModel(props);
  };
  find(render(), 'select')?.props.onChange({ target: { value: 'claude-haiku-5-5' } });
  hooks.api.mockResolvedValue({ id: 'alias' });
  await find(render(), 'form')?.props.onSubmit({ preventDefault() {} });
  expect(hooks.api).toHaveBeenCalledExactlyOnceWith('settings/connections/saved/models', {
    model: 'claude-haiku-5-5',
    expected_version: 3,
  });
  expect(onSaved).toHaveBeenCalledOnce();
});
it('does not submit a model absent from the eligible catalog', async () => {
  const props = {
    source,
    connections: [source],
    disabled: false,
    onSaved: async () => {},
    onCancel: () => {},
  };
  const render = () => {
    hooks.cursor = 0;
    return AddProviderModel(props);
  };
  find(render(), 'select')?.props.onChange({ target: { value: 'invented-model' } });
  await find(render(), 'form')?.props.onSubmit({ preventDefault() {} });
  expect(hooks.api).not.toHaveBeenCalled();
});
