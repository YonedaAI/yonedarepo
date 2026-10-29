// Features (`/features`): every built feature on one page, each with an anchor (`#landing`)
// and a jump list; a feature only partly built says what is coming.
import { useEffect } from 'react';
import type { Navigate } from '../shell/useRoute';
import { inline } from '../source-platform/markdown';
import { FEATURES } from './features';
import { siteLink } from './SiteLayout';

export function SiteFeatures({ navigate }: { navigate: Navigate }) {
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);
  return (
    <article className="site-page">
      <header className="site-page-head">
        <h1>Features</h1>
        <p className="site-lead">
          What the platform does today. Each feature works the same from stock Git, the web app, the
          CLI, the API and MCP.
        </p>
        <nav aria-label="Features on this page">
          <ul className="site-jump">
            {FEATURES.map((f) => (
              <li key={f.id}>
                <a className="site-jump-link" href={`#${f.id}`}>
                  {f.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      {FEATURES.map((f) => (
        <section
          key={f.id}
          id={f.id}
          className="site-feature site-feature-wide"
          aria-labelledby={`${f.id}-heading`}
        >
          <div>
            <h2 id={`${f.id}-heading`}>{f.title}</h2>
            <p className="site-feature-summary">{inline(f.summary, f.id)}</p>
            <ul>
              {f.points.map((point, n) => (
                <li key={point}>{inline(point, `${f.id}${n}`)}</li>
              ))}
            </ul>
            {f.coming && (
              <p className="site-coming">
                <span className="site-badge">Coming</span> {f.coming}
              </p>
            )}
          </div>
          {f.mock}
        </section>
      ))}
      <section className="site-cta" aria-labelledby="features-cta">
        <h2 id="features-cta">Try it on a repository of your own.</h2>
        <p>
          <a
            className="site-button site-button-large"
            {...siteLink({ page: 'signin', mode: 'signup' }, navigate)}
          >
            Get started free
          </a>{' '}
          <a className="site-more" {...siteLink({ page: 'docs', slug: 'get-started' }, navigate)}>
            Read the docs
          </a>
        </p>
      </section>
    </article>
  );
}
