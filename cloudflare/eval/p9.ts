// P9 with real models: two tasks on disjoint files with a semantic dependency. Agent A
// gives price() a currency parameter; agent B adds a price() call in another file. Each
// agent reads at its base commit, stages whole files, and the arm commits them with that
// base. The scheduler decides bases and landing order exactly as in the scripted demo;
// the platform's post-land combined check (the repository's own type check, in a real
// check container) decides acceptance. Aware scheduling declares as the read set every
// file whose content the model saw (read or search hit), never what the model claims.
import { author, base64, FINISH, SEARCH, string, tool, toolLoop } from './loop';
import { type Ledger, type Limits, ModelClient, type Route } from './model';
import type { Api, Json } from './study';

export const SCHEDULERS = ['disjoint', 'aware', 'planned'] as const;
export type Scheduler = (typeof SCHEDULERS)[number];
const LABELS: Record<Scheduler, string> = {
  disjoint: 'file-disjoint',
  aware: 'dependency-aware (read sets)',
  planned: 'planned (git_plan stages)',
};

export const P9_TASKS = {
  a:
    'Task: in src/pricing.ts, give price() a second required parameter `currency: string`. It returns ' +
    "`amount` when currency is 'usd' and `amount * 2` otherwise. Also add " +
    "`export function quote(amount: number): number` that returns `price(amount, 'usd')`. " +
    'Update every existing caller of price() in the repository. Change nothing else.',
  b:
    'Task: in src/cart.ts, add `export function shipping(): number` that returns the price of 5 units ' +
    'by calling price() from src/pricing.ts (import it). Read price() first and call it correctly for ' +
    'its current signature. Change nothing else.',
};
export const P9_TOOLS = [
  tool('read_file', 'Read a whole file at your base commit.', { path: string('Path') }),
  tool('write_file', 'Stage the complete new content of a file; committed when you finish.', {
    path: string('Path'),
    content: string('The complete new file content'),
  }),
  SEARCH,
  FINISH,
];

export type Base = { commit: string; version: number };
export type P9Spec = {
  run: string;
  scheduler: Scheduler;
  base: Base;
  max_turns: number;
  check_timeout_ms: number;
};

async function agent(model: ModelClient, api: Api, task: string, base: Base, spec: P9Spec) {
  const staged = new Map<string, string>();
  const seen = new Set<string>();
  const at = `commit=${base.commit}`;
  const outcome = await toolLoop(
    model,
    task,
    P9_TOOLS,
    async (name, input) => {
      const path = String(input.path ?? '');
      if (name === 'search') {
        const found = await api(
          `/search?query=${encodeURIComponent(String(input.query ?? ''))}&${at}`,
        );
        for (const hit of (found.body.results ?? []) as Json[])
          if (hit.lines?.length) seen.add(hit.path);
        return JSON.stringify(
          found.status === 200
            ? { results: found.body.results.map((r: Json) => ({ path: r.path, lines: r.lines })) }
            : found.body,
        );
      }
      if (name === 'read_file') {
        const file = await api(`/blob?path=${encodeURIComponent(path)}&${at}`);
        if (file.status !== 200) return JSON.stringify(file.body);
        seen.add(path);
        return file.body.content;
      }
      if (name === 'write_file') {
        staged.set(path, String(input.content ?? ''));
        return `Staged ${path}.`;
      }
      return `Error: unknown tool ${name}.`;
    },
    spec.max_turns,
  );
  const readSet = spec.scheduler === 'aware' ? [...seen].sort() : [];
  if (staged.size === 0) return { ...outcome, commit: null as string | null, read_set: readSet };
  const changes = [...staged].map(([path, text]) => ({ path, content_b64: base64(text) }));
  const made = await api('/commits', {
    body: {
      parent: base.commit,
      base_version: base.version,
      changes,
      message: 'Eval change',
      author,
      read_set: readSet,
    },
  });
  return {
    ...outcome,
    commit: made.status === 200 ? (made.body.commit as string) : null,
    read_set: readSet,
    ...(made.status === 200 ? {} : { commit_error: String(made.body.error?.code ?? made.status) }),
  };
}

const CAP_STOPS = new Set(['spend_cap', 'request_cap', 'wall_clock']);
const EXECUTOR_RETRIES = 3;

/**
 * Waits for the post-land combined check on `head`. A run that errored in the executor
 * (e.g. no container capacity) is infrastructure, not a verdict: it is re-requested a few
 * times and counted; only pass/fail (or a persistent error) is reported.
 */
export async function combinedCheck(api: Api, head: string, timeoutMs: number, pollMs: number) {
  let executorErrors = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = (await api(`/commits/${head}`)).body;
    const verdict = detail.checks?.find((c: Json) => c.name === 'combined')?.status;
    if (verdict === 'pass' || verdict === 'fail' || verdict === 'error')
      return { status: verdict as string, executor_errors: executorErrors };
    const runs = ((detail.check_runs ?? []) as Json[]).filter((r) => r.name === 'combined');
    const lastError = Math.max(0, ...runs.map((r) => Number(r.finished_at ?? 0)));
    // Spaced re-requests: capacity errors need a moment to clear (6 polls, 30 s hosted).
    if (
      runs.length > 0 &&
      runs.every((r) => r.status === 'errored') &&
      Date.now() - lastError >= 6 * pollMs
    ) {
      if (runs.length > executorErrors) executorErrors = runs.length;
      if (executorErrors > EXECUTOR_RETRIES)
        return { status: 'error', executor_errors: executorErrors };
      await api(`/commits/${head}/check-runs`, { body: { name: 'combined' } });
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { status: 'timeout', executor_errors: executorErrors };
}

export async function runP9(
  route: Route,
  ledger: Ledger,
  a: Api,
  b: Api,
  spec: P9Spec,
  limits: Limits,
  pollMs = 5_000,
) {
  const model = new ModelClient(route, ledger, spec.run, limits);
  const attempts: Json[] = [];
  const landings: Json[] = [];
  let conflicts = 0;
  let stopped: string | null = null;
  const run = async (who: 'a' | 'b', api: Api, base: Base) => {
    const outcome = await agent(model, api, P9_TASKS[who], base, spec);
    attempts.push({ agent: who.toUpperCase(), base: base.commit, ...outcome });
    if (CAP_STOPS.has(outcome.stop)) stopped = outcome.stop;
    return outcome.commit;
  };
  const land = async (api: Api, commit: string | null) => {
    const landed = commit
      ? (await api('/land', { body: { ref: 'main', commit } })).body
      : { error: { code: 'NO_COMMIT' } };
    landings.push({ commit, landed: landed.landed === true, error: landed.error?.code });
    return landed;
  };
  const after = (landed: Json, fallback: Base): Base =>
    landed.landed ? { commit: landed.commit, version: landed.version } : fallback;
  let plan: Json | null = null;
  if (spec.scheduler === 'planned') {
    // The platform plans from declared symbol sets; each stage starts on the head it finds.
    const items = [
      { id: 'shipping', read_set: ['src/pricing.ts#price'], write_set: ['src/cart.ts'] },
      { id: 'pricing', write_set: ['src/pricing.ts#price', 'src/pricing.ts#quote'] },
    ];
    const planned = (await a('/plans', { body: { items } })).body;
    plan = {
      stages: (planned.stages ?? []).map((stage: number[]) =>
        stage.flatMap((k) => planned.items[k].members),
      ),
    };
    const landedA = await land(a, await run('a', a, spec.base));
    if (!stopped) await land(b, await run('b', b, after(landedA, spec.base)));
  } else {
    // Disjoint files: both start from the same base, as a file-disjoint scheduler would.
    const commitA = await run('a', a, spec.base);
    const commitB = stopped ? null : await run('b', b, spec.base);
    const landedA = await land(a, commitA);
    const landedB = await land(b, commitB);
    if (landedB.error?.code === 'CONFLICT' && !stopped) {
      conflicts++;
      await land(b, await run('b', b, after(landedA, spec.base)));
    }
  }
  const head = (await a('/log?ref=main&limit=1')).body.commits?.[0]?.commit as string;
  const { status: check, executor_errors } = await combinedCheck(
    a,
    head,
    spec.check_timeout_ms,
    pollMs,
  );
  const commits = [...new Set([...landings.map((l) => l.commit).filter(Boolean), head])];
  const repairs = (await Promise.all(commits.map((c) => a(`/commits/${c}`)))).flatMap(
    (r) => r.body.repairs ?? [],
  );
  const landed = landings.filter((l) => l.landed).length;
  const usd = model.usage.microusd / 1_000_000;
  const accepted = check === 'pass' && landed === 2 ? 2 : 0;
  return {
    label: `REAL MODEL: ${route.model} via ${route.provider} (${route.route}), ${new Date().toISOString().slice(0, 10)}`,
    scheduler: LABELS[spec.scheduler],
    provider: route.provider,
    model: route.model,
    route: route.route,
    stopped,
    plan,
    landed,
    head_check: check,
    check_executor_errors: executor_errors,
    accepted,
    stale_read_conflicts: conflicts,
    agent_attempts: attempts.length,
    repairs_proposed: repairs.filter((r: Json) => r.repair_commit).length,
    usage: { ...model.usage, usd: Number(usd.toFixed(6)) },
    usd_per_accepted: accepted ? Number((usd / accepted).toFixed(6)) : 'not finitely estimated',
    attempts,
    landings,
  };
}
