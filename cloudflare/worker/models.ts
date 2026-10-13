import type { OutboundHandler } from '@cloudflare/containers';
import { providerDefinition } from '../../shared/providers';
import { observeCampaignModelLimit } from './campaign-model-limit';
import {
  campaignForAttempt,
  reserveCampaignUsage,
  settleCampaignUsage,
  verifyCampaignReservation,
} from './campaign-usage';
import { error, readJson } from './http';
import { attemptLog, failureCode, providerStatusCode } from './logging';
import { requestUsage } from './model-budget';
import { prepareModelRequest } from './model-policy';
import { trackClaudeUsage } from './model-usage';
import { trackProviderUsage } from './provider-usage';
import { scopeFor } from './scope';
import { ledger, sha } from './storage';
import type { Env, Json, Scope } from './types';
import { providerCredentials } from './vault';
import { workspace } from './workspace';
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
        await readJson(req, 256 * 1024),
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
      const trialPolicy =
        owner === '_admin' ? null : await workspace(env, owner, { op: 'reviewer_status' });
      const campaign = await campaignForAttempt(env, owner, scope.repo_id, job);
      const legacyTrial =
        !sharedContext &&
        trialPolicy?.repo_id === scope.repo_id &&
        (trialPolicy?.active_trial === job.payload.execution.run_id ||
          job.payload.execution.run_id?.startsWith('reviewer-'));
      const reviewer =
        !sharedContext && Boolean(trialPolicy?.repo_id) && Boolean(campaign || legacyTrial);
      if (
        reviewer &&
        (trialPolicy?.revoked ||
          trialPolicy?.expires <= Date.now() ||
          (trialPolicy?.repo_id !== scope.repo_id && !campaign))
      )
        throw Object.assign(new Error('Reviewer inference access expired or outside sandbox'), {
          code: 'REVIEWER_EXPIRED',
        });
      if (
        reviewer &&
        campaign?.access === 'reviewer' &&
        prepared.provider !== 'codex' &&
        !(
          prepared.provider === 'claude' &&
          job.model === 'claude-opus-5-5' &&
          job.payload.execution.campaign_opus === true
        )
      )
        throw Object.assign(new Error('Reviewer campaign execution permits metered Codex only'), {
          code: 'FORBIDDEN',
        });
      const { key } = await providerCredentials(
        env,
        owner,
        prepared.provider,
        job.payload.execution.connection,
        job.model,
        job.payload.execution.routing,
        job.payload.execution.comparison_approval_id != null
          ? job.payload.execution.version
          : undefined,
      );
      const counted = await ledger(env, scope.repo_id, {
        op: 'reserve_request',
        job_id: job.id,
        epoch: job.epoch,
        kind: 'model',
        ...(sharedContext?.comparison_approval_id
          ? { comparison_approval_id: sharedContext.comparison_approval_id }
          : {}),
        ...requestUsage(prepared.body, provider),
        count_only: path.endsWith('/count_tokens') || path.endsWith(':countTokens'),
      }).catch(async (failure) => {
        if (campaign && failure?.code === 'MODEL_REQUEST_LIMIT')
          await observeCampaignModelLimit(env, owner, scope.repo_id, job);
        throw failure;
      });
      requestNumber = counted.number;
      countedReservation = counted;
      const budgetOwner = owner === '_admin' ? '_budget_claude' : owner;
      const reservationId = await sha(
        `${sharedContext?.comparison_approval_id ? `${sharedContext.comparison_approval_id}:` : ''}${scope.repo_id}:${job.id}:${job.epoch}:${counted.number}`,
      );
      const ceiling =
        sharedContext || reviewer || campaign ? counted.reservation_microusd : prepared.reservation;
      if ((sharedContext || reviewer || campaign) && !Number.isSafeInteger(ceiling))
        throw new Error('Reviewer inference requires a priced run reservation');
      if (ceiling !== undefined) {
        try {
          verifyCampaignReservation(campaign, counted);
          if (sharedContext) {
            sharedReservation = await reserveWorkspaceSpend(
              env,
              sharedContext,
              reservationId,
              counted,
            );
          } else if (campaign) {
            await reserveCampaignUsage(
              env,
              owner,
              campaign,
              reservationId,
              prepared.provider,
              job.model,
              prepared.body,
              provider,
              ceiling,
              path.endsWith('/count_tokens') || path.endsWith(':countTokens'),
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
                ...(sharedContext?.comparison_approval_id
                  ? { comparison_approval_id: sharedContext.comparison_approval_id }
                  : {}),
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
          if (campaign && (failure as { code?: string }).code === 'CAMPAIGN_MODEL_REQUEST_LIMIT')
            await observeCampaignModelLimit(env, owner, scope.repo_id, job);
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
        prepared.reservation && !sharedContext && !reviewer && !campaign
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
              ...(sharedContext?.comparison_approval_id
                ? { comparison_approval_id: sharedContext.comparison_approval_id }
                : {}),
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
            else if (campaign)
              await settleCampaignUsage(
                env,
                owner,
                campaign,
                reservationId,
                prepared.provider,
                job.model,
                usage,
              );
            else if (reviewer)
              await workspace(env, owner, {
                op: 'budget_settle',
                id: reservationId,
                amount: settled.charged_microusd,
              });
            return settled;
          })
        : tracked;
    } catch (e: any) {
      if (!upstream && sharedContext && sharedReservation && countedReservation && attempt) {
        try {
          const unused = await ledger(env, attempt.repo_id, {
            op: 'settle_model_request',
            ...(sharedContext?.comparison_approval_id
              ? { comparison_approval_id: sharedContext.comparison_approval_id }
              : {}),
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
