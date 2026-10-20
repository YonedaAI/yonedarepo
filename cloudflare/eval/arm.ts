// One Study A arm with a real model: the same seeded tasks, layout and retrieval faults as
// the scripted harness, run by a model through the platform's public API with the arm's
// own repository token. The arm lands each commit itself, and the platform's diff of the
// landed commit decides acceptance; cost per accepted change counts every request,
// including failed and rate-limited ones.
import { prompt, runTask, TOOLS } from './agent';
import { SYSTEM } from './loop';
import { type Ledger, type Limits, ModelClient, type Route } from './model';
import { P9_TASKS, P9_TOOLS } from './p9';
import {
  type Api,
  codebase,
  type Interface,
  judge,
  type Layout,
  newReceipt,
  type Run,
  score,
  searchFaults,
  tasks,
} from './study';

export type ArmSpec = {
  run: string;
  layout: Layout;
  interface: Interface;
  seed: number;
  tasks: number;
  drop_rate: number;
  max_turns: number;
};

const CAP_STOPS = new Set(['spend_cap', 'request_cap', 'wall_clock']);

async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Digest of everything the model is told, so a manifest pins the exact prompts. */
export const promptsDigest = () =>
  digest({
    system: SYSTEM,
    tools: TOOLS,
    task: prompt({ target: '<target>', closure: [] }),
    p9: { tasks: P9_TASKS, tools: P9_TOOLS },
  });

export async function runArm(
  route: Route,
  ledger: Ledger,
  api: Api,
  spec: ArmSpec,
  limits: Limits,
) {
  const model = new ModelClient(route, ledger, spec.run, limits);
  const symbols = codebase(spec.seed);
  const faults = searchFaults(spec.seed, spec.drop_rate);
  const planned = tasks(symbols, spec.tasks, spec.seed);
  const runs: Run[] = [];
  const attempts = [];
  let stopped: string | null = null;
  for (const task of planned) {
    const receipt = newReceipt();
    const outcome = await runTask(
      model,
      api,
      spec.interface,
      task,
      receipt,
      faults,
      spec.max_turns,
    );
    let landed = false;
    let verdict = { accepted: false, editLines: 0 };
    if (outcome.commit) {
      const land = await api('/land', { body: { ref: 'main', commit: outcome.commit } });
      landed = land.body?.landed === true;
      if (landed) {
        const diff = await api(`/diff?head=${outcome.commit}&patch=1`);
        if (diff.status === 200) verdict = judge(diff.body, task, symbols);
      }
    }
    runs.push({
      task,
      receipt,
      accepted: verdict.accepted,
      editLines: verdict.editLines || undefined,
    });
    attempts.push({ target: task.target, ...outcome, landed, accepted: verdict.accepted });
    if (CAP_STOPS.has(outcome.stop)) {
      stopped = outcome.stop;
      break;
    }
  }
  const usage = model.usage;
  const result = score(spec.layout, spec.interface, runs, symbols);
  const usd = usage.microusd / 1_000_000;
  return {
    label: `REAL MODEL: ${route.model} via ${route.provider} (${route.route}), ${new Date().toISOString().slice(0, 10)}`,
    provider: route.provider,
    model: route.model,
    route: route.route,
    reasoning: route.reasoning,
    drop_rate: spec.drop_rate,
    tasks_planned: planned.length,
    stopped,
    ...result,
    usage: {
      requests: usage.requests,
      input_tokens: usage.input_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      output_tokens: usage.output_tokens,
      usd: Number(usd.toFixed(6)),
      failures: usage.failures,
      errors: usage.errors,
    },
    usd_per_accepted: result.accepted
      ? Number((usd / result.accepted).toFixed(6))
      : 'not finitely estimated',
    attempts,
  };
}

/** One fixed tiny request: discovers whether a provider's route and key work. */
export async function smoke(route: Route, ledger: Ledger, run: string, limits: Limits) {
  const model = new ModelClient(route, ledger, run, { ...limits, maxRequests: 1, maxRetries: 0 });
  try {
    const reply = await model.messages({
      messages: [{ role: 'user', content: 'Reply with the word ok.' }],
    });
    const text = (reply.content as { type: string; text?: string }[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      ok: true,
      provider: route.provider,
      model: route.model,
      route: route.route,
      reply: text.slice(0, 40),
      usage: model.usage,
    };
  } catch (e: any) {
    return {
      ok: false,
      provider: route.provider,
      model: route.model,
      route: route.route,
      error: String(e?.code ?? 'error'),
      usage: model.usage,
    };
  }
}
