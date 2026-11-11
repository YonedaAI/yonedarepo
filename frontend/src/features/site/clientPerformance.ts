// Browser measurements are observations, never a reason to delay navigation or an API call.
// No file names, query strings, session tokens, addresses or user-agent strings are sent.
import { performanceRoute } from '../../../../shared/observability-route';

type Metric = {
  requestId?: string;
  outcome?: 'failed' | 'cancelled';
  name: 'navigation_ready_ms' | 'readme_ready_ms' | 'ttfb_ms' | 'api_ms';
  ms: number;
  status?: number;
};
let enabled = false;
let path = '';
let started = 0;
let navigation = '';
let ready = false;
let readmeDone = false;
const pending: Metric[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export function flushPerformance() {
  if (!pending.length || !path) return;
  const metrics = pending.splice(0, 10);
  try {
    navigator.sendBeacon(
      '/api/client-performance',
      new Blob([JSON.stringify({ path, navigation, metrics })], { type: 'application/json' }),
    );
  } catch {
    /* No retry loop for telemetry. */
  }
}
function record(metric: Metric) {
  if (!Number.isFinite(metric.ms) || metric.ms < 0 || metric.ms > 3_600_000 || pending.length >= 10)
    return;
  pending.push(metric);
  if (!flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushPerformance();
    }, 1000);
}

export function navigationStarted(nextPath: string) {
  if (!enabled) return;
  flushPerformance();
  path = performanceRoute(nextPath) ?? '';
  started = performance.now();
  ready = false;
  readmeDone = false;
  navigation = crypto.randomUUID();
}

/** Called by the shared data loader once this navigation's requested content has committed. */
export function contentReady() {
  if (ready || !path) return;
  ready = true;
  const id = navigation;
  requestAnimationFrame(() => {
    if (id === navigation) record({ name: 'navigation_ready_ms', ms: performance.now() - started });
  });
}

export function readmeReady(failed = false) {
  if (readmeDone || !path) return;
  readmeDone = true;
  const id = navigation;
  requestAnimationFrame(() => {
    if (id === navigation)
      record({
        name: 'readme_ready_ms',
        ms: performance.now() - started,
        ...(failed ? { outcome: 'failed' as const } : {}),
      });
  });
}

export const performanceNavigation = () => navigation;
export function apiTiming(
  ms: number,
  status: number,
  requestId?: string,
  outcome?: 'failed' | 'cancelled',
  startedNavigation = navigation,
) {
  if (enabled && startedNavigation === navigation)
    record({ name: 'api_ms', ms, status, requestId, outcome });
}

export function startClientPerformance() {
  enabled =
    document.querySelector('meta[name="yoneda-performance"]')?.getAttribute('content') === 'on';
  if (!enabled) return;
  navigationStarted(location.pathname);
  started =
    (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)
      ?.startTime ?? 0;
  window.addEventListener('pagehide', flushPerformance);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPerformance();
  });
  const t = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (t && t.responseStart >= t.requestStart)
    record({ name: 'ttfb_ms', ms: t.responseStart - t.requestStart });
}
