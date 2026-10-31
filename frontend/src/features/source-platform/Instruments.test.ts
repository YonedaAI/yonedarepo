// A change's instrument cards as the server would render them: Slop from check evidence, Risk
// with its reasons, and nothing at all when there is nothing real to show.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeadReading } from '../../../../shared/contracts/change-instruments';
import type { Loaded } from './useSource';

const state: { value: Loaded<any>; paths: (string | null)[] } = {
  value: { loading: true, reload: () => {} },
  paths: [],
};
vi.mock('./useSource', () => ({
  useSource: (path: string | null) => {
    state.paths.push(path);
    return path?.endsWith('/gates') ? { loading: true, reload: () => {} } : state.value;
  },
}));

const { Instruments, instrumentsKey } = await import('./Instruments');
const { ChangeView } = await import('./ChangeView');

const REPO = 'r0123456789abcdef0123';
const loaded = (data: unknown) => ({ data, loading: false, reload: () => {} });
const html = () => renderToStaticMarkup(createElement(Instruments, { repo: REPO, number: 3 }));

const risk = (level: string, score: number) => ({
  level,
  score,
  reasons: [
    { input: 'classes', points: 15, why: 'Code logic changed' },
    { input: 'size', points: 5, why: '4 files, 120 lines' },
    { input: 'sensitive', points: 20, why: 'Workflows: .github/workflows/ci.yml' },
    { input: 'findings', points: 0, why: 'No open findings' },
  ],
});
const slop = (value: string) => ({ name: 'slop-review', value, recorded_at: 1 });
const head = (over: Partial<HeadReading>): HeadReading => ({
  commit: `c${Math.random()}`,
  at: 1_700_000_000_000,
  checks: [],
  risk: null,
  ...over,
});

beforeEach(() => {
  state.paths = [];
});

describe('Instruments', () => {
  it('shows nothing while loading, after a failure, or with no heads', () => {
    state.value = { loading: true, reload: () => {} };
    expect(html()).toBe('');
    state.value = { error: 'boom', loading: false, reload: () => {} };
    expect(html()).toBe('');
    state.value = loaded({ number: 3, heads: [] });
    expect(html()).toBe('');
  });

  it('reads the change it is on', () => {
    html();
    expect(state.paths).toContain(`/repos/${REPO}/changes/3/instruments`);
  });

  it('shows nothing when no agent reported and no head could be scored', () => {
    state.value = loaded({ number: 3, heads: [head({}), head({})] });
    expect(html()).toBe('');
  });

  it('leaves Slop out for a repository with no agents, and keeps Risk', () => {
    state.value = loaded({ number: 3, heads: [head({ risk: risk('medium', 40) as never })] });
    const page = html();
    expect(page).toContain('Risk (beta)');
    expect(page).not.toContain('Slop');
  });

  it('shows the current Slop value and a five-push trend', () => {
    state.value = loaded({
      number: 3,
      heads: [
        head({ checks: [slop('medium')] as never }),
        head({ checks: [slop('low')] as never }),
        head({ checks: [slop('high')] as never }),
      ],
    });
    const page = html();
    expect(page).toContain('Slop');
    expect(page).toContain('Medium');
    expect(page.match(/result-tile/g)).toHaveLength(5);
    expect(page.match(/tone-warn/g)).toHaveLength(1);
    expect(page.match(/tone-good/g)).toHaveLength(1);
    expect(page.match(/tone-bad/g)).toHaveLength(1);
    expect(page.match(/tone-empty/g)).toHaveLength(2);
  });

  it('does not pass an older head off as the current Slop value', () => {
    state.value = loaded({
      number: 3,
      heads: [head({}), head({ checks: [slop('low')] as never })],
    });
    const page = html();
    expect(page).toContain('Not reviewed yet');
    expect(page).not.toContain('>Low<');
  });

  it('shows the level, every reason and what it is made from, never a percentage', () => {
    state.value = loaded({
      number: 3,
      heads: [
        head({ risk: risk('medium', 40) as never }),
        head({ risk: risk('low', 15) as never }),
        head({ risk: null }),
      ],
    });
    const page = html();
    expect(page).toContain('Risk (beta)');
    expect(page).toContain('Medium');
    for (const text of ['Code logic changed', '4 files, 120 lines', 'No open findings']) {
      expect(page).toContain(text);
    }
    expect(page).toContain('.github/workflows/ci.yml');
    expect(page).toContain('+20');
    expect(page).toContain('Does not affect landing');
    expect(page).not.toContain('%');
    expect(page.match(/tone-warn/g)).toHaveLength(1);
    expect(page.match(/tone-good/g)).toHaveLength(1);
  });

  it('reads again when the head or the open comments change', () => {
    const change = (head: string, comments: object[]) => ({ head, comments }) as never;
    const open = { path: 'a.rs', resolved_at: null };
    const done = { path: 'a.rs', resolved_at: 5 };
    const general = { path: null, resolved_at: null };
    expect(instrumentsKey(change('a', [open]))).not.toBe(instrumentsKey(change('b', [open])));
    expect(instrumentsKey(change('a', [open]))).not.toBe(instrumentsKey(change('a', [done])));
    expect(instrumentsKey(change('a', [done]))).toBe(instrumentsKey(change('a', [general])));
  });
});

describe('ChangeView', () => {
  const change = {
    number: 3,
    title: 'Retry',
    body: '',
    branch: 'fix',
    base: 'main',
    author: 'token:agent',
    status: 'open',
    created_at: 1,
    updated_at: 1,
    head: 'a'.repeat(40),
    head_commit: null,
    comments: [],
    timeline: [],
    diff: null,
  };

  it('asks for nothing when the deployment has no instruments', () => {
    state.value = loaded(change);
    renderToStaticMarkup(createElement(ChangeView, { repo: REPO, number: 3 }));
    expect(state.paths).not.toContain(`/repos/${REPO}/changes/3/instruments`);
  });

  it('puts the cards above the gates when it has', () => {
    state.value = loaded({ ...change, instruments: true });
    renderToStaticMarkup(createElement(ChangeView, { repo: REPO, number: 3 }));
    expect(state.paths).toContain(`/repos/${REPO}/changes/3/instruments`);
  });
});
