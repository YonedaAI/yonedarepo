// Client-reported timings, not proof that a request was human or that a write committed.
// Never resolve a repository or read account state just to validate telemetry.
import { readJson } from './http';
import { performanceRoute } from './operation-context';
import { emitOperation } from './operation-observation';
import { sentByBrowser } from './traffic-class';
import type { Env } from './types';

const NAMES = new Set(['navigation_ready_ms', 'readme_ready_ms', 'ttfb_ms', 'api_ms']);
const MAX_MS = 3_600_000;
const ID = /^[A-Za-z0-9._-]{8,64}$/;

export async function clientPerformance(req: Request, env: Env): Promise<Response> {
  try {
    const origin = new URL(req.url).origin;
    const site = req.headers.get('sec-fetch-site');
    if (
      env.CLIENT_PERFORMANCE !== 'on' ||
      env.OPERATION_METRICS !== 'on' ||
      req.method !== 'POST' ||
      req.headers.get('origin') !== origin ||
      (site && site !== 'same-origin') ||
      !sentByBrowser(req)
    )
      return empty();
    const address = req.headers.get('cf-connecting-ip') ?? 'local';
    if (
      env.AUTH_LIMITER &&
      !(await env.AUTH_LIMITER.limit({ key: `performance:${address}` })).success
    )
      return empty();
    const body = await readJson(req, 4096);
    if (typeof body.path !== 'string') return empty();
    const route = performanceRoute(body.path);
    if (!route || !Array.isArray(body.metrics) || body.metrics.length > 10) return empty();
    const navigation =
      typeof body.navigation === 'string' && ID.test(body.navigation) ? body.navigation : undefined;
    for (const m of body.metrics) {
      if (
        !m ||
        typeof m.name !== 'string' ||
        !NAMES.has(m.name) ||
        typeof m.ms !== 'number' ||
        !Number.isFinite(m.ms) ||
        m.ms < 0 ||
        m.ms > MAX_MS
      )
        continue;
      const status =
        typeof m.status === 'number' &&
        Number.isInteger(m.status) &&
        m.status >= 100 &&
        m.status <= 599
          ? m.status
          : undefined;
      const request =
        typeof m.requestId === 'string' && ID.test(m.requestId) ? m.requestId : undefined;
      const outcome =
        m.outcome === 'failed' || m.outcome === 'cancelled'
          ? m.outcome
          : status && status >= 500 && status !== 507
            ? 'failed'
            : status && status >= 400
              ? 'refused'
              : 'ok';
      emitOperation(
        env,
        {
          kind: 'browser',
          operation: `${m.name} ${route}`,
          source: 'web',
          traffic:
            req.headers.get('x-yoneda-own-traffic') === '1' ? 'marked_automation' : 'ordinary',
          actor: 'unknown',
          status,
          parentRequestId: request,
          navigationId: navigation,
        },
        m.ms,
        outcome,
      );
    }
    // Navigation ids are private correlation metadata, not caller identities.
  } catch {
    /* A blocked or invalid beacon must never affect the page. */
  }
  return empty();
}
const empty = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
