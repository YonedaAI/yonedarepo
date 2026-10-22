// The agent layer's side of a `sandbox-cli-v1` attempt: which runs take the sandbox, what an
// attempt needs to start, where its model requests go, and recording the pushed commit.
// The ledger owns the run; the AgentSandbox Durable Object owns the sandbox.
import { providerDefinition } from '../../shared/providers';
import { repositoryPlatform, revisionProject } from './agents-platform';
import { commitFacts } from './contribution-capture';
import { mimoUpstream } from './mimo-routing';
import type { AgentEgress } from './sandbox-outbound';
import { platformSource } from './source-objects';
import { ledger, sha } from './storage';
import type { Env, Json } from './types';

export const SANDBOX_TRANSPORT = 'sandbox-cli-v1';

export type SandboxAttempt = {
  repo: string;
  job_id: string;
  epoch: number;
  run_id: string;
  execution_id: string;
  owner: string;
  platform_repo: string;
  platform_origin: string;
  base: { repository: string; commit: string };
  /** `attempts/<run>/<n>`, the branch the result is pushed to. */
  branch: string;
  harness: string;
  provider: string;
  connection?: string;
  model: string;
  routing?: Json | null;
  effort: string;
  model_base: string;
  prompt: string;
};

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

/** The run transport the adapter approves: a sandbox only when asked and deployed. */
export function approvedTransport(env: Env, runtime: unknown): string {
  if (runtime === undefined || runtime === null) return 'api-source-v1';
  if (runtime !== SANDBOX_TRANSPORT) return fail('INVALID_INPUT', 'Unknown run runtime');
  if (!env.AGENT_SANDBOX) return fail('SANDBOX_UNAVAILABLE', 'Sandbox runs are not deployed here');
  return SANDBOX_TRANSPORT;
}

/** The agent sandbox's egress: its model endpoint and pushes under its own attempt prefix. */
export const agentEgress = (attempt: SandboxAttempt): AgentEgress => ({
  project: attempt.repo,
  owner: attempt.owner,
  platformRepo: attempt.platform_repo,
  platformOrigin: attempt.platform_origin,
  refPrefix: `refs/heads/${attempt.branch.replace(/[^/]+$/, '')}`,
  provider: attempt.provider,
  connection: attempt.connection,
  model: attempt.model,
  routing: attempt.routing,
  modelBase: attempt.model_base,
});

/** One sandbox per execution; the name also finds its activity log later. */
export const sandboxName = (repo: string, execution: string) => `${repo}/${execution}`;

/**
 * Where the CLI sends model requests: the connection's own upstream (MiMo's Token Plan
 * region included), through AI Gateway when SANDBOX_AI_GATEWAY (`<account>/<gateway>`) is
 * set and the gateway has a custom provider for that upstream (`custom-<provider>`).
 */
export function modelBase(env: Env, provider: string, routing?: Json | null): string {
  const definition = providerDefinition(provider);
  if (definition.harness !== 'claude')
    fail('SANDBOX_HARNESS', `Sandbox runs use Claude Code; ${provider} needs another CLI`);
  const upstream = provider === 'mimo' ? mimoUpstream(routing) : definition.api_base;
  const gateway = env.SANDBOX_AI_GATEWAY;
  if (!gateway || upstream !== definition.api_base) return upstream;
  const [account, id] = gateway.split('/');
  if (!/^[a-f0-9]{32}$/.test(account ?? '') || !/^[a-z0-9-]{1,64}$/.test(id ?? ''))
    return fail('SANDBOX_GATEWAY', 'SANDBOX_AI_GATEWAY must be <account id>/<gateway id>');
  const path = new URL(upstream).pathname.replace(/\/$/, '');
  return `https://gateway.ai.cloudflare.com/v1/${account}/${id}/custom-${provider}${path}`;
}

/** The task as Claude Code receives it: the owner's brief and criteria, nothing else. */
export function agentPrompt(run: Json): string {
  const criteria: string[] = Array.isArray(run.criteria) ? run.criteria : [];
  return [
    String(run.intent ?? '').trim(),
    criteria.length ? `\nAcceptance criteria:\n${criteria.map((c) => `- ${c}`).join('\n')}` : '',
    '\nWork in this Git repository. Edit, run and test files here. Your file changes are',
    'committed and pushed for review automatically when you finish: do not push yourself.',
  ]
    .join('\n')
    .slice(0, 100_000);
}

/** The attempt the ledger claimed, as the Durable Object needs it. */
export async function sandboxAttempt(env: Env, repo: string, job: Json): Promise<SandboxAttempt> {
  const execution = job.payload?.execution ?? {};
  const run = job.payload?.run ?? {};
  const repository = await ledger(env, repo, { op: 'repository_status' });
  const index = /:agent-(\d+)$/.exec(String(execution.id ?? ''))?.[1];
  const runSegment = /^[A-Za-z0-9._-]{1,100}$/.test(String(run.id ?? ''))
    ? String(run.id)
    : (await sha(String(run.id))).slice(0, 32);
  if (!index || !repository.platform_repo || !env.SANDBOX_PLATFORM_ORIGIN)
    fail('INVALID_INPUT', 'Sandbox attempt needs a platform repository and an agent index');
  return {
    repo,
    job_id: String(job.id),
    epoch: Number(job.epoch),
    run_id: String(execution.run_id),
    execution_id: String(execution.id),
    owner: String(repository.workspace),
    platform_repo: String(repository.platform_repo),
    platform_origin: new URL(String(env.SANDBOX_PLATFORM_ORIGIN)).origin,
    base: {
      repository: String(execution.base?.repository),
      commit: String(execution.base?.commit),
    },
    branch: `attempts/${runSegment}/${index}`,
    harness: String(execution.harness),
    provider: String(execution.provider),
    connection: execution.connection ?? undefined,
    model: String(execution.model),
    routing: execution.routing ?? null,
    // The owner's rule for GLM (and the cheap default for all): low unless the run asks.
    effort: typeof execution.reasoning_effort === 'string' ? execution.reasoning_effort : 'low',
    model_base: modelBase(env, String(execution.provider), execution.routing),
    prompt: agentPrompt(run),
  };
}

/** Starts (or re-finds) the attempt's sandbox; repeated delivery starts nothing twice. */
export async function beginSandbox(env: Env, repo: string, job: Json): Promise<void> {
  const namespace = env.AGENT_SANDBOX;
  if (!namespace) return fail('SANDBOX_UNAVAILABLE', 'Sandbox runs are not deployed here');
  const attempt = await sandboxAttempt(env, repo, job);
  await namespace.getByName(sandboxName(repo, attempt.execution_id)).begin(attempt);
}

/** A sandbox execution's activity log page, for the owner's "View logs". */
export async function sandboxActivity(env: Env, repo: string, execution: string, after: number) {
  if (!execution || execution.length > 256 || !Number.isSafeInteger(after) || after < 0)
    return fail('INVALID_INPUT', 'A bounded execution_id and after are required');
  if (!env.AGENT_SANDBOX)
    return { entries: [], next: after, has_more: false, phase: null, last_activity_at: null };
  return env.AGENT_SANDBOX.getByName(sandboxName(repo, execution)).activity(after, 100);
}

/** Reads the pushed branch from the platform and makes its commit the run's candidate. */
export async function recordSandboxCandidate(env: Env, attempt: SandboxAttempt, summary: string) {
  const platform = await repositoryPlatform(env, attempt.repo);
  const source = platformSource(platform);
  const head = await source.head(attempt.branch);
  const commit = head ? await source.readCommit(head) : null;
  if (!commit) return fail('INVALID_CAPTURE', `The pushed branch ${attempt.branch} is unavailable`);
  // The run's base names this project's platform repository; the ledger checks the commit
  // is one commit on that base in that repository.
  const repository = attempt.base.repository;
  if (revisionProject(repository) !== attempt.repo)
    return fail('SOURCE_SCOPE', 'The attempt base is outside this project');
  const facts = await commitFacts(env, platform, attempt.base.commit, commit);
  return ledger(env, attempt.repo, {
    op: 'sandbox_finish',
    job_id: attempt.job_id,
    epoch: attempt.epoch,
    result: {
      id: `sandbox-${(await sha(`${attempt.repo}:${commit.hash}`)).slice(0, 32)}`,
      revision: { repository, commit: commit.hash },
      ...facts,
      summary: summary.slice(0, 500) || 'Sandbox agent change',
    },
  });
}
