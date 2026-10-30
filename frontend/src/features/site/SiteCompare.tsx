// The home page's comparison with plain Git: bar pairs built only from figures we measured,
// then a few qualitative tiles. Sources: YonedaRepo's 1,000-writer burst
// (tools/fanout-bench, docs/progress.md; writes are never retried); plain Git's side is stock
// Git 2.54 serving a bare repository (`git http-backend` and `git daemon`) to 1,000 clients
// that each push one commit on the same base to the same branch at once, no retries: exactly
// one push was accepted in every run.
import { GitMerge, ScrollText, Terminal } from 'lucide-react';
import { inline } from '../source-platform/markdown';

export type Comparison = {
  id: string;
  question: string;
  ours: { value: number; label: string };
  theirs: { name: string; value: number; label: string };
  note: string;
};

export const COMPARISONS: Comparison[] = [
  {
    id: 'first-try',
    question: '1,000 writers commit to one branch at the same moment. How many land first time?',
    ours: { value: 1000, label: '1,000 of 1,000' },
    theirs: { name: 'Plain Git', value: 1, label: '1 of 1,000' },
    note: 'Plain Git takes the one push that arrives first and rejects the rest as non-fast-forward, so 999 writers fetch, rebase and push again. YonedaRepo merges every commit on the server.',
  },
  // Slot: "clone time vs GitHub" goes here once it is measured (bars are drawn to scale, so
  // say in `question` that shorter is faster).
];

const TILES = [
  {
    icon: GitMerge,
    title: 'Git’s own merge',
    text: 'Merges on the server match Git’s own three-way merge, so the result is the one you expect.',
  },
  {
    icon: ScrollText,
    title: 'Every session on record',
    text: 'Each commit keeps the agent session that wrote it, and what that session read.',
  },
  {
    icon: Terminal,
    title: 'No new client',
    text: 'Stock Git, the `yoneda` CLI or MCP. Agents and people use the same doors.',
  },
];

const width = (value: number, max: number) => `${max > 0 ? (value / max) * 100 : 0}%`;

export function SiteCompare() {
  return (
    <section className="site-section" aria-labelledby="compare-heading">
      <h2 id="compare-heading">One branch. A thousand writers. No retries.</h2>
      <p className="site-lead">
        Plain Git makes concurrent writers take turns. YonedaRepo lands them all on the server.
      </p>
      {COMPARISONS.map((c) => {
        const max = Math.max(c.ours.value, c.theirs.value);
        return (
          <figure key={c.id} className="site-compare" aria-labelledby={`compare-${c.id}`}>
            <figcaption id={`compare-${c.id}`}>{c.question}</figcaption>
            <dl>
              {[
                { name: 'YonedaRepo', ...c.ours, ours: true },
                { ...c.theirs, ours: false },
              ].map((bar) => (
                <div key={bar.name} className={bar.ours ? 'site-bar site-bar-ours' : 'site-bar'}>
                  <dt>{bar.name}</dt>
                  <dd>
                    <span className="site-bar-track" aria-hidden="true">
                      <span className="site-bar-fill" style={{ width: width(bar.value, max) }} />
                    </span>
                    <strong>{bar.label}</strong>
                  </dd>
                </div>
              ))}
            </dl>
            <p>{c.note}</p>
          </figure>
        );
      })}
      <ul className="site-tiles">
        {TILES.map(({ icon: Icon, title, text }) => (
          <li key={title}>
            <Icon size={20} aria-hidden="true" />
            <strong>{title}</strong>
            <span>{inline(text, title)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
