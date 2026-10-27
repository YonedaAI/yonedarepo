import type { OutboundHandler } from '@cloudflare/containers';
import { providerDefinition } from '../../shared/providers';
import { error, readJson } from './http';
import { attemptLog, failureCode, providerStatusCode } from './logging';
import { grantOutputAllowance, requestUsage } from './model-budget';
import { prepareModelRequest } from './model-policy';
import { trackClaudeUsage } from './model-usage';
import { trackProviderUsage } from './provider-usage';
import { scopeFor } from './scope';
import { ledger, sha } from './storage';
import type { Env, Json, Scope } from './types';
import { providerCredentials } from './vault';
import { workspace } from './workspace';

/** Long agent conversations grow past a few hundred KB; spend is capped by tokens and budgets. */
export const MODEL_REQUEST_LIMIT = 16 * 1024 * 1024;

import {
  reserveWorkspaceSpend,
  settleWorkspaceSpend,
  type WorkspaceSpendContext,
  type WorkspaceSpendReservation,
  workspaceSpendForAttempt,
} from './workspace-spend';
export const modelHandler =
  (provider: 'codex' | 'claude' | 'gemini'): OutboundHandler<Env> =>
  async (req, env, ctx) => {
    const started = Date.now();
    let attempt: Scope | undefined;
    let upstream = false;
    let requestNumber: number | undefined;
    let sharedContext: WorkspaceSpendContext | null = null;
    let sharedReservation: WorkspaceSpendReservation | undefined;
    let countedReservation: Json | undefined;
    try {
      const { scope } = await scopeFor(env, ctx.containerId);
      attempt = scope;
      const job = scope.job;
      if (job.kind !== 'agent' || job.payload.execution.harness !== provider)
        return error('FORBIDDEN', 'Provider outside this attempt scope', 403);
      const path = new URL(req.url).pathname;
      if (req.method !== 'POST') return error('FORBIDDEN', 'POST required', 403);
      const repository = await ledger(env, scope.repo_id, { op: 'repository_status' });
      const owner = repository.workspace ?? '_admin';
      sharedContext = await workspaceSpendForAttempt(env, owner, scope.repo_id, job);
      const prepared = prepareModelRequest(
        job,
        provider,
        path,
        await readJson(req, MODEL_REQUEST_LIMIT),
        sharedContext,
      );
      for (const key of [
        'workspace_spend',
        '_workspace_spend',
        'adaptive_team',
        'approved_model_pool',
        'model_budgets',
      ])
        delete prepared.body[key];
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
      countedReservation = counted;
      // A smaller granted response replaces a refusal near the end of the approved allowance.
      if (Number.isSafeInteger(counted.output_tokens))
        prepared.body = grantOutputAllowance(prepared.body, provider, counted.output_tokens);
      const budgetOwner = owner === '_admin' ? '_budget_claude' : owner;
      const reservationId = await sha(`${scope.repo_id}:${job.id}:${job.epoch}:${counted.number}`);
      const ceiling = sharedContext ? counted.reservation_microusd : prepared.reservation;
      if (sharedContext && !Number.isSafeInteger(ceiling))
        throw new Error('Workspace inference requires a priced run reservation');
      if (ceiling !== undefined) {
        try {
          if (sharedContext) {
            sharedReservation = await reserveWorkspaceSpend(
              env,
              sharedContext,
              reservationId,
              counted,
            );
          } else {
            await workspace(env, budgetOwner, {
              op: 'budget_reserve',
              id: reservationId,
              amount: ceiling,
            });
          }
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
        prepared.reservation && !sharedContext
          ? trackClaudeUsage(
              result,
              env,
              budgetOwner,
              reservationId,
              prepared.reservation,
              job.model,
            )
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
            if (sharedContext && sharedReservation)
              await settleWorkspaceSpend(
                env,
                sharedContext.owner,
                sharedReservation,
                settled.charged_microusd,
                usage,
              );
            return settled;
          })
        : tracked;
    } catch (e: any) {
      if (!upstream && sharedContext && sharedReservation && countedReservation && attempt) {
        try {
          const unused = await ledger(env, attempt.repo_id, {
            op: 'settle_model_request',
            job_id: attempt.job.id,
            epoch: attempt.job.epoch,
            reservation_id: countedReservation.reservation_id,
            input_tokens: 0,
            output_tokens: 0,
          });
          await settleWorkspaceSpend(
            env,
            sharedContext.owner,
            sharedReservation,
            unused.charged_microusd,
            { input_tokens: 0, output_tokens: 0 },
          );
        } catch {
          /* An unconfirmed release keeps its full conservative reservation. */
        }
      }
      if (attempt)
        await attemptLog(env, attempt, upstream ? 'model.transport_failed' : 'model.rejected', {
          request_number: requestNumber,
          duration_ms: Date.now() - started,
          error_code: upstream ? 'PROVIDER_TRANSPORT' : failureCode(e),
        });
      return error(e.code ?? 'MODEL_PROXY', e.message, 409);
    }
  };
