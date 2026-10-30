// "Build on YonedaRepo": the home page's feature tour, one panel per shipped capability, in
// the order and with the nav subtitles the owner set. A panel links to its `/features` entry and shows that entry's
// mock unless it has its own (buildOnMocks.tsx).
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Brain,
  CloudDownload,
  FlaskConical,
  Globe,
  ListOrdered,
  Search,
  Server,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { MANAGED_AGENTS } from '../../../../shared/managed-agents';
import { ciMock, fetchMock, globalMock, logMock, memoryMock, reviewMock } from './buildOnMocks';
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
    subtitle: 'Every commit lands, first try',
    lead: 'A thousand agents can ship to main at the same moment, and every commit lands.',
    more: 'No push races, no retry loops. The server lands each commit as a transaction, in order, so nobody’s work is overwritten.',
    feature: 'landing',
    mock: logMock,
  },
  {
    id: 'global',
    icon: Globe,
    title: 'Global by default',
    subtitle: 'One network, no regions to pick',
    lead: 'Global from your first commit.',
    more: 'YonedaRepo runs on a global network, with no region to choose and no mirrors to set up. Every account gets it, on every plan.',
    mock: globalMock,
  },
  {
    id: 'git-hosting',
    icon: Server,
    title: 'Git hosting',
    subtitle: 'Stock Git, nothing new to learn',
    lead: 'Bring the Git you already use.',
    more: 'Push and clone over HTTPS or SSH with LFS, organize repositories, forks and organizations, and drive it all from the `yoneda` CLI or MCP.',
    feature: 'git-hosting',
  },
  {
    id: 'fetch',
    icon: CloudDownload,
    title: 'Fetch only what you need',
    subtitle: 'Clone in seconds, load files on demand',
    lead: 'Clones that start small and stay that way.',
    more: 'A `yoneda` clone brings commits and trees right away, and each file arrives the first time Git needs it. Want everything up front? Add `--full`.',
    feature: 'git-hosting',
    mock: fetchMock,
  },
  {
    id: 'changes',
    icon: ShieldCheck,
    title: 'Changes & gates',
    subtitle: 'Ship when every gate is green',
    lead: 'Nothing reaches main until it has earned it.',
    more: 'Review a change line by line, collect approvals on its latest commit, and land the moment every required gate passes.',
    feature: 'changes',
  },
  {
    id: 'ci',
    icon: FlaskConical,
    title: 'Continuous integration',
    subtitle: 'Checks that keep pace with agents',
    lead: 'Every push gets tested.',
    more: 'Your checks run in a fresh container on the exact commit, and required checks hold the landing until they pass. Model checks grade a diff against your own rubric.',
    feature: 'changes',
    mock: ciMock,
  },
  {
    id: 'review-agents',
    icon: Bot,
    title: 'Review agents',
    subtitle: 'Code, security and slop review on tap',
    lead: 'Reviewers that read every change, so your people read the ones that matter.',
    more: `${agentList} leave line comments on the change and record a check you can require, billed per use from your credit.`,
    mock: reviewMock,
  },
  {
    id: 'memory',
    icon: Brain,
    title: 'Continuous Memory',
    subtitle: 'Every agent picks up where the last one left off',
    lead: 'Agents that remember.',
    more: 'Every commit keeps the session that wrote it: what it read and what it said. Each new session opens with `yoneda context`: what the last ones did, the open changes and the rules. No cold starts, no repeated mistakes.',
    feature: 'sessions',
    mock: memoryMock,
  },
  {
    id: 'code',
    icon: Search,
    title: 'Code search',
    subtitle: 'Search, blame and history, no clone',
    lead: 'Answers without a clone.',
    more: 'Search, blame and history on the server, at any version.',
    feature: 'code',
  },
];

/** The panel's visual: its own mock, else its `/features` entry's. */
export const mockOf = (item: BuildOnItem) =>
  item.mock ?? FEATURES.find((f) => f.id === item.feature)?.mock;

/** The first id, in page order, whose panel is in view; the current one when none is. */
export function pickActive(order: string[], visible: ReadonlySet<string>, current: string) {
  return order.find((id) => visible.has(id)) ?? current;
}
