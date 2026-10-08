import type { OutboundHandler } from '@cloudflare/containers';
import { error } from './http';
import { scopeFor } from './scope';
import type { Env, Json } from './types';
export const modelHandler =
  (provider: 'codex' | 'claude'): OutboundHandler<Env> =>
  async (req, env, ctx) => {
    try {
      const { scope, stub } = await scopeFor(env, ctx.containerId);
      const job = scope.job;
      if (job.kind !== 'agent' || job.payload.execution.harness !== provider)
        return error('FORBIDDEN', 'Provider outside this attempt scope', 403);
      const path = new URL(req.url).pathname;
      if (
        req.method !== 'POST' ||
        !(
          provider === 'codex' ? ['/v1/responses'] : ['/v1/messages', '/v1/messages/count_tokens']
        ).includes(path)
      )
        return error('FORBIDDEN', 'Provider endpoint not allowed', 403);
      await stub.modelCall();
      const text = await req.text();
      if (new TextEncoder().encode(text).length > 256 * 1024)
        return error('MODEL_BUDGET', 'Model input exceeds testing budget', 413);
      const body = JSON.parse(text) as Json;
      body.model = job.model;
      if (provider === 'codex') {
        body.max_output_tokens = Math.min(Number(body.max_output_tokens) || 4096, 4096);
        delete body.service_tier;
        body.store = false;
      } else body.max_tokens = Math.min(Number(body.max_tokens) || 4096, 4096);
      const headers = new Headers({ 'content-type': 'application/json' });
      if (provider === 'codex')
        headers.set('authorization', `Bearer ${await env.OPENAI_KEY.get()}`);
      else {
        headers.set('x-api-key', await env.ANTHROPIC_KEY.get());
        headers.set('anthropic-version', '2023-06-01');
        const beta = req.headers.get('anthropic-beta');
        if (beta) headers.set('anthropic-beta', beta);
      }
      return fetch(
        `https://${provider === 'codex' ? 'api.openai.com' : 'api.anthropic.com'}${path}`,
        { method: 'POST', headers, body: JSON.stringify(body) },
      );
    } catch (e: any) {
      return error('MODEL_PROXY', e.message, 409);
    }
  };
