// What a run needs before it starts a container: the change at its head and the agent's
// effective settings (`prepare`, a durable step), and the runner's spec from them, which holds
// no credential (the outbound handlers hold those).
import type { ManagedAgentDefinition, ModelChoice } from '../../shared/managed-agents';
import { RESULT_CONTRACT, VERDICT_CONTRACT } from '../../shared/managed-instructions';
import { resolveSettings } from '../../shared/managed-settings';
import { gatewaySlugs, type ManagedEnv, type RunParams } from './config';
import { promptDiff } from './diff-prompt';
import { GATEWAY_HOST, PLATFORM_HOST } from './harness';
import { Platform } from './platform';
import { repoStub } from './repo-agents';
import { workspaceStub } from './workspace-agents';

export interface Prepared {
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
    /** For a `verdict` agent: the flight plan and the change's description. */
    plan?: { goal: string; scope: string | null };
    body?: string;
  };
}

export async function prepare(
  env: ManagedEnv,
  p: RunParams,
  agent: ManagedAgentDefinition,
): Promise<Prepared | string> {
  const connection = await repoStub(env, p.repo).connection();
  if (!connection || connection.revoked) return 'not_connected';
  const platform = new Platform(env, { token: connection.token });
  if ((await platform.automation(p.repo)).paused) return 'automation_paused';
  const change = await platform.change(p.repo, p.change);
  if (change.status !== 'open') return 'change_not_open';
  if (change.head !== p.head) return 'superseded';
  // Nothing to compare the diff with, so no container starts and nothing is spent.
  if (agent.verdict && !change.flight_plan?.goal) return 'no_flight_plan';
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
      ...(agent.verdict
        ? {
            plan: {
              goal: String(change.flight_plan.goal),
              scope: change.flight_plan.scope ?? null,
            },
            body: String(change.body ?? ''),
          }
        : {}),
    },
  };
}

/** Everything the runner needs. */
export function spec(
  env: ManagedEnv,
  p: RunParams,
  w: Prepared,
  choice: ModelChoice,
  agent: ManagedAgentDefinition,
) {
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
    contract: agent.verdict ? VERDICT_CONTRACT : RESULT_CONTRACT,
    context: w.context,
    gateway: {
      base: `http://${GATEWAY_HOST}${new URL(env.AI_GATEWAY_URL).pathname}`,
      slugs: gatewaySlugs(env),
    },
  };
}
