// Posting a run's report through the platform API: one change comment per finding, anchored
// to its file and line on the new side of the head commit, one summary comment, and the
// agent's check on the head. These calls are the only effects a run has. The CLI's result is
// untrusted: findings must anchor to a line of this change's diff, text is defused, and a
// finding that looks like a credential is withheld. The value is derived from the findings,
// never taken from the model, and fails closed: a finding withheld from its line (no anchor, a
// credential-looking text, or a comment the platform's scanner refused) still counts at its
// severity and is listed in the summary by severity and defused title. The step may be retried, so each comment carries a
// reference (`run#n`) and one already on the change is not posted again.
import type { ManagedAgentDefinition, RunValue } from '../../shared/managed-agents';
import type { ManagedEnv, RunParams } from './config';
import { Platform, PlatformError } from './platform';
import { type PostedFinding, repoStub } from './repo-agents';
import {
  anchorsOf,
  dedupe,
  defuse,
  looksLikeCredential,
  type Severity,
  validFindings,
  type Withheld,
} from './sanitize';

const LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };
const MAX_COMMENTS = 20;

const reference = (p: RunParams, n: number | 'summary') => `${p.run}#${n}`;
const footer = (agent: ManagedAgentDefinition, ref: string) =>
  `\n\n_${agent.defaults.name} by YonedaRepo managed agents · ${ref}_`;

/** The run's value from every finding, posted or withheld: pass/fail, or the highest level
 * (lower is better). */
export function runValue(agent: ManagedAgentDefinition, posted: { severity: string }[]): RunValue {
  if (agent.value_type === 'pass_fail')
    return posted.some((f) => f.severity === 'high' || f.severity === 'medium') ? 'fail' : 'pass';
  const top = Math.max(1, ...posted.map((f) => RANK[f.severity] ?? 1));
  return (['low', 'medium', 'high'] as const)[top - 1];
}

const WHY: Record<Withheld['reason'], string> = {
  anchor: 'no line of this change to anchor to',
  credential: 'it looked like a credential',
  scanner: 'the platform refused the comment as a credential',
};

/** One summary line for a withheld finding: severity and defused title, never risky text. */
function withheldLine(w: Withheld): string {
  return w.title && w.reason === 'anchor'
    ? `- ${LABEL[w.severity]}: ${w.title} (${WHY[w.reason]})`
    : `- ${LABEL[w.severity]}: (title hidden: ${WHY[w.reason]})`;
}

/** The check's pass/fail: a level agent blocks only at or above the repository's `block_at`. */
export function checkStatus(value: RunValue, blockAt: string | null): 'pass' | 'fail' {
  if (value === 'pass' || value === 'fail') return value;
  return blockAt && RANK[value] >= RANK[blockAt] ? 'fail' : 'pass';
}

export async function postReport(
  env: ManagedEnv,
  p: RunParams,
  agent: ManagedAgentDefinition,
  token: string,
  result: Record<string, unknown>,
  blockAt: string | null,
): Promise<{ posted: PostedFinding[]; withheld: Withheld[]; value: RunValue; summary: string }> {
  const platform = new Platform(env, { token });
  const change = await platform.change(p.repo, p.change);
  const anchors = anchorsOf((change.diff?.changes ?? []) as { path: string; patch?: string }[]);
  const checked = validFindings(result, anchors);
  // A level agent reports low or medium only; anything higher is held at medium.
  const capped = (severity: Severity): Severity =>
    agent.value_type === 'level' && severity === 'high' ? 'medium' : severity;
  const findings = dedupe(checked.kept)
    .map((f) => ({ ...f, severity: capped(f.severity) }))
    .slice(0, MAX_COMMENTS);
  const existing = ((change.comments ?? []) as { body?: string }[]).map((c) =>
    String(c.body ?? ''),
  );
  const already = (ref: string) => existing.some((body) => body.endsWith(`· ${ref}_`));

  const posted: PostedFinding[] = [];
  const withheld: Withheld[] = checked.withheld.map((w) => ({
    ...w,
    severity: capped(w.severity),
  }));
  for (const [n, f] of findings.entries()) {
    const ref = reference(p, n + 1);
    if (!already(ref)) {
      const body = `**${LABEL[f.severity]}: ${f.title}**\n\n${f.why}${footer(agent, ref)}`;
      try {
        await platform.comment(p.repo, p.change, body, {
          commit: p.head,
          path: f.path,
          line: f.line,
          side: 'new',
        });
      } catch (e) {
        if (e instanceof PlatformError && e.code === 'SECRET_DETECTED') {
          withheld.push({ severity: f.severity, title: null, reason: 'scanner' });
          continue;
        }
        throw e;
      }
    }
    posted.push(f);
  }

  const value = runValue(agent, [...posted, ...withheld]);
  const tally = (list: { severity: string }[]) => {
    const counts = { high: 0, medium: 0, low: 0 };
    for (const f of list) counts[f.severity as keyof typeof counts]++;
    return counts;
  };
  const counts = tally(posted);
  const raw = typeof result.summary === 'string' ? result.summary : '';
  const summary = looksLikeCredential(raw) ? '' : defuse(raw, 600);
  const run = await repoStub(env, p.repo).run(p.run);
  const lines = [
    `**${agent.defaults.name}**: ${value} on \`${p.head.slice(0, 10)}\` — ${
      posted.length === 0
        ? 'no findings posted.'
        : `${posted.length} finding${posted.length === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`
    }`,
  ];
  if (summary) lines.push('', summary);
  if (withheld.length > 0)
    lines.push('', 'Withheld (not posted on a line):', ...withheld.map(withheldLine));
  if (run)
    lines.push(
      '',
      `${run.harness} · ${run.model}${run.fallback ? ' (fallback)' : ''} · ${run.calls} model calls`,
    );
  const summaryRef = reference(p, 'summary');
  if (!already(summaryRef))
    await platform
      .comment(p.repo, p.change, `${lines.join('\n')}${footer(agent, summaryRef)}`)
      .catch((e) => {
        if (!(e instanceof PlatformError && e.code === 'SECRET_DETECTED')) throw e;
      });

  await platform.check(p.repo, p.head, agent.check, checkStatus(value, blockAt), {
    agent: agent.id,
    run: p.run,
    value,
    model: run?.model ?? null,
    findings: counts,
    withheld: tally(withheld),
  });
  return { posted, withheld, value, summary };
}
