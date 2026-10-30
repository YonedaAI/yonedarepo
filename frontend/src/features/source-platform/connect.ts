// What a person copies to connect git, the yoneda CLI and agents to the platform. The API
// origin comes from the build (VITE_YONEDA_API_ORIGIN, e.g. https://api.dev.yonedarepo.com);
// without it the page's own origin is used, which serves the same API through its proxy.
export const PAT_SCOPES = [
  { scope: 'repo:read', label: 'Read', hint: 'clone, log, grep, blame' },
  { scope: 'repo:write', label: 'Write', hint: 'commits and branches' },
  { scope: 'repo:land', label: 'Land', hint: 'move main' },
  { scope: 'repo:review', label: 'Review', hint: 'approve or reject' },
  { scope: 'repo:admin', label: 'Admin', hint: 'create, delete, tokens, policy' },
] as const;
export type PatScope = (typeof PAT_SCOPES)[number]['scope'];
export const DEFAULT_PAT_SCOPES: PatScope[] = ['repo:read', 'repo:write', 'repo:land'];
export const REPO_TOKEN_SCOPES = ['read', 'write', 'check', 'review', 'land'] as const;
export const EXPIRY_DAYS = [1, 7, 30, 90] as const;
export const DEFAULT_EXPIRY_DAYS = 30;

export function apiOrigin(pageOrigin: string, configured?: string): string {
  const value = configured?.trim();
  return (value || pageOrigin).replace(/\/+$/, '');
}

/** The API origin for this page, from the build's configuration. */
export const currentApiOrigin = () =>
  apiOrigin(window.location.origin, import.meta.env.VITE_YONEDA_API_ORIGIN);

/** `git clone <url> [dir]`: every clone line is a whole command, copied exactly as shown. */
export const gitClone = (url: string, dir?: string) => `git clone ${url}${dir ? ` ${dir}` : ''}`;
/** Stock Git over HTTPS, with a token as the password. */
export const httpsCloneCommand = (origin: string, repo: string, dir?: string) =>
  gitClone(`${origin}/git/${repo}.git`, dir);
/** The yoneda remote helper. */
export const cloneCommand = (origin: string, repo: string, dir?: string) =>
  gitClone(`yoneda::${origin}/${repo}`, dir);
/** Signs the yoneda CLI in once; the remote helper then pulls and pushes with that login. */
export const loginCommand = (origin: string) => `yoneda login --origin ${origin}`;
export const mcpUrl = (origin: string) => `${origin}/api/v1/mcp`;

/** The site beside an API origin, where downloads live: `https://api.x` → `https://x`. */
export const siteOrigin = (origin: string) => origin.replace(/^(https?:\/\/)api\./, '$1');

export const installSteps = (origin: string) =>
  [
    '# installs yoneda and git-remote-yoneda into ~/.local/bin (macOS and Linux)',
    `curl -fsSL ${siteOrigin(origin)}/install.sh | sh`,
    `${loginCommand(origin)}   # approve in the browser; the token is stored with mode 0600`,
  ].join('\n');

/** The public marketplace the site serves (no Git host account needed). */
export const claudePluginSteps = (origin: string) =>
  [
    `/plugin marketplace add ${siteOrigin(origin)}/downloads/claude/marketplace.json`,
    '/plugin install yoneda@yonedarepo',
  ].join('\n');

/** Claude Code `.mcp.json`: the token stays in the environment, never in the file. */
export const claudeMcpJson = (origin: string) =>
  JSON.stringify(
    {
      mcpServers: {
        yoneda: {
          type: 'http',
          url: mcpUrl(origin),
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code expands it from the environment.
          headers: { Authorization: 'Bearer ${YONEDA_TOKEN}' },
        },
      },
    },
    null,
    2,
  );

export const codexToml = (origin: string) =>
  [
    '[mcp_servers.yoneda]',
    `url = "${mcpUrl(origin)}"`,
    'bearer_token_env_var = "YONEDA_TOKEN"',
  ].join('\n');

/** Repository token scopes as stored: a JSON list, a comma list or already a list. */
export function scopeList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // not JSON: a comma-separated list
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A path grant as typed (commas or new lines, a leading `/` dropped), or null for the whole
 * repository. The server validates each entry. */
export function pathList(text: string): string[] | null {
  const entries = text
    .split(/[,\n]/)
    .map((p) => p.trim().replace(/^\/+/, ''))
    .filter(Boolean);
  return entries.length ? [...new Set(entries)] : null;
}

/** RFC 8628 user codes: any case, with or without the dash, shown as XXXX-XXXX. */
export function normalizeUserCode(value: string): string {
  const letters = value
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 8);
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}
export const isUserCode = (value: string) =>
  /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(normalizeUserCode(value));

export const expiresIn = (at: number | null | undefined, now = Date.now()) => {
  if (!at) return 'never';
  const days = Math.ceil((at - now) / 86_400_000);
  if (days <= 0) return 'expired';
  return days === 1 ? 'in 1 day' : `in ${days} days`;
};
