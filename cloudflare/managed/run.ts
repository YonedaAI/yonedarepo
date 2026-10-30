// One run of a managed agent on one change head, as durable steps: admit (currency and
// credit), prepare (the change and the agent's effective settings), then per model choice
// start a harness container, poll it until it reports or times out, and collect its result;
// finally post. The configured model comes first; the agent's listed fallbacks follow only
// when it fails, and each switch is recorded on the run. Model calls are metered by the
// container's outbound handler (harness.ts), container time here.
import {
  CONTAINER_USD_PER_MINUTE,
  type ManagedAgentDefinition,
  type ModelChoice,
  managedAgent,
} from '../../shared/managed-agents';
import { RESULT_CONTRACT } from '../../shared/managed-instructions';
import { resolveSettings } from '../../shared/managed-settings';
import { requestTopUp } from './billing';
import { gatewaySlugs, type ManagedEnv, type RunParams } from './config';
import { promptDiff } from './diff-prompt';
import { GATEWAY_HOST, type HarnessParams, harnessStub, PLATFORM_HOST } from './harness';
import { ledgerStub } from './ledger';
import { Platform, PlatformError } from './platform';
import { repoStub } from './repo-agents';
import { postReport } from './report';
import { redact } from './sanitize';
import { workspaceStub } from './workspace-agents';

/** The durable step runner (a Workflow's `step`, or an inline runner in tests). */
export interface Steps {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export type Outcome =
  | { status: 'passed' | 'findings'; value: string; findings: number; withheld: number }
  | { status: 'paused' | 'stopped'; reason: string }
  | { status: 'failed'; error: string };

export const POLL_MS = 20_000;
const TRANSCRIPT_MAX = 1024 * 1024;

interface Prepared {
  token: string;
  choices: ModelChoice[];
  reasoning: string;
  timeout_ms: number;
  instructions: string;
  block_at: string | null;
  context: {
    change: number;
    title: string;
    branch: string;
    base: string;
    head: string;
    files: string[];
    /** Every changed file's patch (diff-prompt.ts), so the agent reviews each changed line. */
    diff: string;
  };
}

type Collected = {
  result: Record<string, unknown> | null;
  error: string | null;
  stop: string | null;
};

async function prepare(
  env: ManagedEnv,
  p: RunParams,
  agent: ManagedAgentDefinition,
): Promise<Prepared | string> {
  const connection = await repoStub(env, p.repo).connection();
  if (!connection || connection.revoked) return 'not_connected';
  const platform = new Platform(env, { token: connection.token });
  if (await platform.automationPaused(p.repo)) return 'automation_paused';
  const change = await platform.change(p.repo, p.change);
  if (change.status !== 'open') return 'change_not_open';
  if (change.head !== p.head) return 'superseded';
  const stored = await workspaceStub(env, p.account).settings(agent.id);
  const s = resolveSettings(agent, stored.workspace, stored.repos[p.repo]);
  const chosen: ModelChoice = { harness: s.harness, provider: s.provider, model: s.model };
  const choices = [
    chosen,
    ...agent.fallback.filter((f) => f.model !== chosen.model || f.harness !== chosen.harness),
  ];
  return {
    token: connection.token,
    choices,
    reasoning: s.reasoning,
    timeout_ms: s.timeout_minutes * 60_000,
    instructions: s.instructions,
    block_at: s.block_at,
    context: {
      change: p.change,
      title: String(change.title ?? ''),
      branch: String(change.branch ?? ''),
      base: String(change.diff?.base?.commit ?? change.base ?? 'main'),
      head: p.head,
      files: ((change.diff?.changes ?? []) as { path: string }[])
        .map((f) => String(f.path))
        .slice(0, 200),
      diff: promptDiff((change.diff?.changes ?? []) as { path: string }[]),
    },
  };
}

/** Everything the runner needs; no credential (the outbound handlers hold them). */
function spec(env: ManagedEnv, p: RunParams, w: Prepared, choice: ModelChoice) {
  return {
    repo: p.repo,
    branch: w.context.branch,
    head: p.head,
    base: w.context.base,
    platform_origin: `http://${PLATFORM_HOST}`,
    harness: choice.harness,
    provider: choice.provider,
    model: choice.model,
    reasoning: w.reasoning,
    timeout_ms: w.timeout_ms,
    instructions: w.instructions,
    contract: RESULT_CONTRACT,
    context: w.context,
    gateway: {
      base: `http://${GATEWAY_HOST}${new URL(env.AI_GATEWAY_URL).pathname}`,
      slugs: gatewaySlugs(env),
    },
  };
}

export async function runAgent(env: ManagedEnv, p: RunParams, step: Steps): Promise<Outcome> {
  const repo = repoStub(env, p.repo);
  const ledger = ledgerStub(env, p.account);
  const agent = managedAgent(p.agent);
  if (!agent) return { status: 'failed', error: `Unknown agent ${p.agent}` };

  const admitted = await step.do('admit', async () => {
    const stop = await repo.stopReason(p.run, p.attempt);
    if (stop) return { stop };
    if ((await ledger.balance()).balance <= 0) return { paused: true as const };
    await repo.start(p.run, p.attempt);
    return {};
  });
  if ('stop' in admitted && admitted.stop) return { status: 'stopped', reason: admitted.stop };
  if ('paused' in admitted) return pause(env, p);

  try {
    const prepared = await step.do('prepare', () => prepare(env, p, agent));
    if (typeof prepared === 'string') {
      await repo.finish(p.run, p.attempt, 'failed', { error: `Not reviewed: ${prepared}` });
      return { status: 'stopped', reason: prepared };
    }
    let collected: Collected = { result: null, error: 'No model was tried', stop: null };
    for (const [i, choice] of prepared.choices.entries()) {
      if (i > 0) {
        const previous = prepared.choices[i - 1];
        await step.do(`fallback-${i}`, () =>
          repo.useModel(
            p.run,
            choice,
            `${previous.model} failed (${collected.error}); used ${choice.model}`,
          ),
        );
      }
      collected = await attempt(env, p, step, prepared, choice, i, agent);
      if (collected.result || collected.stop) break;
    }
    if (collected.stop) {
      if (collected.stop === 'paused') return pause(env, p);
      return { status: 'stopped', reason: collected.stop };
    }
    if (!collected.result) {
      await repo.finish(p.run, p.attempt, 'failed', { error: collected.error });
      return { status: 'failed', error: collected.error ?? 'failed' };
    }
    const result = collected.result;
    const report = await step.do('post', () =>
      postReport(env, p, agent, prepared.token, result, prepared.block_at),
    );
    // A withheld finding is still a finding: the run is never "passed" with one.
    const status = report.posted.length + report.withheld.length > 0 ? 'findings' : 'passed';
    await repo.finish(p.run, p.attempt, status, {
      value: report.value,
      summary: report.summary || null,
      findings: report.posted,
      withheld: report.withheld.length,
    });
    return {
      status,
      value: report.value,
      findings: report.posted.length,
      withheld: report.withheld.length,
    };
  } catch (e: any) {
    const error =
      e instanceof PlatformError && (e.status === 401 || e.status === 403)
        ? 'The repository token was refused; disable and enable the agent to reconnect'
        : `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e)}`;
    await repo.finish(p.run, p.attempt, 'failed', { error });
    return { status: 'failed', error };
  } finally {
    await step.do('close', () => ledger.closeRun(p.run, p.attempt)).catch(() => {});
  }
}

/** One model choice: start its container, poll until it reports, times out or must stop. */
async function attempt(
  env: ManagedEnv,
  p: RunParams,
  step: Steps,
  w: Prepared,
  choice: ModelChoice,
  i: number,
  agent: ManagedAgentDefinition,
): Promise<Collected> {
  const params: HarnessParams = {
    repo: p.repo,
    account: p.account,
    run: p.run,
    attempt: p.attempt,
    agent: p.agent,
    change: p.change,
    provider: choice.provider,
    model: choice.model,
    cap_microusd: Math.round(agent.cost_cap_usd * 1_000_000),
  };
  // Each start try gets a fresh container (a retried start after a refused, mismatched image
  // must not land on the same instance); the name it used is the step's result.
  const started = await step.do(`start-${i}`, async () => {
    const name = `${p.run}-${p.attempt}-${i}-${crypto.randomUUID().slice(0, 8)}`;
    await harnessStub(env, name).begin(params, spec(env, p, w, choice));
    return { at: Date.now(), name };
  });
  const name = started.name;
  let stop: string | null = null;
  for (let n = 0; ; n++) {
    await step.sleep(`wait-${i}-${n}`, POLL_MS);
    const polled = await step.do(`poll-${i}-${n}`, async () => {
      const status = await harnessStub(env, name).status();
      return {
        phase: String(status.phase ?? 'gone'),
        stop: await repoStub(env, p.repo).stopReason(p.run, p.attempt),
        late: Date.now() - started.at > w.timeout_ms + 60_000,
      };
    });
    if (polled.stop) stop = polled.stop;
    if (polled.stop || polled.late || ['done', 'failed', 'gone'].includes(polled.phase)) break;
  }
  return step.do(`collect-${i}`, async () => {
    const box = harnessStub(env, name);
    const status = stop ? {} : await box.status().catch(() => ({}) as Record<string, any>);
    await box.end();
    const seconds = Math.max(1, Math.ceil((Date.now() - started.at) / 1000));
    const charged = Math.ceil((seconds / 60) * CONTAINER_USD_PER_MINUTE * 1_000_000);
    const topUp = await ledgerStub(env, p.account).charge(
      `container:${name}`,
      charged,
      { repo: p.repo, run: p.run, agent: p.agent, model: choice.model },
      `Container ${seconds} s`,
    );
    await requestTopUp(env, p.account, topUp);
    await repoStub(env, p.repo).recordContainer(p.run, seconds, charged);
    const transcript = typeof status.transcript === 'string' ? status.transcript : '';
    // A run whose repository was deleted (and cleared) meanwhile keeps no transcript.
    const kept = transcript && (await repoStub(env, p.repo).run(p.run)) !== null;
    if (kept && env.TRANSCRIPTS)
      await env.TRANSCRIPTS.put(
        `transcripts/${p.repo}/${p.run}/${p.attempt}-${i}.txt`,
        redact(transcript).slice(-TRANSCRIPT_MAX),
      ).catch(() => {});
    const result =
      status.phase === 'done' && status.result && typeof status.result === 'object'
        ? (status.result as Record<string, unknown>)
        : null;
    const error = result
      ? null
      : stop
        ? null
        : String(
            status.error ??
              (status.phase === 'running'
                ? 'Timed out'
                : 'The harness container stopped before it reported'),
          );
    return { result, error, stop } satisfies Collected;
  });
}

async function pause(env: ManagedEnv, p: RunParams): Promise<Outcome> {
  await repoStub(env, p.repo).pause(p.run, p.attempt);
  await ledgerStub(env, p.account).pause(p.repo, p.run);
  return { status: 'paused', reason: 'no credit' };
}
