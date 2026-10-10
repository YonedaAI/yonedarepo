import { reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareModelRequest } from '../../cloudflare/worker/model-policy';
import { modelHandler } from '../../cloudflare/worker/models';
import { ledger } from '../../cloudflare/worker/storage';
import type { Json, Scope } from '../../cloudflare/worker/types';
import { seal } from '../../cloudflare/worker/vault';
import { workspace } from '../../cloudflare/worker/workspace';
import { containerBindings, readyReviewer } from './reviewer-fixture';

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

function job(ceiling = 4096, provider = 'claude', configuredModel?: string): Json {
  const model = configuredModel ?? (provider === 'claude' ? 'claude-sonnet-4-6' : 'test-model');
  return {
    kind: 'agent',
    model,
    payload: {
      execution: { provider, harness: 'claude' },
      run: { model_budgets: [{ provider, model, max_output_tokens: ceiling }] },
    },
  };
}

it.each([
  [{ type: 'enabled', budget_tokens: 10000, display: 'updates' }, { type: 'adaptive', display: 'summarized' }],
  [{ type: 'disabled' }, { type: 'between_tools' }],
  [{ type: 'adaptive', display: 'updates' }, { type: 'adaptive', display: 'summarized' }],
])('adapts legacy CLI thinking to Sonnet 5.5 without changing signed history: %j', (thinking, expected) => {
  const messages = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Synthetic note', signature: 'unchanged-test-signature' }] }];
  const input = { max_tokens: 99999, thinking, messages, output_config: { effort: 'low' } };
  const { body, reservation } = prepareModelRequest(job(4096, 'claude', 'claude-sonnet-5-5'), 'claude', '/v1/messages', input);
  expect(body.thinking).toEqual(expected);
  expect(body.messages).toEqual(messages);
  expect(body.output_config).toEqual({ effort: 'low' });
  expect(body.max_tokens).toBe(4096);
  expect(reservation).toBe((new TextEncoder().encode(JSON.stringify(body)).length + 8192) * 4 + 4096 * 10);
  expect(input.thinking).toEqual(thinking);
});

it('rejects unsupported forced tool selection for Sonnet 5.5 before provider spending', () => {
  expect(() => prepareModelRequest(job(4096, 'claude', 'claude-sonnet-5-5'), 'claude', '/v1/messages', { tool_choice: { type: 'any' } })).toThrow('Forced tool');
});

it.each([4096, 10000])('keeps manual thinking budget %s below the clamped output cap', (budget) => {
  // Without the interleaved-thinking beta header Anthropic requires
  // 1024 <= budget_tokens < max_tokens, even when the client requested more.
  const input = {
    max_tokens: 16384,
    thinking: { type: 'enabled', budget_tokens: budget },
    messages: [{ role: 'user', content: 'Synthetic hello' }],
  };
  const original = structuredClone(input);
  const { body } = prepareModelRequest(job(), 'claude', '/v1/messages', input);
  expect(body.max_tokens).toBe(4096);
  expect(body.thinking.type).toBe('enabled');
  expect(body.thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
  expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
  expect(input).toEqual(original);
});

it('makes the pinned CLI adaptive display valid without its beta header', () => {
  // Captured locally from Claude Code 2.1.293 in the pinned execution image,
  // with the runtime's 4096 output cap and low effort. No inference occurred.
  const input = {
    max_tokens: 4096,
    thinking: { type: 'adaptive', display: 'updates' },
    output_config: { effort: 'low' },
  };
  const { body } = prepareModelRequest(job(), 'claude', '/v1/messages', input);
  expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  expect(body.output_config).toEqual(input.output_config);
  expect(body.max_tokens).toBe(4096);
  expect(input.thinking.display).toBe('updates');
});

it.each([
  [4096, 2048, 10000, 2047],
  [8192, 16384, 10000, 8191],
  [4096, 4096, 1024, 1024],
  [1025, 4096, 10000, 1024],
])(
  'respects owner cap %s, requested output %s and thinking budget %s',
  (cap, output, budget, expected) => {
    const { body, reservation } = prepareModelRequest(job(cap), 'claude', '/v1/messages', {
      max_tokens: output,
      thinking: { type: 'enabled', budget_tokens: budget, display: 'omitted' },
    });
    expect(body.max_tokens).toBe(Math.min(cap, output));
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: expected, display: 'omitted' });
    // Conservative reservation still covers the final body and the full output cap.
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    expect(reservation).toBe((bytes + 8192) * 6 + body.max_tokens * 30);
  },
);

it.each([1, 512, 1024])(
  'disables manual thinking when cap %s cannot fit the API minimum',
  (cap) => {
    const { body } = prepareModelRequest(job(cap), 'claude', '/v1/messages', {
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 10000, display: 'updates' },
    });
    expect(body.max_tokens).toBe(cap);
    expect(body.thinking).toEqual({ type: 'disabled' });
  },
);

it.each([undefined, null, '2048', 1023, 1024.5, -1])(
  'rejects malformed manual budget %s before forwarding',
  (budget) => {
    expect(() =>
      prepareModelRequest(job(), 'claude', '/v1/messages', {
        thinking: { type: 'enabled', budget_tokens: budget },
      }),
    ).toThrow('integer budget of at least 1024');
  },
);

it.each([
  undefined,
  { type: 'disabled' },
  { type: 'adaptive' },
  { type: 'adaptive', display: 'omitted' },
])('preserves stable thinking configuration %j and low effort', (thinking) => {
  const input = { max_tokens: 99999, thinking, output_config: { effort: 'low' } };
  const { body } = prepareModelRequest(job(), 'claude', '/v1/messages', input);
  expect(body.max_tokens).toBe(4096);
  expect(body.thinking).toEqual(thinking);
  expect(body.output_config).toEqual(input.output_config);
});

it.each(['mimo', 'zai'])('preserves third-party %s thinking semantics', (provider) => {
  const thinking = { type: 'enabled', budget_tokens: 10000, display: 'updates' };
  const { body } = prepareModelRequest(job(512, provider), 'claude', '/v1/messages', {
    max_tokens: 4096,
    thinking,
  });
  expect(body.max_tokens).toBe(512);
  expect(body.thinking).toEqual(thinking);
});

it.each([{ type: 'enabled', budget_tokens: 10000 }, { type: 'adaptive' }, { type: 'disabled' }])(
  'keeps count_tokens free of an output cap and reservation with thinking %j',
  (thinking) => {
    const { body, reservation, url } = prepareModelRequest(
      job(512),
      'claude',
      '/v1/messages/count_tokens',
      {
        max_tokens: 4096,
        thinking,
        messages: [{ role: 'user', content: 'Synthetic count' }],
      },
    );
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.thinking).toEqual(thinking);
    expect(reservation).toBe(0);
    expect(url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
  },
);

it.each([
  ['/v1/messages', { type: 'enabled', budget_tokens: 10000, display: 'updates' }],
  ['/v1/messages', { type: 'adaptive', display: 'updates' }],
  ['/v1/messages/count_tokens', { type: 'enabled', budget_tokens: 10000, display: 'updates' }],
])(
  'forwards compatible Claude JSON to a synthetic upstream through workerd: %s %j',
  async (path, thinking) => {
    const f = await readyReviewer();
    const connection = 'synthetic-thinking';
    await workspace(f.scoped, f.owner, {
      op: 'provider_put',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      connection,
      sealed: await seal(f.scoped, f.owner, 'claude', 'synthetic-thinking-key', connection),
    });
    await ledger(f.scoped, f.repo, {
      op: 'start_run',
      id: 'thinking-fixture',
      intent: 'Synthetic compatibility test',
      agents: [
        { provider: 'claude', model: 'claude-sonnet-4-6', connection, strategy: 'Local test' },
      ],
      model_budgets: [
        {
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          max_requests: 3,
          max_output_tokens: 4096,
          max_execution_ms: 120000,
          spend_limit_microusd: 1000000,
          pricing: {
            input_microusd_per_million: 1000000,
            output_microusd_per_million: 5000000,
            source: 'owner-approved conservative rates',
          },
        },
      ],
    });
    const claimed = await ledger(f.scoped, f.repo, {
      op: 'claim',
      job_id: 'job:thinking-fixture:agent-1',
    });
    const scope: Scope = {
      repo_id: f.repo,
      job: claimed,
      supervisor: 'synthetic-supervisor',
      model_calls: 0,
      created_at: Date.now(),
    };
    const container = containerBindings(f.scoped, scope);
    const upstream = vi.fn(async (url: unknown, init: RequestInit) => {
      expect(url).toBe(`https://api.anthropic.com${path}`);
      expect(new Headers(init.headers).has('anthropic-beta')).toBe(false);
      const body = JSON.parse(String(init.body));
      // These are documented API validity checks, not a real Anthropic response.
      if (body.thinking.display === 'updates')
        return Response.json(
          { error: 'Synthetic HTTP400: updates requires beta' },
          { status: 400 },
        );
      if (
        path === '/v1/messages' &&
        body.thinking.type === 'enabled' &&
        (body.thinking.budget_tokens < 1024 || body.thinking.budget_tokens >= body.max_tokens)
      )
        return Response.json(
          { error: 'Synthetic HTTP400: invalid thinking budget' },
          { status: 400 },
        );
      expect(body.thinking.type).toBe(thinking.type);
      expect(body.thinking.display).toBe('summarized');
      expect(body.output_config).toEqual({ effort: 'low' });
      if (path.endsWith('/count_tokens')) {
        expect(body).not.toHaveProperty('max_tokens');
        expect(body.thinking.budget_tokens).toBe(10000);
        return Response.json({ input_tokens: 100 });
      }
      expect(body.max_tokens).toBe(4096);
      return Response.json({ type: 'message', usage: { input_tokens: 100, output_tokens: 5 } });
    });
    vi.stubGlobal('fetch', upstream);
    const response = await modelHandler('claude')(
      new Request(`http://claude.yoneda.internal${path}?beta=true`, {
        method: 'POST',
        headers: {
          'anthropic-beta': 'interleaved-thinking-2025-05-14,thinking-display-updates-2026-08-18',
        },
        body: JSON.stringify({
          max_tokens: 16384,
          thinking,
          output_config: { effort: 'low' },
          messages: [{ role: 'user', content: 'Synthetic hello' }],
        }),
      }),
      container.scoped,
      { containerId: 'synthetic-container' } as Parameters<ReturnType<typeof modelHandler>>[2],
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream).toHaveBeenCalledOnce();
  },
);
