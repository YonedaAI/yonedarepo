// The public home (`/` signed out): hero, the problems YonedaRepo answers, the "Build on
// YonedaRepo" feature tour, the comparison with plain Git and a closing call to action.
import { ArrowRight } from 'lucide-react';
import type { Navigate } from '../shell/useRoute';
import { inline } from '../source-platform/markdown';
import { heroMock } from './buildOnMocks';
import { FEATURES } from './features';
import { SiteBuildOn } from './SiteBuildOn';
import { SiteCompare } from './SiteCompare';
import { featureLink, siteLink } from './SiteLayout';

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

export function SiteHome({ navigate }: { navigate: Navigate }) {
  const byId = new Map(FEATURES.map((f) => [f.id, f]));
  return (
    <>
      <section className="site-band site-hero" aria-labelledby="hero-heading">
        <div className="site-hero-copy">
          <h1 id="hero-heading" className="site-two-tone">
            Source control for agents at full speed.{' '}
            <span>
              A Git-compatible platform where agents and people commit, review and land on the
              server.
            </span>
          </h1>
          <a
            className="site-button site-button-large"
            {...siteLink({ page: 'signin', mode: 'signup' }, navigate)}
          >
            Get started free <ArrowRight size={18} aria-hidden="true" />
          </a>
        </div>
        {heroMock}
      </section>

      <section className="site-band site-band-flush" aria-labelledby="problems-heading">
        <h2 id="problems-heading" className="site-band-head">
          What breaks when agents write the code
        </h2>
        <ul className="site-cells site-problems">
          {PROBLEMS.map((p) => (
            <li key={p.feature}>
              <p className="site-problem">{p.problem}</p>
              <p className="site-answer">{inline(p.answer, p.feature)}</p>
              <a className="site-problem-link" {...featureLink(p.feature, navigate)}>
                {byId.get(p.feature)?.title} <ArrowRight size={13} aria-hidden="true" />
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
