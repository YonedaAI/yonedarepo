export type GuideRefreshState = {
  refreshing: boolean;
  /** Epoch milliseconds of the last successful manual refresh. */
  refreshedAt?: number;
  error?: string;
};

/**
 * Refresh the guide and the repository snapshot together. True unless the guide read failed; a
 * read superseded by a newer one (such as the running-step poll) still counts as refreshed.
 */
export async function refreshGuideAndSnapshot(
  guide: () => Promise<'applied' | 'superseded' | 'failed'>,
  snapshot?: () => Promise<void>,
) {
  const [read] = await Promise.allSettled([guide(), snapshot?.()]);
  return read.status === 'fulfilled' && read.value !== 'failed';
}

/** Muted status line under the guide heading. */
export function guideRefreshText(state: GuideRefreshState, now = Date.now()) {
  if (state.refreshing) return 'Updating…';
  if (state.error) return state.error;
  if (state.refreshedAt === undefined) return '';
  if (now - state.refreshedAt < 60_000) return 'Updated just now';
  const time = new Date(state.refreshedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Updated ${time}`;
}
