import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { useRepository } from '../../hooks/useRepository';
import { WorkspacePanels } from './WorkspacePanels';
import { WorkspaceRail } from './WorkspaceRail';

const fresh = {
  authenticated: true,
  repositories: [],
  snapshot: null,
  id: '',
  loading: false,
} as unknown as ReturnType<typeof useRepository>;

it('offers Connect Agents in navigation before any repository exists', () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceRail, { state: fresh, onPanel: vi.fn() }),
  );
  expect(html).toContain('Connect Agents');
  expect(html).not.toContain('Connect local agent');
});

it('opens useful hosted and external connection choices without a repository or issuing a key', () => {
  const html = renderToStaticMarkup(
    createElement(WorkspacePanels, { panel: 'agents', state: fresh, onClose: vi.fn() }),
  );
  expect(html).toContain('Hosted agents');
  expect(html).toContain('Your own agent');
  expect(html).toContain('Claude Code');
  expect(html).not.toContain('Create agent key');
  expect(html).not.toContain('local agent');
});
