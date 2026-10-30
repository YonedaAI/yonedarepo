// The public home (`/` signed out): hero, the problems YonedaRepo answers, the "Build on
// YonedaRepo" feature tour, the comparison with plain Git and a closing call to action.
import { ArrowRight, Check } from 'lucide-react';
import type { Navigate } from '../shell/useRoute';
import { BUILD_ON } from './buildOn';
import { SiteBuildOn } from './SiteBuildOn';
import { SiteCompare } from './SiteCompare';
import { siteLink } from './SiteLayout';
import { SiteWorksWith } from './SiteWorksWith';

/** The problem rows: the pain (struck through), our answer, and the tour panel that solves it. */
const PROBLEMS: { problem: string; answer: string; panel: string }[] = [
  {
    problem: 'Agents overwriting each other on main',
    answer: 'Every commit lands on the server, in order, first try.',
    panel: 'transactions',
  },
  {
    problem: 'More changes than people can review',
    answer: 'Review agents and required checks clear the routine, so people judge the rest.',
    panel: 'review-agents',
  },
  {
    problem: 'Every session starting cold',
    answer: 'Each session opens with what the last ones did, decided and touched.',
    panel: 'memory',
  },
  {
    problem: 'No record of which session wrote what',
    answer: 'Every commit carries the session that made it.',
    panel: 'memory',
  },
  {
    problem: 'Cloning everything to read three files',
    answer: 'Fetch only the files you open, or search the server without a clone.',
    panel: 'fetch',
  },
];

export function SiteHome({ navigate }: { navigate: Navigate }) {
  const titleOf = new Map(BUILD_ON.map((item) => [item.id, item.title]));
  return (
    <>
      <section className="site-band site-hero" aria-labelledby="hero-heading">
        <h1 id="hero-heading">The Git platform built for agents</h1>
        <p className="site-hero-lead">
          Git-compatible hosting where agents and people commit, review and land on the server.
          Every session’s context stays with the code, and a thousand writers can share one branch.
        </p>
        <div className="site-hero-actions">
          <a
            className="site-button site-button-large"
            {...siteLink({ page: 'signin', mode: 'signup' }, navigate)}
          >
            Get started <ArrowRight size={18} aria-hidden="true" />
          </a>
          <SiteWorksWith />
        </div>
      </section>

      <section className="site-band site-problem-band" aria-labelledby="problems-heading">
        <div className="site-problem-intro">
          <p className="site-eyebrow">The problem</p>
          <h2 id="problems-heading">Git wasn’t built for a thousand writers</h2>
          <p>
            Agents push in parallel, start every session from scratch and produce more changes than
            any team can read. Plain Git makes them queue, retry and guess.
          </p>
        </div>
        <ul className="site-problem-list">
          {PROBLEMS.map((p) => (
            <li key={p.problem}>
              <Check className="site-problem-check" size={18} aria-hidden="true" />
              <div>
                <p className="site-problem">
                  <s>{p.problem}</s>
                </p>
                <p className="site-answer">{p.answer}</p>
              </div>
              <a className="site-chip" href={`#build-${p.panel}`}>
                {titleOf.get(p.panel)}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <SiteBuildOn navigate={navigate} />

      <SiteCompare />

      <section className="site-band site-band-cta" aria-labelledby="cta-heading">
        <h2 id="cta-heading">Give your agents a repository built for them.</h2>
        <p>Free platform. Bring stock Git, the CLI or MCP.</p>
        <a
          className="site-button site-button-large"
          {...siteLink({ page: 'signin', mode: 'signup' }, navigate)}
        >
          Get started free
        </a>
      </section>
    </>
  );
}
