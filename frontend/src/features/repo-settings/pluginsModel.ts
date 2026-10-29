// Settings → Plugins: what is installed on the repository and what can be added. A plugin
// here is a third-party runtime that works as a client of the platform: installing one makes
// a scoped repository token and a webhook, nothing more. Installed plugins are recognised by
// their token's name and, for a webhook, by its event set. Token names are never reused, so a
// reinstall after an uninstall takes the next free name (`plugin-agenthero-2`).
import { scopeList } from '../source-platform/connect';
import type { RepoToken } from '../source-platform/RepoTokens';
import type { Hook } from './HookParts';

export const AGENTHERO_TOKEN = 'plugin-agenthero';
/** The token the managed agents post with (cloudflare/managed, `token_name`). */
export const MANAGED_TOKEN = 'yoneda-managed-agents';
export const AGENTHERO_SCOPES = ['read', 'review', 'check'] as const;
export const AGENTHERO_EVENTS = ['change', 'branch', 'check'] as const;

export type SuggestedPlugin = { id: 'agenthero'; name: string; summary: string; detail: string };
export const SUGGESTED: SuggestedPlugin[] = [
  {
    id: 'agenthero',
    name: 'AgentHero',
    summary: 'Run multi-agent Apps on repo events',
    detail:
      'AgentHero receives this repository’s change, branch and check events by webhook and works through MCP with a token that can read, review and record checks.',
  },
];

const AGENTHERO_NAME = /^plugin-agenthero(?:-[1-9][0-9]*)?$/;

/** The first AgentHero token name no token (live or revoked) has used. */
export function agentHeroTokenName(tokens: RepoToken[]): string {
  const used = new Set(tokens.map((t) => t.name));
  if (!used.has(AGENTHERO_TOKEN)) return AGENTHERO_TOKEN;
  let n = 2;
  while (used.has(`${AGENTHERO_TOKEN}-${n}`)) n++;
  return `${AGENTHERO_TOKEN}-${n}`;
}

/** The `POST /tokens` body for AgentHero. */
export const agentHeroTokenBody = (tokens: RepoToken[]) => ({
  name: agentHeroTokenName(tokens),
  scopes: [...AGENTHERO_SCOPES],
});

/** The `POST /hooks` body for AgentHero: the whole repository, these events. */
export const agentHeroHookBody = (url: string) => ({
  url: url.trim(),
  events: [...AGENTHERO_EVENTS],
});

/** Only an https URL with a host is accepted (the platform refuses anything else too). */
export function validHookUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username;
  } catch {
    return false;
  }
}

/** The repository's own MCP server, which AgentHero connects to with its token. */
export const repoMcpUrl = (origin: string, repo: string) => `${origin}/api/v1/repos/${repo}/mcp`;

const sameEvents = (events: string[] | null) => {
  if (!events) return false;
  const want = [...AGENTHERO_EVENTS].sort();
  const have = [...new Set(events)].sort();
  return have.length === want.length && have.every((e, i) => e === want[i]);
};

export type InstalledPlugin =
  | { id: 'managed'; name: string; token: RepoToken }
  | { id: 'agenthero'; name: string; token: RepoToken; hook?: Hook };

/** The installed plugins, from the repository's live tokens and its hooks. */
export function installedPlugins(tokens: RepoToken[], hooks: Hook[]): InstalledPlugin[] {
  const live = (match: (name: string) => boolean) =>
    tokens.find((t) => match(t.name) && !t.revoked_at);
  const out: InstalledPlugin[] = [];
  const managed = live((name) => name === MANAGED_TOKEN);
  if (managed) out.push({ id: 'managed', name: 'Managed agents', token: managed });
  const hero = live((name) => AGENTHERO_NAME.test(name));
  if (hero) {
    // The newest hook with AgentHero's event set; the uninstall dialog names its URL.
    const hook = [...hooks]
      .sort((a, b) => b.created_at - a.created_at)
      .find((h) => sameEvents(h.events));
    out.push({ id: 'agenthero', name: 'AgentHero', token: hero, ...(hook ? { hook } : {}) });
  }
  return out;
}

/** Whether a suggested plugin is already installed (its token exists). */
export const isInstalled = (installed: InstalledPlugin[], id: SuggestedPlugin['id']) =>
  installed.some((p) => p.id === id);

/** `read, review, check`. */
export const tokenScopes = (token: RepoToken) => scopeList(token.scopes).join(', ');
