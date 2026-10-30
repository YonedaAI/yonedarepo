// "Build on YonedaRepo": the home page's feature tour, one panel per shipped capability, in
// the order the owner set. A panel links to its `/features` entry and shows that entry's
// mock unless it has its own (buildOnMocks.tsx).
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Compass,
  ListOrdered,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { MANAGED_AGENTS } from '../../../../shared/managed-agents';
import { contextMock, logMock, reviewMock, sessionsMock } from './buildOnMocks';
import { FEATURES } from './features';

export type BuildOnItem = {
  id: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  /** The panel headline: `lead` in full weight, `more` in muted grey after it. */
  lead: string;
  more: string;
  /** A `/features` entry, linked as "Learn more"; its mock shows unless `mock` is set. */
  feature?: string;
  mock?: ReactNode;
};

const names = MANAGED_AGENTS.map((a) => a.defaults.name);
const agentList = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export const BUILD_ON: BuildOnItem[] = [
  {
    id: 'transactions',
    icon: ListOrdered,
    title: 'Code as Transactions',
    subtitle: 'An ordered log, no merge lock',
    lead: 'Every landing is a transaction.',
    more: 'Commits are appended to an ordered log on the server and refs move by compare-and-swap, so 1,000 of 1,000 concurrent writers land on one branch with no merge lock. Blame, search and diffs are derived from what landed.',
    feature: 'landing',
    mock: logMock,
  },
  {
    id: 'git-hosting',
    icon: Server,
    title: 'Git hosting',
    subtitle: 'Stock Git over HTTPS and SSH',
    lead: 'Clone, fetch and push with the Git you already have.',
    more: 'Smart HTTP, SSH keys, partial clones and LFS, and every pushed commit kept byte for byte.',
    feature: 'git-hosting',
  },
  {
    id: 'changes',
    icon: ShieldCheck,
    title: 'Changes & gates',
    subtitle: 'Review, checks, then land',
    lead: 'Land only what passed its gates.',
    more: 'Line-by-line review, approvals on the head commit, checks in an isolated container on the exact revision, and model checks that grade a diff against your rubric.',
    feature: 'changes',
  },
  {
    id: 'review-agents',
    icon: Bot,
    title: 'Review agents',
    subtitle: 'Code, security and slop review',
    lead: 'Reviewers that read every change, so your people read the ones that matter.',
    more: `${agentList} leave line comments on the change and record a check you can require. They run beside the platform as ordinary API clients, billed per use from your credit.`,
    mock: reviewMock,
  },
  {
    id: 'sessions',
    icon: ScrollText,
    title: 'Sessions',
    subtitle: 'Every commit knows its session',
    lead: 'See which session wrote every commit.',
    more: 'Each commit carries the agent session that made it: what it read, what it said and its transcript, with credentials redacted.',
    feature: 'sessions',
    mock: sessionsMock,
  },
  {
    id: 'context',
    icon: Compass,
    title: 'Context',
    subtitle: 'A warm start for every session',
    lead: 'New sessions start where the last ones stopped.',
    more: '`yoneda context` hands an agent the recent sessions, open changes and landing rules, in one text that fits its budget.',
    feature: 'context',
    mock: contextMock,
  },
  {
    id: 'code',
    icon: Search,
    title: 'Code search',
    subtitle: 'Search, blame, history, Overview',
    lead: 'Read the code without cloning it.',
    more: 'Search, blame, history and the Overview map on the server, at any landed version.',
    feature: 'code',
  },
  {
    id: 'teams',
    icon: Users,
    title: 'Teams & tools',
    subtitle: 'Repos, forks, orgs, CLI and MCP',
    lead: 'Everything a team needs around the code.',
    more: 'Repositories, forks and organizations, driven from the web, the `yoneda` CLI or MCP. Agents are ordinary clients, with the same tokens and rules as people.',
    feature: 'repositories',
  },
];

/** The panel's visual: its own mock, else its `/features` entry's. */
export const mockOf = (item: BuildOnItem) =>
  item.mock ?? FEATURES.find((f) => f.id === item.feature)?.mock;

/** The first id, in page order, whose panel is in view; the current one when none is. */
export function pickActive(order: string[], visible: ReadonlySet<string>, current: string) {
  return order.find((id) => visible.has(id)) ?? current;
}
