import type { OutboundHandler } from '@cloudflare/containers';
import { providerDefinition } from '../../shared/providers';
import { error, readJson } from './http';
import { attemptLog, failureCode, providerStatusCode } from './logging';
import { requestUsage } from './model-budget';
import { prepareModelRequest } from './model-policy';
import { trackClaudeUsage } from './model-usage';
import { trackProviderUsage } from './provider-usage';
import { scopeFor } from './scope';
import { ledger, sha } from './storage';
import type { Env, Scope } from './types';
import { providerCredentials } from './vault';
import { workspace } from './workspace';
export const modelHandler =
  (provider: 'codex' | 'claude' | 'gemini'): OutboundHandler<Env> =>
  async (req, env, ctx) => {
    const started = Date.now();
    let attempt: Scope | undefined;
    let upstream = false;
    let requestNumber: number | undefined;
    try {
      const { scope } = await scopeFor(env, ctx.containerId);
      attempt = scope;
      const job = scope.job;
      if (job.kind !== 'agent' || job.payload.execution.harness !== provider)
        return error('FORBIDDEN', 'Provider outside this attempt scope', 403);
      const path = new URL(req.url).pathname;
      if (req.method !== 'POST') return error('FORBIDDEN', 'POST required', 403);
      const prepared = prepareModelRequest(job, provider, path, await readJson(req, 256 * 1024));
      const repository = await ledger(env, scope.repo_id, { op: 'repository_status' });
      const owner = repository.workspace ?? '_admin';
      const trialPolicy =
        owner === '_admin' ? null : await workspace(env, owner, { op: 'reviewer_status' });
      const reviewer = Boolean(trialPolicy?.repo_id);
      if (
        reviewer &&
        (trialPolicy?.revoked ||
          trialPolicy?.expires <= Date.now() ||
          trialPolicy?.repo_id !== scope.repo_id)
      )
        throw Object.assign(new Error('Reviewer inference access expired or outside sandbox'), {
          code: 'REVIEWER_EXPIRED',
        });
      const { key } = await providerCredentials(
        env,
        owner,
        prepared.provider,
        job.payload.execution.connection,
        job.model,
        job.payload.execution.routing,
      );
      const counted = await ledger(env, scope.repo_id, {
        op: 'reserve_request',
        job_id: job.id,
        epoch: job.epoch,
        kind: 'model',
        ...requestUsage(prepared.body, provider),
        count_only: path.endsWith('/count_tokens') || path.endsWith(':countTokens'),
      });
      requestNumber = counted.number;
      const budgetOwner = owner === '_admin' ? '_budget_claude' : owner;
      const reservationId = await sha(`${scope.repo_id}:${job.id}:${job.epoch}:${counted.number}`);
      const ceiling = reviewer ? counted.reservation_microusd : prepared.reservation;
      if (reviewer && !Number.isSafeInteger(ceiling))
        throw new Error('Reviewer inference requires a priced run reservation');
      if (ceiling !== undefined) {
        try {
          await workspace(env, budgetOwner, {
            op: 'budget_reserve',
            id: reservationId,
            amount: ceiling,
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
      const definition = providerDefinition(prepared.provider);
      headers.set(definition.auth_header, definition.auth_prefix + key);
      if (provider === 'claude') headers.set('anthropic-version', '2023-06-01');
      await attemptLog(env, scope, 'model.request_started', { request_number: requestNumber });
      upstream = true;
      const result = await fetch(prepared.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(prepared.body),
        redirect: 'manual',
      });
      if (result.status >= 300 && result.status < 400)
        throw new Error('Provider redirected the request; no credentials were forwarded');
      await attemptLog(env, scope, 'model.response_headers', {
        request_number: requestNumber,
        http_status: result.status,
        duration_ms: Date.now() - started,
        error_code: providerStatusCode(result.status),
      });
      const tracked =
        prepared.reservation && !reviewer
          ? trackClaudeUsage(result, env, budgetOwner, reservationId, prepared.reservation)
          : result;
      return counted.reservation_id
        ? trackProviderUsage(tracked, provider, async (usage) => {
            const settled = await ledger(env, scope.repo_id, {
              op: 'settle_model_request',
              job_id: job.id,
              epoch: job.epoch,
              reservation_id: counted.reservation_id,
              ...usage,
            });
            if (reviewer)
              await workspace(env, owner, {
                op: 'budget_settle',
                id: reservationId,
                amount: settled.charged_microusd,
              });
            return settled;
          })
        : tracked;
    } catch (e: any) {
      if (attempt)
        await attemptLog(env, attempt, upstream ? 'model.transport_failed' : 'model.rejected', {
          request_number: requestNumber,
          duration_ms: Date.now() - started,
          error_code: upstream ? 'PROVIDER_TRANSPORT' : failureCode(e),
        });
      return error(e.code ?? 'MODEL_PROXY', e.message, 409);
    }
  };
