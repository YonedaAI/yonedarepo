import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ModelBudgetUsage } from './ModelBudgetUsage';

const budget = {
  provider: 'zai',
  model: 'glm-5.3-flash',
  max_requests: null,
  max_output_tokens: 4096,
  max_execution_ms: 600000,
  spend_limit_microusd: 2000,
  pricing: {
    input_microusd_per_million: 150000,
    output_microusd_per_million: 500000,
    source: 'owner-approved conservative rates',
  },
  requests: 2,
  charged_microusd: 1185,
};

it('shows a sandbox run its metered spend and tokens, not an estimate', () => {
  const html = renderToStaticMarkup(
    createElement(ModelBudgetUsage, {
      run: {
        runtime: 'sandbox-cli-v1',
        model_budgets: [budget],
        metered_usage: {
          'zai/glm-5.3-flash': {
            requests: 2,
            input_tokens: 1200,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 300,
            output_tokens: 420,
            charged_microusd: 1185,
          },
        },
      },
    }),
  );
  expect(html).toContain('Spend (metered)');
  expect(html).toContain('6,500 in / 420 out');
  expect(html).not.toContain('estimate');
});

it('keeps the reservation wording for other runs', () => {
  const html = renderToStaticMarkup(
    createElement(ModelBudgetUsage, { run: { model_budgets: [budget] } }),
  );
  expect(html).toContain('Allowance used (estimate)');
  expect(html).not.toContain('Tokens');
});
