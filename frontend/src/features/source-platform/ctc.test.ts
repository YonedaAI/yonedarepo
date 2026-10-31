// The CTC page as the server would render it: every open Landing with its state, what it waits
// for, its place in line, what it overlaps and the last decision, and the empty, loading and
// error states, on the pure rules beside it.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CtcRadar, RadarLanding } from '../../../../shared/contracts/ctc-radar';
import type { Loaded } from './useSource';

const state: { value: Loaded<CtcRadar>; paths: (string | null)[] } = {
  value: { loading: true, reload: () => {} },
  paths: [],
};
vi.mock('./useSource', () => ({
  useSource: (path: string | null) => {
    state.paths.push(path);
    return state.value;
  },
}));

const { RepoCtc } = await import('./RepoCtc');
const { CTC_POLL_MS, ctcPath, lastLine, overlapLine, placeLine, stateLabel, visibleEvery } =
  await import('./ctcModel');

const REPO = 'r0123456789abcdef0123';
const loaded = (data: CtcRadar) => ({ data, loading: false, reload: () => {} });
const landing = (over: Partial<RadarLanding> = {}): RadarLanding => ({
  number: 7,
  title: 'Retry budget',
  branch: 'fix',
  base: 'main',
  author: 'token:agent',
  head: 'a'.repeat(40),
  decision: 'hold',
  reasons: [{ code: 'GATES', reason: 'Approvals: waiting for 1' }],
  place: { position: 2, line: 'waiting', ticket: null },
  overlaps: [],
  last: null,
  ...over,
});
const page = () =>
  renderToStaticMarkup(
    createElement(RepoCtc, {
      repo: REPO,
      hrefOf: (n: number) => `/source/${REPO}/changes/${n}`,
      onOpen: () => {},
    }),
  );

beforeEach(() => {
  state.value = { loading: true, reload: () => {} };
  state.paths = [];
});

describe('the words', () => {
  it('names each state', () => {
    expect(stateLabel('cleared')).toBe('Cleared');
    expect(stateLabel('hold')).toBe('Hold');
    expect(stateLabel('go_around')).toBe('Go-around');
    expect(stateLabel(null)).toBe('Not judged');
  });

  it('places a Landing in line', () => {
    expect(placeLine(null)).toBe('—');
    expect(placeLine({ position: 1, line: 'queued', ticket: 12 })).toBe('1 · queued, ticket 12');
    expect(placeLine({ position: 2, line: 'cleared', ticket: null })).toBe('2 · cleared');
    expect(placeLine({ position: 3, line: 'waiting', ticket: null })).toBe('3 · waiting');
  });

  it('says how two Landings meet', () => {
    expect(
      overlapLine({ landing: 4, overlap: 'symbol', paths: ['src/net.rs'], symbols: ['retry'] }),
    ).toBe('same symbol: retry in src/net.rs');
    expect(overlapLine({ landing: 4, overlap: 'file', paths: ['a.rs', 'b.rs'], symbols: [] })).toBe(
      'same file: a.rs, b.rs',
    );
    expect(overlapLine({ landing: 4, overlap: 'read', paths: ['a.rs'], symbols: [] })).toBe(
      'read conflict: a.rs',
    );
  });

  it('says what the last decision was, and whether it is about this head', () => {
    const last = {
      decision: 'hold' as const,
      reason: 'Landing 3 is ahead',
      at: 1,
      on_head: true,
      landed_version: null,
    };
    expect(lastLine(last)).toBe('Hold: Landing 3 is ahead');
    expect(lastLine({ ...last, on_head: false })).toBe('Hold: Landing 3 is ahead (older head)');
    expect(lastLine({ ...last, decision: 'cleared', reason: null })).toBe('Cleared');
  });

  it('reads the radar from one path', () => {
    expect(ctcPath(REPO)).toBe(`/repos/${REPO}/ctc`);
    expect(CTC_POLL_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('polling', () => {
  it('asks again on a timer only while the page is on screen, and stops when asked', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const seen = { hidden: false };
    const stop = visibleEvery(1000, reload, () => !seen.hidden);
    vi.advanceTimersByTime(1000);
    expect(reload).toHaveBeenCalledTimes(1);
    seen.hidden = true;
    vi.advanceTimersByTime(3000);
    expect(reload).toHaveBeenCalledTimes(1);
    seen.hidden = false;
    vi.advanceTimersByTime(1000);
    expect(reload).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(5000);
    expect(reload).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('the page', () => {
  it('reads /ctc and shows that it is loading', () => {
    expect(page()).toContain('Loading CTC radar');
    expect(state.paths).toContain(`/repos/${REPO}/ctc`);
  });

  it('says so when nothing is open', () => {
    state.value = loaded({ land_when_cleared: true, landings: [], truncated: false });
    const html = page();
    expect(html).toContain('No open Landings');
    expect(html).not.toContain('<table');
  });

  it('shows a failed read with a way to try again', () => {
    state.value = { error: 'boom', loading: false, reload: () => {} };
    const html = page();
    expect(html).toContain('role="alert"');
    expect(html).toContain('<button');
  });

  it('shows every column for a Landing', () => {
    state.value = loaded({
      land_when_cleared: true,
      truncated: false,
      landings: [
        landing({
          overlaps: [{ landing: 4, overlap: 'file', paths: ['src/net.rs'], symbols: [] }],
          last: {
            decision: 'hold',
            reason: 'Landing 4 is ahead in the queue',
            at: 1_800_000_000_000,
            on_head: true,
            landed_version: null,
          },
        }),
      ],
    });
    const html = page();
    expect(html).toContain('<h2 id="ctc-heading">CTC</h2>');
    expect(html).toContain(`href="/source/${REPO}/changes/7"`);
    expect(html).toContain('Retry budget');
    expect(html).toContain('Hold');
    expect(html).toContain('Approvals: waiting for 1');
    expect(html).toContain('2 · waiting');
    expect(html).toContain(`href="/source/${REPO}/changes/4"`);
    expect(html).toContain('same file: src/net.rs');
    expect(html).toContain('Hold: Landing 4 is ahead in the queue');
    expect(html).not.toContain('nothing lands on its own');
  });

  it('says when the repository does not land on its own, and when the list was cut', () => {
    state.value = loaded({ land_when_cleared: false, truncated: true, landings: [landing()] });
    const html = page();
    expect(html).toContain('nothing lands on its own');
    expect(html).toContain('newest');
  });
});
