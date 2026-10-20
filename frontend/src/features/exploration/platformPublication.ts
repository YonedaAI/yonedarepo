// Publication is the owner's own platform landing: this browser session approves and lands
// the selected commit on the project's platform repository, then the agent layer reads the
// platform back. The agent layer never holds a credential that could land.
import { api } from '../../lib/api';
import type { Repository } from '../../lib/types';
import { SourceApiError, sourceApi } from '../source-platform/sourceApi';

export type OwnerLanding = {
  platform_repo: string;
  ref: string;
  commit: string;
  expected: string;
  break_glass: boolean;
};

/** The landing a still-pending decision needs (for finishing an interrupted publication). */
export function pendingLanding(
  repository: Repository,
  decision: Record<string, any> | undefined,
): OwnerLanding | null {
  if (decision?.status !== 'publication_pending' || !repository.platform_repo) return null;
  return {
    platform_repo: repository.platform_repo,
    ref: 'main',
    commit: decision.target?.commit,
    expected: decision.publication_expected?.commit,
    break_glass: decision.checks_overridden === true,
  };
}

const tolerated = (error: unknown, code: string) =>
  error instanceof SourceApiError && error.code === code;

export async function publishOnPlatform(
  repoId: string,
  decisionId: string,
  landing: OwnerLanding | null | undefined,
) {
  if (landing?.platform_repo) {
    const repo = `/repos/${landing.platform_repo}`;
    try {
      await sourceApi(`${repo}/commits/${landing.commit}/reviews`, {
        body: { decision: 'approve' },
      });
    } catch (error) {
      if (!tolerated(error, 'ALREADY_EXISTS')) throw error;
    }
    try {
      if (landing.break_glass)
        await sourceApi(`${repo}/break-glass`, {
          body: {
            action: 'land',
            ref: landing.ref,
            commit: landing.commit,
            expected_old: landing.expected,
            reason: 'Owner accepted this result despite failing checks',
          },
        });
      else
        await sourceApi(`${repo}/land`, {
          body: { ref: landing.ref, commit: landing.commit, fast_forward_only: true },
        });
    } catch (error) {
      // A moved main is recorded as a publication conflict by the readback below.
      if (!tolerated(error, 'STALE_HEAD')) throw error;
    }
  }
  return api(`repos/${repoId}/publication_readback`, { decision_id: decisionId });
}
