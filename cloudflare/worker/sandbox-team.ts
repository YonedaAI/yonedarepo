// Sandbox team runs: the owner's tasks run in parallel, one sandbox each, on the run's frozen
// base, and the platform's own land operation integrates them. Only this trusted side lands:
// it reads the commit a member pushed to `attempts/<run>/<n>` from the platform and lands it
// on `attempts/<run>/team`, where the server merges disjoint work (the configured land path:
// the branch's queue and combiner when the branch moved). A conflict sends the member back
// once, in its own CLI session, with the team branch fetched for it to merge. When every
// member is done, one capture reads the team branch head as the run's candidate.
import { platformRevision, repositoryPlatform } from './agents-platform';
import { commitFacts } from './contribution-capture';
import type { SandboxAttempt } from './sandbox-attempt';
import type { SandboxHost } from './sandbox-check';
import { agentCli } from './sandbox-cli';
import type { LandOutcome, SandboxPort } from './sandbox-driver';
import { fetchScript, repositoryDirectory, trustEnv } from './sandbox-shell';
import { platformSource } from './source-objects';
import { ledger, sha } from './storage';
import type { Env, Json, Scope } from './types';

const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

/** The run's segment of `attempts/<run>/…`: its id, or a digest of an id unsafe in a ref. */
export async function runSegment(runId: string): Promise<string> {
  return /^[A-Za-z0-9._-]{1,100}$/.test(runId) ? runId : (await sha(runId)).slice(0, 32);
}
export const teamBranch = async (runId: string) => `attempts/${await runSegment(runId)}/team`;

/** What a member is told after its first conflict. */
export const resumePrompt = (branch: string, paths: string[]) =>
  `Your change conflicts with the team branch on ${paths.join(', ')}. Merge origin/${branch}, ` +
  'resolve the conflicts, and stop. Your work is committed, pushed and landed for you.';

/**
 * Creates the team branch at the frozen base by landing the base on it (a repeated landing
 * is a no-op). Not a branch move: the log records a move without paths as opaque, and the
 * platform could then never prove a later landing independent of it, so every concurrent
 * member would conflict instead of merging.
 */
export async function ensureTeamBranch(env: Env, attempt: SandboxAttempt): Promise<void> {
  if (!attempt.team) return;
  const platform = await repositoryPlatform(env, attempt.repo);
  if (await platformSource(platform).head(attempt.team.branch)) return;
  await platform.call('POST', '/land', { ref: attempt.team.branch, commit: attempt.base.commit });
}

/** Conflicting paths from a refused landing (the platform's three-way merge details). */
function conflictPaths(failure: any): string[] {
  const conflicts: unknown[] = Array.isArray(failure?.details?.conflicts)
    ? failure.details.conflicts
    : [];
  const paths = conflicts
    .map((conflict: any) => conflict?.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (!paths.length) throw failure;
  return [...new Set(paths)].slice(0, 50);
}

/** Lands the member's pushed commit on the team branch through the platform's land. */
export async function landOnTeam(env: Env, attempt: SandboxAttempt): Promise<LandOutcome> {
  const branch = attempt.team?.branch ?? fail('INVALID_INPUT', 'Not a team member');
  const platform = await repositoryPlatform(env, attempt.repo);
  const source = platformSource(platform);
  // What the sandbox pushed, read from the platform: the sandbox's own claims count for nothing.
  const commit = await source.head(attempt.branch);
  if (!commit) return fail('INVALID_CAPTURE', `The pushed branch ${attempt.branch} is unavailable`);
  let landed: Json;
  try {
    landed = await platform.call('POST', '/land', { ref: branch, commit });
  } catch (failure: any) {
    if (failure?.code !== 'CONFLICT') throw failure;
    return { landed: false, paths: conflictPaths(failure) };
  }
  // The branch head this landing made: a merge commit, the commit itself, or (a repeated
  // landing) whatever the branch holds now.
  const head =
    landed.merge ?? landed.git_commit ?? (landed.already ? await source.head(branch) : null);
  return {
    landed: true,
    commit,
    teamCommit: String(head ?? commit),
    version: typeof landed.version === 'number' ? landed.version : null,
  };
}

/** What the AgentSandbox port needs from its object to run a team member's steps. */
export interface TeamHost extends SandboxHost {
  startTask(command: string[], env: Record<string, string>): Promise<void>;
}

/** The driver port's team steps for `attempt` (inert for an attempt without a team). */
export function teamPort(
  env: Env,
  attempt: SandboxAttempt,
  host: TeamHost,
): Pick<SandboxPort, 'team' | 'land' | 'reportLanding' | 'resumeAgent'> {
  return {
    team: !!attempt.team,
    land: () => landOnTeam(env, attempt),
    reportLanding: (outcome, round) =>
      ledger(env, attempt.repo, {
        op: 'sandbox_land',
        job_id: attempt.job_id,
        epoch: attempt.epoch,
        landing: outcome.landed
          ? {
              outcome: 'landed',
              round,
              commit: outcome.commit,
              team_commit: outcome.teamCommit,
              version: outcome.version,
            }
          : { outcome: 'conflict', round, paths: outcome.paths },
      }).then((answer: Json) => ({ resume: answer.resume === true })),
    resumeAgent: async (session, paths) => {
      const branch = attempt.team?.branch ?? fail('INVALID_INPUT', 'Not a team member');
      if (!session) fail('SANDBOX_RESUME', 'The agent session id is unknown');
      const fetched = await host.run(
        ['/bin/sh', '-c', fetchScript, 'fetch', repositoryDirectory, branch],
        repositoryDirectory,
        { ...trustEnv, YONEDA_TOKEN: 'provided-by-worker' },
      );
      if (fetched.exitCode !== 0)
        fail('SANDBOX_RESUME', `git fetch failed: ${fetched.stderr.trim().slice(-500)}`);
      const cli = agentCli(attempt);
      await host.startTask(cli.resume(session, resumePrompt(branch, paths)), cli.env);
    },
  };
}

/**
 * The team capture: the team branch head, read fresh from the platform, on the frozen base.
 * Its facts are recorded like a contribution's; the ledger makes it the run's candidate.
 */
export async function captureTeamBranch(env: Env, scope: Scope): Promise<Json> {
  const job = scope.job;
  const { base, run_id: runId } = job.payload;
  const repository = platformRevision(scope.repo_id);
  if (base?.repository !== repository) fail('INVALID_CAPTURE', 'The base is outside this project');
  const platform = await repositoryPlatform(env, scope.repo_id);
  const source = platformSource(platform);
  const branch = await teamBranch(String(runId));
  const head = await source.head(branch);
  const commit = head && head !== base.commit ? await source.readCommit(head) : null;
  if (!commit) return fail('INVALID_CAPTURE', `${branch} has no landed change`);
  const found = await platform.call('GET', `/merge-base?left=${base.commit}&right=${commit.hash}`);
  if (found.merge_bases?.[0]?.commit !== base.commit)
    fail('INVALID_CAPTURE', `${branch} does not descend from the frozen base`);
  return {
    op: 'finish',
    job_id: job.id,
    epoch: job.epoch,
    result: {
      id: `sandbox-team-${(await sha(`${scope.repo_id}:${commit.hash}`)).slice(0, 32)}`,
      revision: { repository, commit: commit.hash },
      ...(await commitFacts(env, platform, base.commit, commit)),
      summary: String(job.payload.summary ?? 'Team branch').slice(0, 500),
    },
  };
}
