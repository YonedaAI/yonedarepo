// Posting a verdict: one judgment on the whole change, for an agent that compares it with
// something no line of the diff holds (a flight plan). Like a report it is one comment and the
// agent's check, and the CLI's result is untrusted: the verdict must be one of a fixed list, and
// text is defused, capped and left out when it looks like a credential. Nothing here needs a
// line, so nothing here is withheld for want of one.
import type { ManagedAgentDefinition, RunValue } from '../../shared/managed-agents';
import type { ManagedEnv, RunParams } from './config';
import { Platform } from './platform';
import { repoStub } from './repo-agents';
import { checkStatus, commentRefused, footer, hasRef, type Report, reference } from './report';
import { defuse, looksLikeCredential } from './sanitize';

const VALUES: Record<string, RunValue> = {
  on_course: 'low',
  partial: 'medium',
  off_course: 'high',
};
const LABELS: Record<string, string> = {
  on_course: 'on course',
  partial: 'partly on course',
  off_course: 'off course',
};
const MAX_REASONS = 5;

/** The result's verdict, or null when it is not one this agent may give. */
export function verdictOf(result: Record<string, unknown>): string | null {
  const verdict = result.verdict;
  return typeof verdict === 'string' && Object.hasOwn(VALUES, verdict) ? verdict : null;
}

/** Up to five `title: why` lines, without any that look like a credential. */
function reasons(result: Record<string, unknown>): string[] {
  const list = Array.isArray(result.findings) ? (result.findings as Record<string, unknown>[]) : [];
  return list
    .filter((f) => f && !looksLikeCredential(`${f.title ?? ''} ${f.why ?? ''}`))
    .map((f) => [defuse(f.title, 120), defuse(f.why, 600)].filter(Boolean).join(': '))
    .filter(Boolean)
    .slice(0, MAX_REASONS);
}

export async function postVerdict(
  env: ManagedEnv,
  p: RunParams,
  agent: ManagedAgentDefinition,
  token: string,
  result: Record<string, unknown>,
  blockAt: string | null,
): Promise<Report> {
  const verdict = verdictOf(result);
  if (!verdict) throw new Error('The agent finished without a verdict');
  const value = VALUES[verdict];
  const platform = new Platform(env, { token });
  const raw = typeof result.summary === 'string' ? result.summary : '';
  const summary = looksLikeCredential(raw) ? '' : defuse(raw, 600);
  const run = await repoStub(env, p.repo).run(p.run);
  const lines = [`**${agent.defaults.name}**: ${LABELS[verdict]} on \`${p.head.slice(0, 10)}\`.`];
  if (summary) lines.push('', summary);
  const why = reasons(result);
  if (why.length > 0) lines.push('', ...why.map((r) => `- ${r}`));
  if (run) lines.push('', `${run.harness} · ${run.model} · ${run.calls} model calls`);
  const change = await platform.change(p.repo, p.change);
  const ref = reference(p, 'summary');
  if (!hasRef((change.comments ?? []) as { body?: string }[], ref))
    await platform
      .comment(p.repo, p.change, `${lines.join('\n')}${footer(agent, ref)}`)
      .catch((e) => {
        if (!commentRefused(e)) throw e;
      });
  await platform.check(p.repo, p.head, agent.check, checkStatus(value, blockAt), {
    agent: agent.id,
    run: p.run,
    value,
    verdict,
    model: run?.model ?? null,
  });
  return { posted: [], withheld: [], value, summary };
}

/** No flight plan: encouraged, never required, so the check passes and says why. */
export async function postNoPlan(env: ManagedEnv, p: RunParams, agent: ManagedAgentDefinition) {
  const connection = await repoStub(env, p.repo).connection();
  if (!connection) return;
  await new Platform(env, { token: connection.token }).check(p.repo, p.head, agent.check, 'pass', {
    agent: agent.id,
    run: p.run,
    value: null,
    no_plan: true,
  });
}

/** A run that ended with no reading, on a check a landing waits for. Nothing else would ever
 * answer that check, so it fails and the comment says what to do. A check nobody requires stays
 * silent: with Land when cleared any failed check goes around, and an outage is no fault of the
 * work. Why the run failed stays on the run, for the owner: this comment is on the change. */
export async function postNoReading(env: ManagedEnv, p: RunParams, agent: ManagedAgentDefinition) {
  if (await repoStub(env, p.repo).stopReason(p.run, p.attempt)) return;
  const connection = await repoStub(env, p.repo).connection();
  if (!connection || connection.revoked) return;
  const platform = new Platform(env, { token: connection.token });
  const { required, paused } = await platform.landingChecks(p.repo);
  if (paused || !required.includes(agent.check)) return;
  const change = await platform.change(p.repo, p.change);
  if (change.status !== 'open' || change.head !== p.head) return;
  const ref = reference(p, 'summary');
  if (!hasRef((change.comments ?? []) as { body?: string }[], ref)) {
    const line = `**${agent.defaults.name}** could not finish on \`${p.head.slice(0, 10)}\`, so this head has no reading. Agents → ${agent.defaults.name}: choose Run now to retry.`;
    await platform.comment(p.repo, p.change, `${line}${footer(agent, ref)}`).catch((e) => {
      if (!commentRefused(e)) throw e;
    });
  }
  await platform.check(p.repo, p.head, agent.check, 'fail', {
    agent: agent.id,
    run: p.run,
    value: null,
    no_reading: true,
  });
}
