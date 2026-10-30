// The docs' navigation: tabs (Documentation, Agents, CLI Reference, API), each with titled
// groups of pages; a page may have sub-pages, which fold under it in the sidebar. Every docs
// file appears exactly once (tested); the reading order (prev/next) follows this list.

export type DocsEntry = { slug: string; children?: string[] };
export type DocsGroup = { title: string; entries: DocsEntry[] };
export type DocsTab = { id: string; label: string; groups: DocsGroup[] };

export const DOCS_TABS: DocsTab[] = [
  {
    id: 'documentation',
    label: 'Documentation',
    groups: [
      {
        title: 'Get started',
        entries: [{ slug: 'introduction' }, { slug: 'get-started' }, { slug: 'accounts' }],
      },
      {
        title: 'Git',
        entries: [
          { slug: 'guides/git-remotes', children: ['guides/yoneda-remotes', 'guides/lfs'] },
          { slug: 'guides/pushing' },
        ],
      },
      {
        title: 'Collaborate',
        entries: [
          { slug: 'guides/changes', children: ['guides/merge-rebase'] },
          { slug: 'guides/releases' },
          { slug: 'guides/search' },
        ],
      },
      {
        title: 'Repositories and access',
        entries: [
          { slug: 'guides/repositories', children: ['guides/forks', 'guides/import'] },
          { slug: 'guides/organizations' },
          { slug: 'guides/tokens' },
        ],
      },
      {
        title: 'Security',
        entries: [
          { slug: 'security', children: ['guides/quarantine', 'guides/break-glass'] },
          { slug: 'guides/global' },
        ],
      },
    ],
  },
  {
    id: 'agents',
    label: 'Agents',
    groups: [
      { title: 'Connect', entries: [{ slug: 'agents/connect' }, { slug: 'guides/mcp' }] },
      {
        title: 'Memory and context',
        entries: [{ slug: 'guides/sessions' }, { slug: 'agents/memories' }],
      },
      {
        title: 'Review agents',
        entries: [{ slug: 'agents/review-agents', children: ['agents/review-credit'] }],
      },
    ],
  },
  {
    id: 'cli',
    label: 'CLI Reference',
    groups: [{ title: 'CLI', entries: [{ slug: 'guides/cli' }, { slug: 'reference/cli' }] }],
  },
  {
    id: 'api',
    label: 'API',
    groups: [
      { title: 'REST and MCP', entries: [{ slug: 'reference/api' }] },
      { title: 'Events', entries: [{ slug: 'guides/webhooks' }] },
    ],
  },
];

/** Every page in reading order: tab by tab, group by group, each page before its sub-pages. */
export const DOCS_ORDER: string[] = DOCS_TABS.flatMap((tab) =>
  tab.groups.flatMap((group) =>
    group.entries.flatMap((entry) => [entry.slug, ...(entry.children ?? [])]),
  ),
);

/** The tab and group a page sits in, or undefined for an unknown page. */
export function locate(slug: string): { tab: DocsTab; group: DocsGroup } | undefined {
  for (const tab of DOCS_TABS)
    for (const group of tab.groups)
      if (group.entries.some((e) => e.slug === slug || e.children?.includes(slug)))
        return { tab, group };
  return undefined;
}

/** The pages before and after one in reading order. */
export function neighbors(slug: string): { prev?: string; next?: string } {
  const at = DOCS_ORDER.indexOf(slug);
  if (at < 0) return {};
  return { prev: DOCS_ORDER[at - 1], next: DOCS_ORDER[at + 1] };
}
