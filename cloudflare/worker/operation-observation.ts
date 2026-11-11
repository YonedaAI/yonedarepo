// Observe existing work. Emission cannot throw into a request and performs no extra I/O.
import {
  type OperationActor,
  type OperationMeasurement,
  type OperationOutcome,
  operationPoint,
} from '../../shared/operation-metrics';
import { log } from './log';
import { capturePolicy, observedRoute, requestSource, requestTraffic } from './operation-context';
import { type OperationLink as Context, operationLinks as contexts } from './operation-links';
import { currentScope } from './request-scope';
import type { Env } from './types';

export type ObservationEnv = Pick<
  Env,
  | 'OPERATION_COMPONENT'
  | 'OPERATION_METRICS'
  | 'OPERATION_FULL_UNTIL'
  | 'OPERATION_DETAIL_EVERY'
  | 'SITE_EVENTS'
  | 'BUILD_REVISION'
  | 'API_REGION'
>;

type Detail = Partial<OperationMeasurement> & {
  kind: OperationMeasurement['kind'];
  operation: string;
  repo?: string;
  origin?: string;
  parentRequestId?: string;
  navigationId?: string;
};
const SLOW_MS = 5_000;
const REPO = /^r[0-9a-f]{20}$/;

/** Domain decisions stay in Rust. This categorizes the result already returned by it. */
export function measuredOutcome(value: unknown, thrown = false): OperationOutcome {
  if (value instanceof Response)
    return value.status >= 500 && value.status !== 507
      ? 'failed'
      : value.status >= 400
        ? 'refused'
        : 'ok';
  const state = (value as { status?: string } | null)?.status;
  if (state === 'deferred' || state === 'pending') return 'retry';
  if (state === 'conflict' || state === 'refused') return 'refused';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'failed')
    return /^(CONFLICT|STALE_HEAD|REPO_FULL|REPO_SIZE_LIMIT|NOT_READY|FORBIDDEN|UNAUTHORIZED|NOT_FOUND|GONE)$/.test(
      String((value as { code?: string })?.code ?? ''),
    )
      ? 'refused'
      : 'failed';
  const error = (value as { error?: { code?: string }; code?: string } | null)?.error;
  const code = error?.code ?? (thrown ? (value as { code?: string } | null)?.code : undefined);
  if (!error && !thrown) return 'ok';
  if (!code || /^(?:DATABASE|INTERNAL|COMPUTE|OVERLOADED|STORAGE|UNAVAILABLE|TIMEOUT)$/.test(code))
    return 'failed';
  return 'refused';
}

export function credentialActor(auth: Record<string, unknown>): OperationActor {
  if ('_system' in auth) return 'system';
  if ('_session' in auth) return 'session';
  if ('_token' in auth || '_pat' in auth) return 'token';
  return '_anonymous' in auth ? 'anonymous' : 'unknown';
}

function context(detail: Detail, env?: ObservationEnv): Context {
  const parent = contexts.getStore();
  const scope = currentScope();
  return {
    span: crypto.randomUUID(),
    source:
      detail.source ??
      parent?.source ??
      scope?.source ??
      (scope?.job ? 'queue' : requestSource(scope?.req)),
    traffic: detail.traffic ?? parent?.traffic ?? requestTraffic(scope?.req),
    origin:
      detail.origin ??
      parent?.origin ??
      (scope?.job
        ? scope.job.origin_route && /^[A-Za-z0-9_:/ .-]{1,128}$/.test(scope.job.origin_route)
          ? scope.job.origin_route
          : `job.${scope.job.kind ?? 'unknown'}`
        : scope?.req
          ? observedRoute(scope.req)
          : 'unknown'),
    fullUntil: parent?.fullUntil ?? capturePolicy(env ?? {}).fullUntil ?? undefined,
    selected: parent?.selected ?? Math.random() * capturePolicy(env ?? {}).detailEvery < 1,
  };
}

/** Every completed operation has a point. Trace selection never changes metric sampling. */
export function emitOperation(
  env: ObservationEnv,
  detail: Detail,
  elapsedMs: number,
  outcome: OperationOutcome,
  ctx = context(detail, env),
  parent?: string,
) {
  try {
    const policy = capturePolicy(env);
    if (!policy.enabled) return;
    const m: OperationMeasurement = {
      ...detail,
      kind: detail.kind,
      operation: detail.operation,
      source: ctx.source,
      traffic: ctx.traffic,
      actor: detail.actor ?? 'unknown',
      outcome,
      elapsedMs: Math.max(0, elapsedMs),
      revision: env.BUILD_REVISION,
      component: ['front', 'platform', 'managed'].includes(env.OPERATION_COMPONENT ?? '')
        ? env.OPERATION_COMPONENT
        : 'unknown',
      region: env.API_REGION ?? '',
      authorityRegion: detail.authorityRegion ?? '',
    };
    try {
      env.SITE_EVENTS?.writeDataPoint(operationPoint(m));
    } catch {
      const scope = currentScope();
      if (!scope?.metricFailureLogged) {
        if (scope) scope.metricFailureLogged = true;
        log.warn('operation.metric_lost', { operation: detail.operation, component: m.component });
      }
    }
    if (ctx.selected || ['failed', 'cancelled'].includes(outcome) || elapsedMs >= SLOW_MS) {
      log.info(`${detail.kind}.operation`, {
        component: m.component,
        operation: detail.operation,
        source: ctx.source,
        traffic: ctx.traffic,
        actor: m.actor,
        origin: ctx.origin,
        parent_request_id: detail.parentRequestId,
        navigation_id: detail.navigationId,
        span_id: ctx.span,
        parent_span_id: parent,
        outcome,
        elapsed_ms: m.elapsedMs,
        status: detail.status,
        attempt: detail.attempt,
        bytes: detail.bytes,
        queue_wait_ms: detail.queueWaitMs,
        first_byte_ms: detail.firstByteMs,
        region: m.region,
        authority_region: m.authorityRegion,
        ...(detail.repo && REPO.test(detail.repo) ? { repo: detail.repo } : {}),
      });
    }
  } catch {
    // Reporting is best effort. A lost point is not a successful product operation.
  }
}

export async function observeOperation<T>(
  env: ObservationEnv,
  detail: Detail,
  run: () => Promise<T>,
): Promise<T> {
  if (env.OPERATION_METRICS !== 'on') return run();
  const parent = contexts.getStore()?.span ?? currentScope()?.job?.parent_span_id;
  const ctx = context(detail, env);
  const started = performance.now();
  return contexts.run(ctx, async () => {
    if (ctx.selected && detail.kind !== 'request')
      try {
        log.info(`${detail.kind}.started`, {
          operation: detail.operation,
          source: ctx.source,
          traffic: ctx.traffic,
          origin: ctx.origin,
          span_id: ctx.span,
          parent_span_id: parent,
          ...(detail.repo && REPO.test(detail.repo) ? { repo: detail.repo } : {}),
        });
      } catch {
        /* Metadata cannot change execution. */
      }
    let outcome: OperationOutcome = 'unknown';
    let status: number | undefined;
    try {
      const value = await run();
      outcome =
        detail.kind === 'background' && value === undefined ? 'unknown' : measuredOutcome(value);
      if (value instanceof Response) status = value.status;
      return value;
    } catch (e) {
      outcome = measuredOutcome(e, true);
      throw e;
    } finally {
      emitOperation(
        env,
        { ...detail, status: status ?? detail.status },
        performance.now() - started,
        ctx.outcome ?? outcome,
        ctx,
        parent,
      );
    }
  });
}

/** The root is kept even when its detail sample misses: all child calls have an initiator. */
export async function observeRequest(
  env: ObservationEnv,
  req: Request,
  run: () => Promise<Response>,
) {
  if (env.OPERATION_METRICS !== 'on') return run();
  const operation = observedRoute(req);
  return observeOperation(env, { kind: 'request', operation }, async () => {
    try {
      log.info('request.origin', {
        operation,
        source: requestSource(req),
        traffic: requestTraffic(req),
        origin: contexts.getStore()?.origin,
        span_id: contexts.getStore()?.span,
      });
    } catch {
      /* Metadata cannot change the response. */
    }
    return run();
  });
}

/** Capture a stream's original context before returning its response to the runtime. */
export function operationRecorder(env: ObservationEnv, detail: Detail) {
  if (env.OPERATION_METRICS !== 'on')
    return (
      _elapsed: number,
      _outcome: OperationOutcome,
      _extra: Partial<OperationMeasurement> = {},
    ) => {};
  const ctx = context(detail, env);
  const parent = contexts.getStore()?.span ?? currentScope()?.job?.parent_span_id;
  return (
    elapsedMs: number,
    outcome: OperationOutcome,
    extra: Partial<OperationMeasurement> = {},
  ) => emitOperation(env, { ...detail, ...extra }, elapsedMs, outcome, ctx, parent);
}

/** Ack/retry evidence is recorded by the adapter after the real queue action. */
export function markOperationOutcome(outcome: OperationOutcome) {
  const ctx = contexts.getStore();
  if (ctx) ctx.outcome = outcome;
}
