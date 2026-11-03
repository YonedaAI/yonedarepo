// Resolve only the declared same-environment authorities. Fetch aliases own no resources.
import type { ResourceIds, WatchIds, WatchSite } from './config';
import { TelemetryError } from './telemetry-error';

const API_URL = 'https://api.cloudflare.com/client/v4';
type Row = Record<string, any>;

/** Shared queue/container inventories plus one settings read per authority. */
export async function resolveIds(site: WatchSite, token: string): Promise<WatchIds> {
  const account = `/accounts/${site.account}`;
  const get = async (path: string): Promise<any> => {
    const res = await fetch(`${API_URL}${account}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as Row | null;
    if (!res?.ok || body?.success !== true)
      throw new TelemetryError(
        'config',
        `Cannot look up watch ids: GET ${path.split('?')[0]} HTTP ${res?.status ?? 'none'} (the analytics token also needs Workers Scripts Read, Queues Read and Containers Read)`,
      );
    return body.result;
  };
  const regional = site.backendScripts?.includes(`${site.script}-weur`) ?? false;
  const [settings, eu, queues, apps] = await Promise.all([
    site.ids ? Promise.resolve(null) : get(`/workers/scripts/${site.script}/settings`),
    regional ? get(`/workers/scripts/${site.script}-weur/settings`) : Promise.resolve(null),
    get('/queues?per_page=100'),
    get('/containers/applications'),
  ]);
  const prefix = site.script.replace(/-platform$/, '');
  const idsFor = (settings: Row, suffix: string, managed: boolean): ResourceIds => {
    const namespace = (cls: string) =>
      settings?.bindings?.find(
        (b: Row) => b.type === 'durable_object_namespace' && b.class_name === cls && !b.script_name,
      )?.namespace_id;
    const queue = (kind: string) =>
      queues?.find?.((q: Row) => q.queue_name === `${site.script}-${kind}${suffix}`)?.queue_id;
    const named: Record<string, unknown> = {
      source_repository: namespace('SourceRepository'),
      check_runs: namespace('CheckContainer'),
      jobs: queue('jobs'),
      deadLetter: queue('dead-letter'),
      checkApp: apps?.find?.((a: Row) => a.name === `${site.script}${suffix}-checkcontainer`)?.id,
      ...(site.wide && { checks: queue('checks') }),
      ...(site.wide &&
        managed && {
          managedRuns: queues?.find?.((q: Row) => q.queue_name === `${prefix}-managed-runs`)
            ?.queue_id,
          managedDeadLetter: queues?.find?.(
            (q: Row) => q.queue_name === `${prefix}-managed-dead-letter`,
          )?.queue_id,
        }),
    };
    const missing = Object.entries(named).filter(([, id]) => typeof id !== 'string');
    if (missing.length)
      throw new TelemetryError(
        'config',
        `Cannot look up watch ids (${site.script}${suffix}): ${missing.map(([name]) => name).join(', ')} not found`,
      );
    const { source_repository, check_runs, checkApp, ...foundQueues } = named as Record<
      string,
      string
    >;
    return {
      namespaces: { source_repository, check_runs },
      queues: foundQueues as ResourceIds['queues'],
      checkApp,
    };
  };
  return {
    ...(site.ids ?? idsFor(settings, '', true)),
    ...(regional && { regional: { weur: idsFor(eu, '-weur', false) } }),
  };
}
