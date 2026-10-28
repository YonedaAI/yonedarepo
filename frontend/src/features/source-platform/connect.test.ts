import { describe, expect, it } from 'vitest';
import {
  apiOrigin,
  claudeMcpJson,
  cloneCommand,
  codexToml,
  expiresIn,
  isUserCode,
  mcpUrl,
  normalizeUserCode,
  scopeList,
} from './connect';
import { formatSourceRoute, parseSourceRoute } from './sourceRoute';

const api = 'https://api.dev.yonedarepo.com';
const repo = 'r0123456789abcdef0123';

describe('connect snippets', () => {
  it('uses the configured API origin, else the page origin, without a trailing slash', () => {
    expect(apiOrigin('https://dev.yonedarepo.com', `${api}/`)).toBe(api);
    expect(apiOrigin('https://dev.yonedarepo.com', '  ')).toBe('https://dev.yonedarepo.com');
    expect(apiOrigin('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
  });
  it('builds the clone command and MCP configuration from the origin', () => {
    expect(cloneCommand(api, repo)).toBe(`git clone yoneda::${api}/${repo}`);
    expect(cloneCommand(api, repo, 'demo')).toBe(`git clone yoneda::${api}/${repo} demo`);
    expect(mcpUrl(api)).toBe(`${api}/api/v1/mcp`);
    const claude = JSON.parse(claudeMcpJson(api)).mcpServers.yoneda;
    expect(claude).toEqual({
      type: 'http',
      url: `${api}/api/v1/mcp`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it from the environment.
      headers: { Authorization: 'Bearer ${YONEDA_TOKEN}' },
    });
    expect(codexToml(api)).toBe(
      `[mcp_servers.yoneda]\nurl = "${api}/api/v1/mcp"\nbearer_token_env_var = "YONEDA_TOKEN"`,
    );
  });
  it('reads stored repository token scopes in any of their forms', () => {
    expect(scopeList('["read","write"]')).toEqual(['read', 'write']);
    expect(scopeList('read, land')).toEqual(['read', 'land']);
    expect(scopeList(['review'])).toEqual(['review']);
    expect(scopeList(null)).toEqual([]);
  });
  it('normalizes device user codes and rejects other alphabets', () => {
    expect(normalizeUserCode('bcdf-ghjk')).toBe('BCDF-GHJK');
    expect(normalizeUserCode('bcdfghjk')).toBe('BCDF-GHJK');
    expect(normalizeUserCode('bcd')).toBe('BCD');
    expect(isUserCode('bcdfghjk')).toBe(true);
    expect(isUserCode('ABCD-EFGH')).toBe(false); // vowels are not in the RFC 8628 alphabet
    expect(isUserCode('BCDF-GHJ')).toBe(false);
  });
  it('describes expiry relative to now', () => {
    const now = 1_000_000_000_000;
    expect(expiresIn(null, now)).toBe('never');
    expect(expiresIn(now - 1, now)).toBe('expired');
    expect(expiresIn(now + 86_400_000, now)).toBe('in 1 day');
    expect(expiresIn(now + 30 * 86_400_000, now)).toBe('in 30 days');
  });
});

describe('settings, connect and device routes', () => {
  it('round-trips the views', () => {
    for (const route of [
      { view: 'settings' } as const,
      { view: 'repo-settings', repo, section: 'connect' } as const,
      { view: 'device', code: 'BCDF-GHJK' } as const,
      { view: 'device', code: '' } as const,
    ]) {
      const [path, search = ''] = formatSourceRoute(route).split('?');
      expect(parseSourceRoute(path, search ? `?${search}` : '')).toEqual(route);
    }
    expect(formatSourceRoute({ view: 'settings' })).toBe('/settings');
    expect(formatSourceRoute({ view: 'repo-settings', repo, section: 'connect' })).toBe(
      `/source/${repo}/settings/connect`,
    );
    expect(formatSourceRoute({ view: 'device', code: 'BCDF-GHJK' })).toBe('/device?code=BCDF-GHJK');
    // Older addresses still open the page that replaced them.
    expect(parseSourceRoute('/source/tokens', '')).toEqual({ view: 'settings' });
    expect(parseSourceRoute(`/source/${repo}/connect`, '')).toEqual({
      view: 'repo-settings',
      repo,
      section: 'connect',
    });
    expect(parseSourceRoute('/device', '?code=bcdfghjk')).toEqual({
      view: 'device',
      code: 'BCDF-GHJK',
    });
  });
});
