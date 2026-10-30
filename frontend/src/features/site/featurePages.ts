// Each Build-on feature's own page (`/features/<slug>`): its headline, docs page, "how it works"
// blocks and related features. Title, subtitle, icon and mock come from BUILD_ON. Every block
// restates what the docs and the code say the feature does; the only number is the measured
// 1,000-writer burst from the home page's comparison.
import { MANAGED_AGENTS, STARTING_CREDIT_USD } from '../../../../shared/managed-agents';
import { BUILD_ON, type BuildOnItem } from './buildOn';
import { COMPARISONS } from './SiteCompare';
import type { SitePage } from './siteRoute';

export type FeatureBlock = { title: string; text: string };

export type FeaturePage = {
  /** The BUILD_ON item this page is for. */
  id: string;
  slug: string;
  headline: string;
  /** Its docs page slug, for "Read the docs". */
  docs: string;
  blocks: FeatureBlock[];
  /** BUILD_ON ids, shown as "Related features". */
  related: string[];
  /** A measured result, shown under the mock. */
  stat?: { value: string; label: string; versus: string };
};

const [burst] = COMPARISONS;

export const FEATURE_PAGES: FeaturePage[] = [
  {
    id: 'transactions',
    slug: 'code-as-transactions',
    headline: 'Every writer lands on main, in order.',
    docs: 'guides/pushing',
    stat: {
      value: burst.ours.label,
      label: 'writers landed on the first try in our 1,000-writer burst',
      versus: `${burst.theirs.name}: ${burst.theirs.label}`,
    },
    blocks: [
      {
        title: 'Each landing is a transaction',
        text: 'A landing takes the next version in the repository’s transaction log, and refs move by compare-and-swap, so no push overwrites another.',
      },
      {
        title: 'Disjoint edits merge on the server',
        text: 'A push based on an older `main` still lands, merged with Git’s own three-way merge. Git prints `landed with server merge, run git pull`.',
      },
      {
        title: 'Overlaps are refused, never overwritten',
        text: 'A same-line overlap is refused with its path, such as `conflict in src/retry.ts`. Nothing is rebased for you; `yoneda conflicts` lists the paths again.',
      },
      {
        title: 'Stale reads are caught',
        text: 'A push can declare the files it read. If one changed on `main` meanwhile, the push is refused instead of merged blind.',
      },
    ],
    related: ['changes', 'memory', 'git-hosting'],
  },
  {
    id: 'global',
    slug: 'global',
    headline: 'One address for every repository, wherever you work.',
    docs: 'guides/global',
    blocks: [
      {
        title: 'No region to choose',
        text: 'Requests are served from a global network. There is no region setting and no mirror to set up.',
      },
      {
        title: 'One address',
        text: '`api.yonedarepo.com` for HTTPS and the API, `ssh.yonedarepo.com` for SSH, the same from anywhere.',
      },
      {
        title: 'One order of landings',
        text: 'Each repository has a single authority for its transaction log, so every reader sees the same landings in the same order.',
      },
      {
        title: 'Where your data lives',
        text: 'Main storage is in eastern North America, so your data is processed in the United States. The Privacy Policy has the details.',
      },
    ],
    related: ['transactions', 'fetch', 'git-hosting'],
  },
  {
    id: 'git-hosting',
    slug: 'git-hosting',
    headline: 'The Git you already use, hosted.',
    docs: 'guides/git-remotes',
    blocks: [
      {
        title: 'Smart HTTP',
        text: 'Protocol v2 with partial (`--filter=blob:none`) and shallow clones. Public repositories clone with no credentials.',
      },
      {
        title: 'SSH',
        text: 'Ed25519, ECDSA or RSA keys, added with `yoneda ssh-key add`.',
      },
      {
        title: 'Your commits, unchanged',
        text: 'A pushed commit keeps its id: the platform records it byte for byte.',
      },
      {
        title: 'Everything around the code',
        text: 'Forks that propose changes back, organizations with teams, Git LFS, and releases with their assets.',
      },
    ],
    related: ['fetch', 'transactions', 'code'],
  },
  {
    id: 'fetch',
    slug: 'fetch-on-demand',
    headline: 'Clone the history now. Fetch each file when Git needs it.',
    docs: 'guides/yoneda-remotes',
    blocks: [
      {
        title: 'Lazy by default',
        text: '`yoneda clone` brings commits and trees right away; each file’s contents arrive the first time Git needs them.',
      },
      {
        title: 'Sparse when you want less',
        text: '`--sparse <dir,...>` checks out only those directories, and `yoneda sparse --add` widens it later.',
      },
      {
        title: 'Everything when you want it',
        text: '`--full` fetches every object up front, as does `git clone -c yoneda.lazy=false`.',
      },
      {
        title: 'Stock Git works too',
        text: 'A plain `git clone` gets partial (`--filter=blob:none`) and shallow (`--depth`) clones over protocol v2.',
      },
    ],
    related: ['git-hosting', 'code', 'global'],
  },
  {
    id: 'changes',
    slug: 'changes',
    headline: 'Propose, review, and land when every gate is green.',
    docs: 'guides/changes',
    blocks: [
      {
        title: 'A change from a push',
        text: 'Push a branch and open a change with `yoneda change create`, from the web app, the API or MCP. A branch has at most one open change.',
      },
      {
        title: 'Reviews of the head commit',
        text: 'Comment line by line. An approval reviews the head commit, an author can never approve their own, and a new head needs a new approval.',
      },
      {
        title: 'Gates on protected branches',
        text: 'Landing rules name the approvals and checks that `main`, `release` and `release/*` require.',
      },
      {
        title: 'Land, then repair forward',
        text: 'Landings on a busy branch are batched into one merge commit. When a check fails after landing, the platform proposes a repair commit instead of rewriting history.',
      },
    ],
    related: ['ci', 'review-agents', 'transactions'],
  },
  {
    id: 'ci',
    slug: 'continuous-integration',
    headline: 'Every push tested, on the exact commit.',
    docs: 'guides/changes',
    blocks: [
      {
        title: 'Command checks',
        text: 'Your command runs in a fresh container on the exact commit, with Git, Python, Node with TypeScript, and Rust, and no network.',
      },
      {
        title: 'Model checks',
        text: 'One model call grades the commit’s diff and message against your rubric and records a verdict, a score and findings.',
      },
      {
        title: 'Required checks hold the landing',
        text: 'Checks named in the landing rules must pass on a change’s head before it lands.',
      },
      {
        title: 'Run and inspect anywhere',
        text: '`yoneda check run <name>` and `yoneda check status`, or the gates on the change’s page.',
      },
    ],
    related: ['changes', 'review-agents', 'transactions'],
  },
  {
    id: 'review-agents',
    slug: 'review-agents',
    headline: 'Reviewers that read every change.',
    docs: 'agents/review-agents',
    blocks: [
      ...MANAGED_AGENTS.map((a) => ({ title: a.defaults.name, text: a.defaults.description })),
      {
        title: 'A check you can require',
        text: `Each agent runs on every push to an open change and records its check (${MANAGED_AGENTS.map((a) => `\`${a.check}\``).join(', ')}) on the head. Runs are billed per use from your credit; a workspace’s first run adds $${STARTING_CREDIT_USD} of credit.`,
      },
    ],
    related: ['changes', 'ci', 'memory'],
  },
  {
    id: 'memory',
    slug: 'continuous-memory',
    headline: 'Every session starts where the last one stopped.',
    docs: 'guides/sessions',
    blocks: [
      {
        title: 'Each commit keeps its session',
        text: 'The agent CLI, the model, a summary and the session id, with the files the session declared it read.',
      },
      {
        title: 'Transcripts, redacted',
        text: 'Prompts, tool calls and replies, with credentials replaced before storage. Anyone who can read the repository can read them.',
      },
      {
        title: 'Context at the start',
        text: '`yoneda context` prints `main`’s head, the landing rules, recent sessions, open changes and symbol contracts, within a byte budget.',
      },
      {
        title: 'Set up once',
        text: '`yoneda setup` installs hooks for popular coding agents, so each session starts with the context and records itself on its commits.',
      },
    ],
    related: ['transactions', 'code', 'review-agents'],
  },
  {
    id: 'code',
    slug: 'code-search',
    headline: 'Read any repository at any version, without a clone.',
    docs: 'guides/search',
    blocks: [
      {
        title: 'Ranked search',
        text: 'Whole-word matches first, then path matches, then matches inside words. The index is rebuilt only where files changed.',
      },
      {
        title: 'Any landed version',
        text: 'Every landing gets a version. `--at <version>` answers search, log and blame as of that version.',
      },
      {
        title: 'Blame and history',
        text: 'The commit that last changed each line, and each branch’s first-parent history with its landing versions.',
      },
      {
        title: 'Overview and symbols',
        text: 'A generated map of subsystems, their symbols and how they reference each other; symbols read and edited by handle over the API and MCP.',
      },
    ],
    related: ['fetch', 'memory', 'git-hosting'],
  },
];

/** The page for a BUILD_ON item. */
export const featurePageOf = (id: string) => FEATURE_PAGES.find((p) => p.id === id);
/** The BUILD_ON item a page is for. */
export const featureItemOf = (page: FeaturePage): BuildOnItem | undefined =>
  BUILD_ON.find((item) => item.id === page.id);
/** Where a BUILD_ON item links: its own page, else the features overview. */
export function featurePageFor(id: string): SitePage {
  const page = featurePageOf(id);
  return page ? { page: 'feature', slug: page.slug } : { page: 'features' };
}
/** The page at `/features/<slug>`. */
export const featurePageAt = (slug: string) => FEATURE_PAGES.find((p) => p.slug === slug);
