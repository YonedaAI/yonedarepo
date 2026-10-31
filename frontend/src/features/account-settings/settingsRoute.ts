// The addresses of the account settings pages: `/settings` (General) and `/settings/<section>`.
// Settings was one long page, so its old anchors (`/settings#billing`) and Stripe's old return
// address (`/settings?billing=added`) parse to the page that holds them now, and the shell
// rewrites them (useRoute). `cardAdded` keeps Stripe's flag in the address through that
// rewrite: Billing reads it once the session is known, well after the rewrite.

export const ACCOUNT_SECTION_TITLES = {
  general: 'General',
  billing: 'Billing',
  tokens: 'Tokens',
  'ssh-keys': 'SSH keys',
  organizations: 'Organizations',
} as const;
export type AccountSection = keyof typeof ACCOUNT_SECTION_TITLES;
export const ACCOUNT_SECTIONS = Object.keys(ACCOUNT_SECTION_TITLES) as AccountSection[];

export type SettingsRoute =
  | { view: 'settings'; section: AccountSection; cardAdded?: never }
  /** Back from Stripe (`/settings/billing?billing=added`). */
  | { view: 'settings'; section: 'billing'; cardAdded: true };

const OLD_ANCHORS: Record<string, AccountSection> = {
  billing: 'billing',
  'personal-tokens': 'tokens',
  'ssh-keys': 'ssh-keys',
  organizations: 'organizations',
};

const named = (parts: string[]): AccountSection =>
  parts.length === 1 && Object.hasOwn(ACCOUNT_SECTION_TITLES, parts[0] ?? '')
    ? (parts[0] as AccountSection)
    : 'general';

/** `parts` are the path's segments after `settings`. */
export function parseSettingsPath(
  parts: string[],
  params: URLSearchParams,
  hash: string,
): SettingsRoute {
  const added = params.get('billing') === 'added';
  const anchor = Object.hasOwn(OLD_ANCHORS, hash.slice(1)) ? OLD_ANCHORS[hash.slice(1)] : undefined;
  const section = parts.length ? named(parts) : added ? 'billing' : (anchor ?? 'general');
  if (section === 'billing' && added) return { view: 'settings', section, cardAdded: true };
  return { view: 'settings', section };
}

export function formatSettingsRoute(route: SettingsRoute): string {
  const path = route.section === 'general' ? '/settings' : `/settings/${route.section}`;
  return route.cardAdded ? `${path}?billing=added` : path;
}
