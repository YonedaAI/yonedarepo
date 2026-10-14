import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GuidedSessionPanel } from './GuidedSessionPanel';
import { sessionFixture } from './guidedFixture';
import { guideRefreshText, refreshGuideAndSnapshot } from './guidedRefresh';

const panel = (refresh: Parameters<typeof GuidedSessionPanel>[0]['refresh']) =>
  renderToStaticMarkup(
    createElement(GuidedSessionPanel, {
      session: sessionFixture(),
      busy: false,
      onStart: () => {},
      onInspect: () => {},
      onRefresh: () => {},
      refresh,
    }),
  );

describe('guided refresh feedback', () => {
  it('re-reads the guide and the snapshot, and only a failed guide read is a failure', async () => {
    const snapshot = vi.fn().mockRejectedValue(new Error('snapshot offline'));
    expect(await refreshGuideAndSnapshot(async () => 'applied', snapshot)).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(await refreshGuideAndSnapshot(async () => 'superseded')).toBe(true);
    expect(await refreshGuideAndSnapshot(async () => 'failed')).toBe(false);
  });

  it('spins and disables the button while the request is in flight', () => {
    const html = panel({ refreshing: true });
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*aria-label="Refresh guide"/,
    );
    expect(html).toContain('class="lucide lucide-refresh-cw spin"');
    expect(html).toContain('aria-live="polite">Updating…</small>');
  });

  it('announces the last update and shows a short inline error', () => {
    const now = Date.UTC(2026, 9, 14, 12, 53);
    expect(guideRefreshText({ refreshing: false, refreshedAt: now - 5_000 }, now)).toBe(
      'Updated just now',
    );
    expect(guideRefreshText({ refreshing: false, refreshedAt: now - 5 * 60_000 }, now)).toMatch(
      /^Updated \d/,
    );
    expect(guideRefreshText({ refreshing: false })).toBe('');
    const failed = panel({ refreshing: false, error: 'Could not refresh the guide. Try again.' });
    expect(failed).toContain('guided-refresh-status failed');
    expect(failed).toContain('Could not refresh the guide. Try again.');
    expect(panel({ refreshing: false })).not.toContain('disabled=""');
  });
});
