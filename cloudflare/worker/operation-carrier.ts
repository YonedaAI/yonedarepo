// Optional metadata across RPC, queues and Workflows. It never grants authority.
import type { OperationSource, OperationTraffic } from '../../shared/operation-metrics';
import { capturePolicy, type ObservationSettings } from './operation-context';
import { type OperationLink, operationLinks } from './operation-links';
import { currentScope, inScope, requestId } from './request-scope';
import type { Env } from './types';

export type OperationCarrier = {
  requestId?: string;
  span: string;
  origin: string;
  source: string;
  traffic: string;
  selected: boolean;
  fullUntil?: string;
};
const SOURCES = new Set([
  'web',
  'rest',
  'mcp',
  'git_https',
  'git_ssh',
  'queue',
  'cron',
  'workflow',
  'alarm',
  'monitor',
  'unknown',
]);
const TRAFFIC = new Set([
  'ordinary',
  'marked_automation',
  'crawler_claimed',
  'agent_claimed',
  'automation_claimed',
  'health',
  'scanner',
  'telemetry',
  'unknown',
]);
const ID = /^[A-Za-z0-9._-]{8,64}$/;
export function operationCarrier(): OperationCarrier | undefined {
  const link = operationLinks.getStore();
  return link
    ? {
        requestId: requestId(),
        span: link.span,
        origin: link.origin,
        source: link.source,
        traffic: link.traffic,
        selected: link.selected,
        fullUntil: link.fullUntil,
      }
    : undefined;
}
export function withCarrier<T>(
  env: Pick<Env, 'REQUEST_IDS' | 'BUILD_REVISION'> & ObservationSettings,
  carrier: OperationCarrier | undefined,
  run: () => T,
): T {
  if (
    !carrier ||
    !ID.test(carrier.span) ||
    !ID.test(carrier.requestId ?? '') ||
    !/^[A-Za-z0-9_:/ .-]{1,128}$/.test(carrier.origin)
  )
    return run();
  const link: OperationLink = {
    span: carrier.span,
    origin: carrier.origin,
    source: (SOURCES.has(carrier.source) ? carrier.source : 'unknown') as OperationSource,
    traffic: (TRAFFIC.has(carrier.traffic) ? carrier.traffic : 'unknown') as OperationTraffic,
    selected:
      carrier.fullUntil && !(Date.parse(carrier.fullUntil) > Date.now())
        ? Math.random() * capturePolicy(env).detailEvery < 1
        : carrier.selected === true,
    fullUntil: capturePolicy(env).fullUntil ?? undefined,
  };
  return inScope(
    { ...currentScope(), env, job: { ...currentScope()?.job, request_id: carrier.requestId } },
    () => operationLinks.run(link, run),
  );
}
