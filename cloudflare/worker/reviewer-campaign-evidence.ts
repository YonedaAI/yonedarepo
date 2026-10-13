import { ledger } from './storage';
import type { Env, Json } from './types';

export function checkedFinal(detail: Json) {
  const run = detail.run ?? detail.runs?.[0];
  if (!run || !['ready', 'accepted'].includes(run.status)) return null;
  return detail.candidates?.find(
    (candidate: Json) =>
      candidate.run_id === run.id &&
      (run.mode !== 'collaborate' ||
        candidate.integration_manifest ||
        detail.executions?.some(
          (execution: Json) =>
            execution.id === candidate.execution && execution.team_role === 'integrator',
        )) &&
      candidate.status === 'eligible' &&
      detail.evaluations?.some(
        (evaluation: Json) =>
          evaluation.id === candidate.evaluation &&
          evaluation.candidate === candidate.id &&
          evaluation.revision?.repository === candidate.revision?.repository &&
          evaluation.revision?.commit === candidate.revision?.commit &&
          evaluation.policy === run.policy.version &&
          evaluation.suite === run.policy.suite &&
          evaluation.environment === run.policy.environment &&
          evaluation.app?.revision === candidate.revision?.commit &&
          evaluation.app?.bundle_digest &&
          evaluation.checks?.length &&
          evaluation.checks.every((check: Json) => check.status === 'pass'),
      ),
  );
}

export async function latestChecked(env: Env, owner: string, repo: string) {
  let cursor: string | undefined;
  let watermark: number | undefined;
  for (let pageNumber = 0; pageNumber < 40; pageNumber++) {
    const page = await ledger(env, repo, {
      op: 'runs_page',
      limit: 50,
      cursor,
      watermark,
      _workspace: owner,
    });
    watermark ??= page.watermark;
    for (const item of page.items) {
      if (!['ready', 'accepted'].includes(item.status)) continue;
      const detail = await ledger(env, repo, {
        op: 'run_detail',
        run_id: item.id,
        _workspace: owner,
      });
      const candidate = checkedFinal(detail);
      if (candidate)
        return {
          repo_id: repo,
          run_id: item.id,
          candidate_id: candidate.id,
          evaluation_id: candidate.evaluation,
          revision: candidate.revision,
          url: `/?repo=${encodeURIComponent(repo)}&run=${encodeURIComponent(item.id)}`,
        };
    }
    if (page.next_cursor == null) return null;
    cursor = page.next_cursor;
  }
  throw new Error('Reviewer history exceeds bounded discovery; owner must select checked evidence');
}
