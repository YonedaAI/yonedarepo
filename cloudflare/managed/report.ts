// Posting a run's report through the platform API: one change comment per finding, anchored
// to its file and line on the new side of the head commit, one summary comment, and the
// agent's check on the head. These three calls are the only effects a run can have. The step
// may be retried, so each comment carries a reference (`run#n`) and one already on the change
// is not posted again. A comment the platform's secret scanner refuses is counted as withheld.
import type { AgentConfig, ManagedEnv, RunParams } from './config';
import { Platform, PlatformError } from './platform';
import { repoStub } from './repo-agents';
import type { Finding } from './sanitize';

export interface Report {
  summary: string;
  findings: Finding[];
  /** Changed files left out by the file and call caps. */
  unreviewed: number;
  /** Findings already dropped before posting (bad anchor or credential). */
  withheld: number;
}

const LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

const reference = (p: RunParams, n: number | 'summary') => `${p.run}#${n}`;
const footer = (agent: AgentConfig, ref: string) =>
  `\n\n_${agent.label} by YonedaRepo managed agents · ${ref}_`;

export async function postReport(
  env: ManagedEnv,
  p: RunParams,
  agent: AgentConfig,
  token: string,
  report: Report,
): Promise<{ posted: number; withheld: number }> {
  const platform = new Platform(env, { token });
  const change = await platform.change(p.repo, p.change);
  const existing = new Set(
    ((change.comments ?? []) as { body?: string }[]).map((c) => String(c.body ?? '')),
  );
  const already = (ref: string) => [...existing].some((body) => body.endsWith(`· ${ref}_`));

  let posted = 0;
  let withheld = 0;
  const counts = { high: 0, medium: 0, low: 0 };
  for (const [n, f] of report.findings.entries()) {
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
          withheld++;
          continue;
        }
        throw e;
      }
    }
    posted++;
    counts[f.severity]++;
  }

  const run = await repoStub(env, p.repo).run(p.run);
  const cost = run ? `$${run.cost_usd.toFixed(4)}` : 'unknown';
  const lines = [
    `**${agent.label}** reviewed \`${p.head.slice(0, 10)}\`: ${
      posted === 0
        ? 'no findings.'
        : `${posted} finding${posted === 1 ? '' : 's'} (${counts.high} high, ${counts.medium} medium, ${counts.low} low).`
    }`,
  ];
  if (report.summary) lines.push('', report.summary);
  if (report.unreviewed > 0)
    lines.push(
      '',
      `${report.unreviewed} changed file(s) were not reviewed (binary, too large or over the limit).`,
    );
  const dropped = report.withheld + withheld;
  if (dropped > 0)
    lines.push(
      '',
      `${dropped} finding(s) were withheld: no line of this change to anchor to, or text that looked like a credential.`,
    );
  lines.push('', `Model ${agent.model} · ${run?.calls ?? 0} calls · ${cost}`);
  const summaryRef = reference(p, 'summary');
  if (!already(summaryRef)) {
    await platform
      .comment(p.repo, p.change, `${lines.join('\n')}${footer(agent, summaryRef)}`)
      .catch((e) => {
        if (!(e instanceof PlatformError && e.code === 'SECRET_DETECTED')) throw e;
      });
  }

  // Low findings alone pass; any high or medium finding fails the check.
  const status = counts.high + counts.medium > 0 ? 'fail' : 'pass';
  await platform.check(p.repo, p.head, agent.check, status, {
    agent: agent.id,
    run: p.run,
    model: agent.model,
    findings: counts,
    withheld: dropped,
    unreviewed: report.unreviewed,
  });
  return { posted, withheld };
}
