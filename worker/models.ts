import type { OutboundHandler } from '@cloudflare/containers';
import { error, readJson } from './http';
import { prepareModelRequest } from './model-policy';
import { trackClaudeUsage } from './model-usage';
import { scopeFor } from './scope';
import { ledger, sha } from './storage';
import type { Env } from './types';
import { providerKey } from './vault';
import { workspace } from './workspace';
export const modelHandler =
  (provider: 'codex' | 'claude'): OutboundHandler<Env> =>
  async (req, env, ctx) => {
    try {
      const { scope } = await scopeFor(env, ctx.containerId);
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
      if (req.method !== 'POST') return error('FORBIDDEN', 'POST required', 403);
      const prepared = prepareModelRequest(job, provider, path, await readJson(req, 256 * 1024));
      const snapshot = await ledger(env, scope.repo_id, { op: 'snapshot' });
      const owner = snapshot.repository.workspace ?? '_admin';
      const key = await providerKey(env, owner, prepared.provider);
      const counted = await ledger(env, scope.repo_id, {
        op: 'reserve_request',
        job_id: job.id,
        epoch: job.epoch,
        kind: 'model',
      });
      const budgetOwner = owner === '_admin' ? '_budget_claude' : owner;
      const reservationId = await sha(`${scope.repo_id}:${job.id}:${job.epoch}:${counted.number}`);
      if (prepared.reservation)
        await workspace(env, budgetOwner, {
          op: 'budget_reserve',
          id: reservationId,
          amount: prepared.reservation,
        });
      const headers = new Headers({ 'content-type': 'application/json' });
      if (prepared.provider !== 'claude') headers.set('authorization', `Bearer ${key}`);
      else {
        headers.set('x-api-key', key);
      }
      if (provider === 'claude') headers.set('anthropic-version', '2023-06-01');
      const result = await fetch(prepared.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(prepared.body),
        redirect: 'manual',
      });
      if (result.status >= 300 && result.status < 400)
        throw new Error('Provider redirected the request; no credentials were forwarded');
      return prepared.reservation
        ? trackClaudeUsage(result, env, budgetOwner, reservationId, prepared.reservation)
        : result;
    } catch (e: any) {
      return error(e.code ?? 'MODEL_PROXY', e.message, 409);
    }
  };
