import { describe, expect, it } from 'vitest';
import { oauthStartUrl } from '../workspace/oauthModel';
import { landingSource, rememberLanding } from './landingSource';

function memory(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => void values.set(k, v),
    removeItem: (k) => void values.delete(k),
    clear: () => values.clear(),
    key: (i) => [...values.keys()][i] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe('landing source', () => {
  it('keeps the first landing page referring host and campaign tags for the tab', () => {
    const storage = memory();
    rememberLanding(
      storage,
      'https://yonedarepo.com/pricing?utm_source=hn&utm_medium=social&utm_campaign=launch&x=1',
      'https://news.ycombinator.com/item?id=1',
    );
    rememberLanding(storage, 'https://yonedarepo.com/docs?utm_source=later', 'https://google.com/');
    expect(landingSource(storage)).toEqual({
      ref: 'news.ycombinator.com',
      utm_source: 'hn',
      utm_medium: 'social',
      utm_campaign: 'launch',
    });
  });

  it('ignores its own site as a referrer, trims long tags and survives missing storage', () => {
    const storage = memory();
    rememberLanding(
      storage,
      `https://yonedarepo.com/?utm_campaign=${'c'.repeat(100)}`,
      'https://yonedarepo.com/blog',
    );
    expect(landingSource(storage)).toEqual({ utm_campaign: 'c'.repeat(64) });
    expect(landingSource(null)).toEqual({});
    expect(() => rememberLanding(null, 'https://yonedarepo.com/', '')).not.toThrow();
    const broken = memory();
    broken.setItem('yoneda.landing', '{not json');
    expect(landingSource(broken)).toEqual({});
  });

  it('sends the source with a provider sign-in, never with a link', () => {
    const source = { ref: 'github.com', utm_source: 'readme' };
    expect(oauthStartUrl('github', { returnTo: '/docs', source })).toBe(
      '/auth/github/start?return_to=%2Fdocs&ref=github.com&utm_source=readme',
    );
    expect(oauthStartUrl('github', { intent: 'link', source })).toBe(
      '/auth/github/start?intent=link',
    );
  });
});
