// The public home (`/` signed out): hero, the problems YonedaRepo answers, four features with
// mocks, measured proof and a closing call to action.
import { ArrowRight } from 'lucide-react';
import type { Navigate } from '../shell/useRoute';
import { inline } from '../source-platform/markdown';
import { FEATURES } from './features';
import { siteLink } from './SiteLayout';

const PROBLEMS: { problem: string; answer: string; feature: string }[] = [
  {
    problem: 'Ten agents push to main at once, and someone’s work gets overwritten.',
    answer: 'Landing on the server with compare-and-swap refs and declared reads.',
    feature: 'landing',
  },
  {
    problem: 'Agents produce changes faster than people can review them.',
    answer: 'Changes with approvals, container checks and model checks as landing gates.',
    feature: 'changes',
  },
  {
    problem: 'Every new agent session starts cold and repeats the last one’s mistakes.',
    answer: '`yoneda context`: recent sessions, open changes and rules at session start.',
    feature: 'context',
  },
  {
    problem: 'Nobody can tell which session wrote a commit, or what it looked at.',
    answer: 'Session records on each commit, with the files the session read.',
    feature: 'sessions',
  },
  {
    problem: 'Reading three files means cloning the whole repository first.',
    answer: 'Search, blame, history and diffs on the server, at any landed version.',
    feature: 'code',
  },
];

const SHOWCASE = ['git-hosting', 'landing', 'changes', 'context'];

/** Measured on the dev environment; dates and run counts from docs/progress.md and the kit. */
const PROOF: { figure: string; what: string; detail: string }[] = [
  {
    figure: '1,000 / 1,000',
    what: 'concurrent writers landed on one repository',
    detail: '406 lands/s, commit p95 1.05 s (2026-10-27, latest of 4 runs)',
  },
  {
    figure: '0',
    what: 'serializability violations with 200 concurrent writers',
    detail: '6,441–8,001 log entries checked per run, 3 runs (2026-10-27)',
  },
  {
    figure: '193.7 / s',
    what: 'sustained landings on one repository for 60 s',
    detail: '0 refused, p95 3.4 s, one run (2026-10-27)',
  },
  {
    figure: '338–646 ms',
    what: 'commit p95 with 20 repositories × 10 writers',
    detail: 'under 1 s in 6 of 6 runs (2026-10-27)',
  },
  {
    figure: '12 / 12',
    what: 'commits from sandboxed coding agents landed on main',
    detail: '8 then 4 agents in parallel on one repository, each session recorded (2026-10-28)',
  },
  {
    figure: '300',
    what: 'merge cases checked against Git’s own three-way merge',
    detail: 'differential test, identical results',
  },
];

export function SiteHome({ navigate }: { navigate: Navigate }) {
  const byId = new Map(FEATURES.map((f) => [f.id, f]));
  return (
    <>
      <section className="site-hero" aria-labelledby="hero-heading">
        <h1 id="hero-heading">Source control for agents at full speed.</h1>
        <p className="site-lead">
          YonedaRepo is a Git-compatible platform where agents and people commit, review and land on
          the server, and every session’s context stays with the code.
        </p>
        <a
          className="site-button site-button-large"
          {...siteLink({ page: 'signin', mode: 'signup' }, navigate)}
        >
          Get started free <ArrowRight size={18} aria-hidden="true" />
        </a>
      </section>

      <section className="site-section" aria-labelledby="problems-heading">
        <h2 id="problems-heading">What breaks when agents write the code</h2>
        <ul className="site-problems">
          {PROBLEMS.map((p) => (
            <li key={p.feature}>
              <p className="site-problem">{p.problem}</p>
              <p className="site-answer">{inline(p.answer, p.feature)}</p>
              <a
                className="site-tag"
                href={`/features#${p.feature}`}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
                    return;
                  event.preventDefault();
                  navigate({ view: 'site', site: { page: 'features' } });
                  // The features page scrolls to the hash when it mounts.
                  window.history.replaceState(null, '', `/features#${p.feature}`);
                }}
              >
                {byId.get(p.feature)?.title}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section className="site-section" aria-labelledby="features-heading">
        <h2 id="features-heading">Built for many writers</h2>
        <div className="site-showcase">
          {SHOWCASE.map((id) => {
            const feature = byId.get(id);
            if (!feature) return null;
            return (
              <article key={id} className="site-feature">
                <div>
                  <h3>{feature.title}</h3>
                  <p>{inline(feature.summary, id)}</p>
                </div>
                {feature.mock}
              </article>
            );
          })}
        </div>
        <p>
          <a className="site-more" {...siteLink({ page: 'features' }, navigate)}>
            All features <ArrowRight size={16} aria-hidden="true" />
          </a>
        </p>
      </section>

      <section className="site-section" aria-labelledby="proof-heading">
        <h2 id="proof-heading">Measured, not promised</h2>
        <ul className="site-proof">
          {PROOF.map((p) => (
            <li key={p.what}>
              <strong>{p.figure}</strong>
              <span>{p.what}</span>
              <small>{p.detail}</small>
            </li>
          ))}
        </ul>
        <p className="site-footnote">
          Measured on our development environment. Not yet shown: monorepo-scale history, and Git
          clones see a landing after a delay (p95 4.9 s at 1,000 writers).{' '}
          <a {...siteLink({ page: 'post', slug: 'real-agents-in-a-sandbox' }, navigate)}>
            How we test
          </a>
        </p>
      </section>

      <section className="site-cta" aria-labelledby="cta-heading">
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
