// Account settings (tokens, signed-in CLIs), repository tokens, device approval and the
// Connect panel, rendered as the server would see them: loading, signed out, failed, empty
// and populated states.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Loaded } from './useSource';

const state: { value: Loaded<any> } = { value: { loading: true, reload: () => {} } };
vi.mock('./useSource', () => ({ useSource: () => state.value }));

const { ConnectPanel, DeleteRepository } = await import('./ConnectPanel');
const { DeviceOutcome, DevicePage, deviceFailure } = await import('./DevicePage');
const { PatDialog, PatTable } = await import('./PersonalTokens');
const { RepoTokenTable, RepoTokens } = await import('./RepoTokens');
const { AccountSettings } = await import('../account-settings/AccountSettings');
const { CliTable } = await import('../account-settings/TokenSettings');
const { SourceApiError } = await import('./sourceApi');

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const loaded = (value: Partial<Loaded<any>>): Loaded<any> => ({
  loading: false,
  reload: () => {},
  ...value,
});
const signedOut = loaded({ error: 'Sign in or use a repository token' });
const api = 'https://api.dev.yonedarepo.com';
const repo = 'r0123456789abcdef0123';
const repos = [
  { id: repo, name: 'demo', created_at: 1 },
  { id: 'rffffffffffffffffffff', name: 'other', created_at: 2 },
];
const day = 86_400_000;
const now = 1_800_000_000_000;

beforeEach(() => {
  state.value = { loading: true, reload: () => {} };
});

describe('personal access tokens', () => {
  const pat = {
    id: 'pat_0123456789abcdef',
    name: 'ci',
    scopes: ['repo:read', 'repo:write'],
    repos: [repo],
    created_at: now - day,
    expires_at: now + 7 * day,
    last_used_at: null,
    origin: null,
    host: null,
  };
  it('shows loading, failure, empty and populated states', () => {
    const props = { repos, onRevoke: () => {}, now };
    expect(html(PatTable, { ...props, tokens: loaded({ loading: true }) })).toContain(
      'Loading tokens',
    );
    expect(html(PatTable, { ...props, tokens: loaded({ error: 'boom' }) })).toContain('Retry');
    expect(html(PatTable, { ...props, tokens: signedOut })).toContain('You are signed out');
    expect(html(PatTable, { ...props, tokens: loaded({ data: { tokens: [] } }) })).toContain(
      'No personal access tokens',
    );
    const table = html(PatTable, { ...props, tokens: loaded({ data: { tokens: [pat] } }) });
    expect(table).toContain('repo:read, repo:write');
    expect(table).toContain('<td>demo</td>'); // allowlist ids shown as repository names
    expect(table).toContain('in 7 days');
    expect(table).toContain('<td>never</td>');
    expect(table).toContain('>Revoke</button>');
    const open = html(PatTable, {
      ...props,
      tokens: loaded({ data: { tokens: [{ ...pat, repos: null }] } }),
    });
    expect(open).toContain('<td>all</td>');
  });
  it('settles the Tokens page: signed out, then CLIs apart from personal tokens', () => {
    const identity = { role: 'user', username: 'ada' };
    const section = 'tokens';
    expect(html(AccountSettings, { identity, repos, section })).toContain('Loading signed-in CLIs');
    state.value = signedOut;
    expect(html(AccountSettings, { identity, repos, section })).toContain('You are signed out');
    // A login is known by its origin (with the host it ran on), not by its name.
    const cli = {
      ...pat,
      id: 'pat_cli',
      name: 'yoneda-cli',
      repos: null,
      origin: 'login' as const,
      host: 'ada-mbp',
    };
    const older = { ...cli, id: 'pat_old', host: null };
    const named = { ...pat, id: 'pat_named', name: 'yoneda-cli' };
    state.value = loaded({ data: { tokens: [pat, cli, older, named] } });
    const page = html(AccountSettings, { identity, repos, section });
    expect(page).toContain('<h1 id="settings-title">Tokens</h1>');
    expect(page).toContain('Signed-in CLIs');
    // Personal tokens first: an old `/settings#personal-tokens` link lands on them.
    expect(page.indexOf('Personal access tokens')).toBeLessThan(page.indexOf('Signed-in CLIs'));
    expect(page).toContain('<td>ada-mbp</td>');
    expect(page).toContain('<td>unknown host</td>');
    expect(page.match(/>Sign out<\/button>/g)).toHaveLength(2);
    // A website token that happens to share the name stays with the personal tokens.
    expect(page).toContain('aria-label="Revoke yoneda-cli"');
    expect(page).toContain('<td>ci</td>');
    // The form waits behind Create token.
    expect(page).toContain('>Create token</button>');
    expect(page).not.toContain('<form');
    expect(
      html(CliTable, { tokens: loaded({ data: { tokens: [] } }), onSignOut: () => {}, now }),
    ).toContain('No CLI is signed in');
  });
  it('creates a token in a dialog: default scopes, all repositories, thirty days', () => {
    const form = html(PatDialog, { repos, orgs: [], onCreated: () => {}, onClose: () => {} });
    expect(form).toContain('aria-label="Create a personal access token"');
    // Default scopes are read, write and land; admin is opt-in.
    expect(form.match(/type="checkbox" checked=""/g)?.length).toBeGreaterThanOrEqual(3);
    expect(form).toContain('All repositories, including ones created later.');
    expect(form).toContain('<option value="30" selected="">30 days</option>');
  });
});

describe('the account settings pages', () => {
  const identity = { role: 'user', username: 'ada' };
  const page = (section: string, over: object = {}) =>
    html(AccountSettings, { identity, repos, section, ...over });

  it('holds each section on its own page, under its own title', () => {
    state.value = loaded({ data: { tokens: [] } });
    const general = page('general');
    expect(general).toContain('<h1 id="settings-title">General</h1>');
    for (const title of ['Profile', 'Email', 'Connected accounts', 'Appearance', 'Billing'])
      expect(general).toContain(`>${title}</h2>`);
    expect(general).toContain('>ada<');
    expect(general).toContain('href="/settings/billing"');
    expect(general).toContain('>Manage billing<');
    expect(general).not.toContain('Personal access tokens');
    expect(general).not.toContain('Credit balance');
    const titled = {
      billing: 'Billing',
      tokens: 'Tokens',
      'ssh-keys': 'SSH keys',
      organizations: 'Organizations',
    };
    for (const [section, title] of Object.entries(titled)) {
      const other = page(section, { orgs: loaded({ data: { orgs: [] } }), navigate: () => {} });
      expect(other).toContain(`<h1 id="settings-title">${title}</h1>`);
      expect(other).not.toContain('Connected accounts');
      // One name per page: a page of one section does not repeat its title.
      expect(other).not.toContain(`>${title}</h2>`);
    }
  });

  it('puts each heading above its card, and leaves no form open', () => {
    state.value = loaded({ data: { tokens: [], keys: [] } });
    for (const section of ['general', 'tokens', 'ssh-keys']) {
      const shown = page(section);
      expect(shown).toMatch(
        /<section class="settings-section"[^>]*><h2[^>]*>[^<]+<\/h2><div class="settings-card">/,
      );
      expect(shown).not.toContain('<form');
      expect(shown).not.toContain('<textarea');
    }
  });

  it('gives Organizations a description and its create button, once signed in', () => {
    const props = { orgs: loaded({ data: { orgs: [] } }), navigate: () => {} };
    const orgsPage = html(AccountSettings, {
      identity,
      repos,
      section: 'organizations',
      ...props,
    });
    const head = orgsPage.slice(orgsPage.indexOf('<header'), orgsPage.indexOf('</header>'));
    expect(head).toContain('Organizations own repositories together');
    expect(head).toContain('>Create organization</button>');
    expect(orgsPage).toContain('No organizations yet');
    const out = html(AccountSettings, {
      identity: null,
      repos,
      section: 'organizations',
      ...props,
    });
    expect(out).not.toContain('Create organization');
    // Other pages have no such action.
    expect(page('tokens')).not.toContain('Create organization');
  });

  it('waits for the session, then asks a signed-out visitor to sign in', () => {
    expect(page('billing', { identity: null, loading: true })).toContain('Loading your account');
    const out = page('billing', { identity: null });
    expect(out).toContain('Sign in to see it.');
    expect(out).not.toContain('Loading');
    // The theme is this browser's, so General still offers it.
    expect(page('general', { identity: null })).toContain('Appearance');
  });
});

describe('repository tokens', () => {
  it('lists live tokens with their scopes and paths', () => {
    const tokens = loaded({
      data: {
        tokens: [
          { name: 'bot', scopes: '["read","land"]', paths: '["src/"]', created_at: 1 },
          { name: 'old', scopes: '["read"]', revoked_at: 5 },
        ],
      },
    });
    const table = html(RepoTokenTable, { tokens, onRevoke: () => {} });
    expect(table).toContain('read, land');
    expect(table).toContain('src/');
    expect(table).not.toContain('>old<');
    expect(
      html(RepoTokenTable, { tokens: loaded({ data: { tokens: [] } }), onRevoke: () => {} }),
    ).toContain('No repository tokens');
    expect(
      html(RepoTokenTable, { tokens: loaded({ loading: true }), onRevoke: () => {} }),
    ).toContain('Loading repository tokens');
  });
  it('manages the tokens of the repository it belongs to', () => {
    state.value = loaded({ data: { tokens: [] } });
    const page = html(RepoTokens, { repo });
    expect(page).toContain('No repository tokens');
    expect(page).toContain('Create repository token');
    expect(page).not.toContain('<select id="repo-token-repo"');
  });
});

describe('device approval', () => {
  it('needs a session: loading, then the sign-in prompt for a signed-out visitor', () => {
    expect(html(DevicePage, { code: 'BCDF-GHJK' })).toContain('Loading your account');
    state.value = signedOut;
    const out = html(DevicePage, { code: 'BCDF-GHJK' });
    expect(out).toContain('You are signed out');
    expect(out).not.toContain('Approve');
  });
  it('prefills the code and offers Approve and Deny', () => {
    state.value = loaded({ data: { repos } });
    const page = html(DevicePage, { code: 'BCDF-GHJK' });
    expect(page).toContain('value="BCDF-GHJK"');
    expect(page).toContain('>Approve</button>');
    expect(page).toContain('>Deny</button>');
    expect(page).not.toMatch(/<button type="submit" disabled="">Approve/);
    const empty = html(DevicePage, { code: '' });
    expect(empty).toMatch(/<button type="submit" disabled="">Approve/);
  });
  it('ticks SSH keys for a CLI login and says plainly what it does', () => {
    state.value = loaded({ data: { repos } });
    const page = html(DevicePage, { code: 'BCDF-GHJK' });
    expect(page).toMatch(/checked=""\/>SSH keys<span[^>]*> \(add and remove keys on your account/);
    expect(page).toMatch(/checked=""\/>Read/);
    expect(page).toMatch(/type="checkbox"\/>Admin/);
  });
  it('explains unknown and expired codes, and the outcome', () => {
    expect(deviceFailure(new SourceApiError('NOT_FOUND', 'x', 404))).toMatch(
      /unknown or was already used/,
    );
    expect(deviceFailure(new SourceApiError('EXPIRED_TOKEN', 'x', 400))).toMatch(/expired/);
    expect(deviceFailure(new SourceApiError('INVALID_INPUT', 'bad scopes', 400))).toBe(
      'bad scopes',
    );
    expect(html(DeviceOutcome, { outcome: 'approved' })).toContain('Return to your terminal');
    expect(html(DeviceOutcome, { outcome: 'denied' })).toContain('receives no token');
  });
});

describe('connect panel', () => {
  it('shows clone, CLI, MCP, Claude Code and Codex snippets from the configured origin', () => {
    const panel = html(ConnectPanel, { repo, name: 'demo', origin: api });
    expect(panel).toContain(`git clone ${api}/git/${repo}.git demo`);
    expect(panel).toContain(`git clone yoneda::${api}/${repo} demo`);
    expect(panel).toContain(`Repository id <code>${repo}</code>`);
    expect(panel).toContain('curl -fsSL https://dev.yonedarepo.com/install.sh | sh');
    expect(panel).not.toContain('cargo install');
    expect(panel).toContain(`${api}/api/v1/mcp`);
    expect(panel).toContain(
      '/plugin marketplace add https://dev.yonedarepo.com/downloads/claude/marketplace.json',
    );
    expect(panel).toContain('/plugin install yoneda@yonedarepo');
    expect(panel).toContain('bearer_token_env_var = &quot;YONEDA_TOKEN&quot;');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal the client expands.
    expect(panel).toContain('Bearer ${YONEDA_TOKEN}');
  });
  it('keeps delete disabled until the exact name is typed', () => {
    const form = html(DeleteRepository, { repo, name: 'demo', onDeleted: () => {} });
    expect(form).toContain('<strong>demo</strong>');
    expect(form).toMatch(/<button type="submit" class="danger" disabled="">Delete this repository/);
  });
});
