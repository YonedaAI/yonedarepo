import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CloneButton } from './CodeParts';
import { ConnectPanel } from './ConnectPanel';
import {
  apiOrigin,
  claudeMcpJson,
  cloneCommand,
  codexToml,
  expiresIn,
  httpsCloneCommand,
  isUserCode,
  loginCommand,
  mcpUrl,
  normalizeUserCode,
  scopeList,
} from './connect';
import { formatSourceRoute, parseSourceRoute } from './sourceRoute';

const api = 'https://api.dev.yonedarepo.com';
const repo = 'r0123456789abcdef0123';

/** Each copy block's label and the exact text it shows (which is the text Copy copies). */
const copyBlocks = (html: string) =>
  [...html.matchAll(/<span>([^<]+)<\/span>.*?<code>([^<]*)<\/code>/g)].map(([, label, text]) => [
    label,
    text,
  ]);

describe('the Clone menu', () => {
  it('offers the yoneda remote helper first, then HTTPS, as whole git clone commands', () => {
    const html = renderToStaticMarkup(
      createElement(CloneButton, { repo, name: 'demo', origin: api }),
    );
    expect(copyBlocks(html)).toEqual([
      ['yoneda remote helper (recommended)', `git clone yoneda::${api}/${repo} demo`],
      ['HTTPS (needs a personal token as the password)', `git clone ${api}/git/${repo}.git demo`],
    ]);
  });
  it('waits for the repository name: never a command that clones into a directory named by the id', () => {
    const html = renderToStaticMarkup(createElement(CloneButton, { repo, origin: api }));
    expect(html).not.toContain('git clone');
    expect(html).toContain('Loading the clone commands');
  });
  it('says what each needs: one yoneda login on the API origin, or a personal token', () => {
    for (const component of [CloneButton, ConnectPanel]) {
      const html = renderToStaticMarkup(
        createElement(component, { repo, name: 'demo', origin: api }),
      );
      expect(html).toContain(`Run once: <code>yoneda login --origin ${api}</code>`);
      expect(html).toContain('then pull/push use your login');
      expect(html).toContain('href="/settings#personal-tokens"');
      expect(html).toContain('Settings → Personal tokens');
      const order = copyBlocks(html).map(([label]) => label);
      expect(order.slice(0, 2)).toEqual([
        'yoneda remote helper (recommended)',
        'HTTPS (needs a personal token as the password)',
      ]);
    }
    expect(loginCommand('https://api.yonedarepo.com')).toBe(
      'yoneda login --origin https://api.yonedarepo.com',
    );
  });
  it('builds the HTTPS command with and without a directory', () => {
    expect(httpsCloneCommand(api, repo)).toBe(`git clone ${api}/git/${repo}.git`);
    expect(httpsCloneCommand(api, repo, 'demo')).toBe(`git clone ${api}/git/${repo}.git demo`);
  });
});

describe('connect snippets', () => {
  it('points every Connect line at the API origin; only downloads come from the site', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectPanel, { repo, name: 'demo', origin: api }),
    ).replaceAll('&quot;', '"');
    expect(html).toContain(`git clone ${api}/git/${repo}.git demo`);
    expect(html).toContain(`git clone yoneda::${api}/${repo} demo`);
    expect(html).toContain(`yoneda login --origin ${api}`);
    expect(html).toContain(`${api}/api/v1/mcp`);
    // The installer and the plugin marketplace are files the site serves, not API calls.
    const install = 'curl -fsSL https://dev.yonedarepo.com/install.sh | sh';
    const marketplace =
      '/plugin marketplace add https://dev.yonedarepo.com/downloads/claude/marketplace.json';
    expect(html).toContain(install);
    expect(html).toContain(marketplace);
    expect(html.replace(install, '').replace(marketplace, '')).not.toContain(
      'https://dev.yonedarepo.com',
    );
  });
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
