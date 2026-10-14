import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderGroupList } from './ProviderGroupList';
import type { Provider } from './ProviderSettings';
import { groupConnections, rowActionName } from './providerGroups';

const connection = (id: string, provider: string, model: string, extra: Partial<Provider> = {}) =>
  ({ id, provider, model, label: `${id} key`, version: 1, ...extra }) as Provider;
const connections = [
  connection('mimo-a', 'mimo', 'mimo-v2.6-flash'),
  connection('codex-a', 'codex', 'gpt-5.6-luna', { label: 'Personal testing' }),
  connection('codex-b', 'codex', 'gpt-5.6-luna', { label: 'Team billing' }),
  connection('claude-a', 'claude', 'claude-sonnet-5-5'),
  connection('claude-alias', 'claude', 'claude-opus-5-5', {
    alias_source: { connection: 'claude-a', version: 1 },
  }),
  connection('mimo-token', 'mimo', 'mimo-v2.6-pro', {
    routing: { plan: 'token_plan', region: 'sgp' },
  }),
  connection('zai-a', 'zai', 'glm-5.3'),
];

function group(provider: string) {
  const found = groupConnections(connections).find((item) => item.provider === provider);
  if (!found) throw new Error(`No ${provider} group`);
  return found;
}

describe('provider connection groups', () => {
  it('groups by provider and billing route in a fixed provider order without dropping rows', () => {
    const groups = groupConnections(connections);
    expect(groups.map((group) => group.provider)).toEqual([
      'claude',
      'codex',
      'zai',
      'mimo',
      'mimo',
    ]);
    expect(groups.flatMap((group) => group.rows.map((row) => row.connection.id)).sort()).toEqual(
      connections.map((item) => item.id).sort(),
    );
    expect(groups.find((group) => group.provider === 'zai')?.route).toBe('Coding Plan');
    expect(groups.find((group) => group.provider === 'claude')?.route).toBe('API credits');
    expect(groups.filter((group) => group.provider === 'mimo').map((group) => group.route)).toEqual(
      ['API credits', 'Token Plan · Singapore'],
    );
  });

  it('adds models from keyed connections only and disables editing aliases', () => {
    const claude = group('claude');
    expect(claude.keySources.map((source) => source.id)).toEqual(['claude-a']);
    expect(claude.rows.map((row) => row.canEdit)).toEqual([true, false]);
  });

  it('distinguishes the same model name in one provider and names row actions after it', () => {
    const codex = group('codex');
    expect(codex.rows.map((row) => row.hint)).toEqual(['Personal testing', 'Team billing']);
    expect(rowActionName('Delete', codex.rows[0])).toBe('Delete GPT-5.6 Luna (Personal testing)');
    const claude = group('claude');
    expect(claude.rows[0].hint).toBeUndefined();
    expect(rowActionName('Edit', claude.rows[0])).toBe('Edit Claude Sonnet 5.5');
    const same = groupConnections([
      connection('x1', 'zai', 'glm-5.3', { label: 'Same' }),
      connection('x2', 'zai', 'glm-5.3', { label: 'Same' }),
    ])[0];
    expect(new Set(same.rows.map((row) => row.hint)).size).toBe(2);
    const alias = groupConnections([
      connection('k', 'claude', 'claude-sonnet-5-5', { label: 'Personal' }),
      connection('a', 'claude', 'claude-sonnet-5-5', {
        label: 'Personal',
        alias_source: { connection: 'k', version: 1 },
      }),
    ])[0];
    expect(alias.rows.map((row) => row.hint)).toEqual([
      'Personal · saved key',
      'Personal · added model',
    ]);
  });

  it('renders one Add model per provider, a key menu for several keys and a reserved edit slot', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderGroupList, {
        groups: groupConnections(connections),
        busy: false,
        slot: () => null,
        onAddModel: () => {},
        onEdit: () => {},
        onDelete: () => {},
      }),
    );
    expect(html.match(/aria-label="Add model to /g)).toHaveLength(5);
    expect(html).toContain('<details class="provider-add-menu">');
    expect(html).toContain('>Personal testing</button>');
    expect(html).toContain('aria-label="Edit Claude Sonnet 5.5"');
    expect(html).not.toContain('aria-label="Edit Claude Opus 5.5"');
    expect(html).toContain('aria-label="Delete Claude Opus 5.5"');
    expect(html.match(/class="provider-row-slot"/g)).toHaveLength(1);
    expect(html).toContain('API credits · 2 models');
  });
});
