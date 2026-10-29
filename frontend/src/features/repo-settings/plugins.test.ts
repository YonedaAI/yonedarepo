// Settings → Plugins: which plugins count as installed (from tokens and hooks), the bodies
// the AgentHero install sends, a reinstall's fresh token name and the MCP address.
import { describe, expect, it } from 'vitest';
import type { RepoToken } from '../source-platform/RepoTokens';
import type { Hook } from './HookParts';
import {
  AGENTHERO_TOKEN,
  agentHeroHookBody,
  agentHeroTokenBody,
  agentHeroTokenName,
  installedPlugins,
  isInstalled,
  MANAGED_TOKEN,
  repoMcpUrl,
  SUGGESTED,
  validHookUrl,
} from './pluginsModel';

const repo = 'r0123456789abcdef0123';
const token = (name: string, revoked = false): RepoToken => ({
  name,
  scopes: ['read', 'review', 'check'],
  created_at: 1,
  revoked_at: revoked ? 2 : null,
});
const hook = (id: number, events: string[] | null, created_at = id): Hook => ({
  id,
  url: `https://hooks.example.com/${id}`,
  events,
  paths: null,
  active: true,
  created_at,
});

describe('plugins', () => {
  it('suggests AgentHero for repository events', () => {
    expect(SUGGESTED.map((p) => [p.name, p.summary])).toEqual([
      ['AgentHero', 'Run multi-agent Apps on repo events'],
    ]);
  });

  it('installs AgentHero with a read, review and check token and a change/branch/check hook', () => {
    expect(agentHeroTokenBody([])).toEqual({
      name: 'plugin-agenthero',
      scopes: ['read', 'review', 'check'],
    });
    expect(agentHeroHookBody('  https://agenthero.example.com/h  ')).toEqual({
      url: 'https://agenthero.example.com/h',
      events: ['change', 'branch', 'check'],
    });
    expect(repoMcpUrl('https://api.example.com', repo)).toBe(
      `https://api.example.com/api/v1/repos/${repo}/mcp`,
    );
  });

  it('takes a fresh token name after an uninstall (names are never reused)', () => {
    expect(agentHeroTokenName([token(AGENTHERO_TOKEN, true)])).toBe('plugin-agenthero-2');
    expect(
      agentHeroTokenName([token(AGENTHERO_TOKEN, true), token('plugin-agenthero-2', true)]),
    ).toBe('plugin-agenthero-3');
  });

  it('accepts only https webhook URLs', () => {
    expect(validHookUrl('https://agenthero.example.com/hooks/1')).toBe(true);
    expect(validHookUrl('http://agenthero.example.com')).toBe(false);
    expect(validHookUrl('https://user:pw@agenthero.example.com')).toBe(false);
    expect(validHookUrl('not a url')).toBe(false);
  });

  it('finds installed plugins from live tokens, and AgentHero’s newest matching hook', () => {
    expect(installedPlugins([], [])).toEqual([]);
    expect(installedPlugins([token(AGENTHERO_TOKEN, true)], [])).toEqual([]);
    const hooks = [
      hook(1, ['branch', 'change', 'check'], 10),
      hook(2, ['change', 'branch', 'check'], 20),
      hook(3, null, 30),
      hook(4, ['land'], 40),
    ];
    const found = installedPlugins(
      [token(MANAGED_TOKEN), token(AGENTHERO_TOKEN, true), token('plugin-agenthero-2')],
      hooks,
    );
    expect(found.map((p) => p.id)).toEqual(['managed', 'agenthero']);
    const hero = found[1];
    expect(hero.id === 'agenthero' && hero.token.name).toBe('plugin-agenthero-2');
    expect(hero.id === 'agenthero' && hero.hook?.id).toBe(2);
    expect(isInstalled(found, 'agenthero')).toBe(true);
    expect(isInstalled(installedPlugins([token(MANAGED_TOKEN)], hooks), 'agenthero')).toBe(false);
    // A token alone counts as installed; its missing hook is reported, not invented.
    const alone = installedPlugins([token(AGENTHERO_TOKEN)], [hook(4, ['land'])]);
    expect(alone).toEqual([{ id: 'agenthero', name: 'AgentHero', token: token(AGENTHERO_TOKEN) }]);
  });
});
