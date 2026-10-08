import type { OutboundHandler } from '@cloudflare/containers';
import { error, readJson } from './http';
import { requestUsage } from './model-budget';
import { prepareModelRequest } from './model-policy';
import { trackClaudeUsage } from './model-usage';
import { trackProviderUsage } from './provider-usage';
import { scopeFor } from './scope';
import { ledger, sha } from './storage';
import type { Env } from './types';
import { providerKey } from './vault';
import { workspace } from './workspace';
export const modelHandler =
  (provider: 'codex' | 'claude' | 'gemini'): OutboundHandler<Env> =>
  async (req, env, ctx) => {
    try {
      const { scope } = await scopeFor(env, ctx.containerId);
      const job = scope.job;
      if (job.kind !== 'agent' || job.payload.execution.harness !== provider)
        return error('FORBIDDEN', 'Provider outside this attempt scope', 403);
      const path = new URL(req.url).pathname;
      if (req.method !== 'POST') return error('FORBIDDEN', 'POST required', 403);
      const prepared = prepareModelRequest(job, provider, path, await readJson(req, 256 * 1024));
      const snapshot = await ledger(env, scope.repo_id, { op: 'snapshot' });
      const owner = snapshot.repository.workspace ?? '_admin';
      const key = await providerKey(
        env,
        owner,
        prepared.provider,
        job.payload.execution.connection,
        job.model,
      );
      const counted = await ledger(env, scope.repo_id, {
        op: 'reserve_request',
        job_id: job.id,
        epoch: job.epoch,
        kind: 'model',
        ...requestUsage(prepared.body, provider),
        count_only: path.endsWith('/count_tokens') || path.endsWith(':countTokens'),
      });
      const budgetOwner = owner === '_admin' ? '_budget_claude' : owner;
      const reservationId = await sha(`${scope.repo_id}:${job.id}:${job.epoch}:${counted.number}`);
      if (prepared.reservation) {
        try {
          await workspace(env, budgetOwner, {
            op: 'budget_reserve',
            id: reservationId,
            amount: prepared.reservation,
          });
        } catch (failure) {
          // No upstream request has been sent. Release only this known-unused run reservation.
          if (counted.reservation_id) {
            try {
              await ledger(env, scope.repo_id, {
                op: 'settle_model_request',
                job_id: job.id,
                epoch: job.epoch,
                reservation_id: counted.reservation_id,
                input_tokens: 0,
                output_tokens: 0,
              });
            } catch {
              /* Retain the reservation if the release cannot be confirmed. */
            }
          }
          throw failure;
        }
      }
      const headers = new Headers({ 'content-type': 'application/json' });
      if (prepared.provider === 'gemini') headers.set('x-goog-api-key', key);
      else if (prepared.provider !== 'claude') headers.set('authorization', `Bearer ${key}`);
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
      const tracked = prepared.reservation
        ? trackClaudeUsage(result, env, budgetOwner, reservationId, prepared.reservation)
        : result;
      return counted.reservation_id
        ? trackProviderUsage(tracked, provider, (usage) =>
            ledger(env, scope.repo_id, {
              op: 'settle_model_request',
              job_id: job.id,
              epoch: job.epoch,
              reservation_id: counted.reservation_id,
              ...usage,
            }),
          )
        : tracked;
    } catch (e: any) {
      return error(e.code ?? 'MODEL_PROXY', e.message, 409);
    }
  };
