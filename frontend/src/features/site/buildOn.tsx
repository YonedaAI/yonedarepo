// "Build on YonedaRepo": the home page's feature tour, one panel per shipped capability. A
// panel with a `/features` entry reuses that entry's mock and links to it; the managed review
// agents (cloudflare/managed, shared/managed-agents.ts) have their own mock here.
import type { LucideIcon } from 'lucide-react';
import {
  Bot,
  Compass,
  GitMerge,
  ScrollText,
  Search,
  Server,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { MANAGED_AGENTS } from '../../../../shared/managed-agents';
import { FEATURES } from './features';

export type BuildOnItem = {
  id: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  /** The panel headline: `lead` in full weight, `more` in muted grey after it. */
  lead: string;
  more: string;
  /** A `/features` entry, linked as "Learn more" and whose mock the panel shows. */
  feature?: string;
  mock?: ReactNode;
};

const agentName = (id: string) => MANAGED_AGENTS.find((a) => a.id === id)?.defaults.name ?? id;
const names = MANAGED_AGENTS.map((a) => a.defaults.name);
const agentList = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

const reviewMock = (
  <figure className="site-mock site-panel" aria-label="Review agents reporting on a change">
    <p className="mock-title">
      <Bot size={16} aria-hidden="true" /> #12 Retry on 503 <span>retry → main</span>
    </p>
    <ul className="mock-rows">
      <li>
        <strong>
          <TriangleAlert size={15} aria-hidden="true" /> {agentName('security-review')} · medium
        </strong>
        <span>
          <code>src/retry.ts:22</code> logs the request’s auth header when a retry fails.
        </span>
      </li>
      <li>
        <strong>{agentName('slop-review')} · low</strong>
        <span>
          <code>src/retry.ts:40</code> leftover <code>console.debug</code>.
        </span>
      </li>
    </ul>
    <ul className="mock-gates mock-checks">
      <li>
        check <code>code-review</code> passed
      </li>
      <li>
        check <code>security-review</code> medium
      </li>
    </ul>
  </figure>
);

export const BUILD_ON: BuildOnItem[] = [
  {
    id: 'git-hosting',
    icon: Server,
    title: 'Git hosting',
    subtitle: 'Stock Git over HTTPS and SSH',
    lead: 'Clone, fetch and push with the Git you already have.',
    more: 'Smart HTTP, SSH keys, partial clones and Git LFS, and every pushed commit kept byte for byte.',
    feature: 'git-hosting',
  },
  {
    id: 'landing',
    icon: GitMerge,
    title: 'Landing',
    subtitle: 'Many writers, one branch',
    lead: 'Every agent lands on main, at the same time.',
    more: 'Commits are made on the server and refs move by compare-and-swap, so parallel work merges instead of bouncing back. A real overlap is refused with its path, never overwritten.',
    feature: 'landing',
  },
  {
    id: 'changes',
    icon: ShieldCheck,
    title: 'Changes and gates',
    subtitle: 'Approvals, container and model checks',
    lead: 'Land only what passed its gates.',
    more: 'Approvals on the head commit, checks in an isolated container on the exact revision, and model checks that grade a diff against your rubric.',
    feature: 'changes',
  },
  {
    id: 'review-agents',
    icon: Bot,
    title: 'Managed review agents',
    subtitle: 'Code, security and slop review',
    lead: 'Reviewers that read every change, so your people read the ones that matter.',
    more: `${agentList} leave line comments on the change and record a check you can require. They run beside the platform as ordinary API clients, billed per use from your credit.`,
    mock: reviewMock,
  },
  {
    id: 'context',
    icon: Compass,
    title: 'Context',
    subtitle: 'A warm start for every session',
    lead: 'New sessions start where the last ones stopped.',
    more: '`yoneda context` hands an agent the recent sessions, open changes and landing rules, in one text that fits its budget.',
    feature: 'context',
  },
  {
    id: 'sessions',
    icon: ScrollText,
    title: 'Sessions',
    subtitle: 'Every commit knows its session',
    lead: 'See which session wrote every commit.',
    more: 'Each commit carries its agent, model and summary, the files the session read and its transcript, with credentials redacted.',
    feature: 'sessions',
  },
  {
    id: 'code',
    icon: Search,
    title: 'Code on the server',
    subtitle: 'Search, blame, history and diffs',
    lead: 'Read the code without cloning it.',
    more: 'Search, blame, history and diffs on the server, at any landed version.',
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
