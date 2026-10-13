import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AgentRoster } from './AgentRoster';
import { automaticAgent, compareBuilders } from './adaptiveDraft';
import { CompareApprovalNotice } from './CompareApprovalNotice';

it('Compare has exactly two editable builders and a reviewer explanation without a third model control', () => {
  const html = renderToStaticMarkup(
    createElement(AgentRoster, {
      agents: compareBuilders([automaticAgent()]),
      providers: [],
      loading: false,
      error: '',
      locked: false,
      compare: true,
      limits: {
        min_root_agents: 1,
        max_root_agents: 6,
        max_run_executions: 12,
        max_delegation_depth: 2,
        max_run_model_requests: 60,
      },
      onChange: () => {},
      onProviders: () => {},
      onRetry: () => {},
    }),
  );
  expect(html).toContain('Builder 1');
  expect(html).toContain('Builder 2');
  expect(html).not.toContain('Add agent');
  expect(html).not.toContain('Remove agent');
  expect(html).not.toContain('Model for agent 3');
  const explanation = renderToStaticMarkup(createElement(CompareApprovalNotice));
  expect(explanation).toContain('Automatic reviewer · Auto');
  expect(explanation).toContain('up to two repairs');
  expect(explanation).toContain('You confirm what gets published');
});

it('a new Compare draft preserves explicit model/effort preferences without changing the historical roster', () => {
  const historical = [
    {
      id: 'old',
      connection: 'sol',
      role: 'backend' as const,
      reasoning_effort: 'high',
      strategy: 'Backend',
    },
  ];
  const builders = compareBuilders(historical);
  expect(builders[0]).toEqual(historical[0]);
  expect(builders[1]).toMatchObject({ connection: '', role: 'auto' });
  expect(historical).toHaveLength(1);
});
