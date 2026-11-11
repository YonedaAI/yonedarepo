import { httpTraffic } from '../../shared/http-traffic';
import { performanceRoute } from '../../shared/observability-route';
import type { OperationSource, OperationTraffic } from '../../shared/operation-metrics';
import { operationOf } from './log';
import { userAgentClass } from './traffic-class';

export type ObservationSettings = {
  OPERATION_METRICS?: string;
  OPERATION_COMPONENT?: string;
  OPERATION_FULL_UNTIL?: string;
  OPERATION_DETAIL_EVERY?: string;
};

/** Expiry never schedules work. Missing/malformed expiry cannot enable full capture. */
export function capturePolicy(env: ObservationSettings, now = Date.now()) {
  const until = Date.parse(env.OPERATION_FULL_UNTIL ?? '');
  const full = Number.isFinite(until) && now < until;
  const setting = Number(env.OPERATION_DETAIL_EVERY);
  const every = full ? 1 : Number.isSafeInteger(setting) && setting >= 1 ? setting : 10;
  return {
    enabled: env.OPERATION_METRICS === 'on',
    fullUntil: full ? new Date(until).toISOString() : null,
    detailEvery: every,
    sampled: every > 1,
  };
}

export function requestSource(req?: Request): OperationSource {
  if (!req) return 'unknown';
  const url = new URL(req.url);
  const path = url.pathname;
  if (path === '/health') return 'monitor';
  if (path.startsWith('/internal/ssh/') || url.hostname === 'platform.internal') return 'git_ssh';
  if (/\/(?:git-upload-pack|git-receive-pack|info\/refs)$/.test(path)) return 'git_https';
  if (/\/mcp$/.test(path)) return 'mcp';
  return path.startsWith('/api/') ? 'rest' : 'web';
}

export function requestTraffic(req?: Request): OperationTraffic {
  if (!req) return 'unknown';
  const path = new URL(req.url).pathname;
  if (['/api/e', '/api/client-performance', '/api/client-error'].includes(path)) return 'telemetry';
  const c = httpTraffic(req.url, req.headers.get('x-yoneda-own-traffic') === '1');
  if (c === 'health' || c === 'scanner') return c;
  if (c === 'own') return 'marked_automation';
  const claimed = userAgentClass(req.headers.get('user-agent') ?? '');
  if (claimed === 'agent') return 'agent_claimed';
  if (claimed === 'crawler') return 'crawler_claimed';
  if (claimed === 'bot') return 'automation_claimed';
  return 'ordinary';
}

export { performanceRoute } from '../../shared/observability-route';

export function observedRoute(req: Request) {
  const path = new URL(req.url).pathname;
  const action = /\/(git-upload-pack|git-receive-pack|info\/refs)$/.exec(path)?.[1];
  if (action) return `${req.method} /git/:repo/${action}`;
  if (path.startsWith('/api/') || path.startsWith('/internal/')) return operationOf(req);
  return `${req.method} ${performanceRoute(path) ?? '/:path'}`;
}
