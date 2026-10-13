import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { providerDefinition, providers } from '../../../../shared/providers';
import type { useRepository } from '../../hooks/useRepository';
import { ProviderConnectionForm } from './ProviderConnectionForm';
import { WorkspacePanels } from './WorkspacePanels';
import { WorkspaceRail } from './WorkspaceRail';

const fresh = {
  authenticated: true,
  repositories: [],
  snapshot: null,
  id: '',
  loading: false,
} as unknown as ReturnType<typeof useRepository>;

it('preselects a provider model that can actually be approved for new hosted work', () => {
  const html = renderToStaticMarkup(
    createElement(ProviderConnectionForm, {
      editing: null,
      connections: [],
      disabled: false,
      onCancel: vi.fn(),
      onSaved: async () => {},
    }),
  );
  const selected = [...html.matchAll(/<option value="([^"]+)" selected="">/g)].map((m) => m[1]);
  const [provider, model] = selected;
  expect(provider).toBeTruthy();
  const selectedModel = providerDefinition(provider).models.find((entry) => entry.id === model);
  expect(selectedModel?.conservative_pricing).toBeDefined();
  const price = selectedModel?.conservative_pricing;
  const eligibleRates = providers.flatMap((p) =>
    p.models.flatMap((m) =>
      m.conservative_pricing
        ? [
            m.conservative_pricing.input_microusd_per_million +
              m.conservative_pricing.output_microusd_per_million,
          ]
        : [],
    ),
  );
  expect(
    (price?.input_microusd_per_million ?? Infinity) +
      (price?.output_microusd_per_million ?? Infinity),
  ).toBe(Math.min(...eligibleRates));
});

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
