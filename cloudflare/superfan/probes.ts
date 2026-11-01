// What a pass asks the Workers themselves, outside any telemetry: are they answering?
type Row = Record<string, any>;

export interface Health {
  ok: boolean;
  status: number | null;
  latencyMs: number;
}

/** The `service` each Worker's /health answers with. */
export const PLATFORM_SERVICE = 'yonedarepo-platform';
export const FRONT_SERVICE = 'yonedarepo';
const PROBE_RETRY_MS = 2_000;

/** A Worker's public health endpoint; also keeps one tail event flowing per run. */
export async function probe(url: string, service = PLATFORM_SERVICE): Promise<Health> {
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const body = res.ok ? ((await res.json().catch(() => null)) as Row | null) : null;
    return {
      ok: res.ok && body?.service === service,
      status: res.status,
      latencyMs: Date.now() - started,
    };
  } catch {
    return { ok: false, status: null, latencyMs: Date.now() - started };
  }
}

/** A probe that is down twice in a row: what an urgent mail may rest on. */
export async function confirmed(
  url: string,
  service: string,
  pause: (ms: number) => Promise<void>,
) {
  const first = await probe(url, service);
  if (first.ok) return first;
  await pause(PROBE_RETRY_MS);
  return probe(url, service);
}

/** Minutes since the dead-man's last check; null when its answer cannot be read. */
export async function deadmanAge(url: string, now: number): Promise<number | null> {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }).catch(
    () => null,
  );
  const body = (await res?.json().catch(() => null)) as Row | null;
  const at = body?.last_check_at;
  return res?.ok && typeof at === 'number' ? Math.round((now - at) / 60_000) : null;
}
