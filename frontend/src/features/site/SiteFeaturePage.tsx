// One feature's page (`/features/<slug>`), fed by FEATURE_PAGES: a hero with the feature's
// name, headline and nav subtitle beside its mock (under it on a phone); how it works; and
// related features.
import { ArrowRight } from 'lucide-react';
import type { Navigate } from '../shell/useRoute';
import { inline } from '../source-platform/markdown';
import { mockOf } from './buildOn';
import { featureItemOf, featurePageAt, featurePageOf } from './featurePages';
import { siteLink } from './siteLinks';

export function SiteFeaturePage({ slug, navigate }: { slug: string; navigate: Navigate }) {
  const page = featurePageAt(slug);
  const item = page && featureItemOf(page);
  if (!page || !item)
    return (
      <section className="site-band site-feature-hero" aria-labelledby="feature-heading">
        <div className="site-feature-copy">
          <h1 id="feature-heading">Feature not found</h1>
          <p className="site-hero-lead">
            There is no feature at this address.{' '}
            <a {...siteLink({ page: 'features' }, navigate)}>See all features</a>.
          </p>
        </div>
      </section>
    );
  const related = page.related.flatMap((id) => {
    const other = featurePageOf(id);
    const otherItem = other && featureItemOf(other);
    return other && otherItem ? [{ page: other, item: otherItem }] : [];
  });
  return (
    <>
      <section className="site-band site-feature-hero" aria-labelledby="feature-heading">
        <div className="site-feature-copy">
          <p className="site-eyebrow">{item.title}</p>
          <h1 id="feature-heading">{page.headline}</h1>
          <p className="site-hero-lead">{item.subtitle}</p>
          <div className="site-hero-actions">
            <a
              className="site-button site-button-large"
              {...siteLink({ page: 'signin', mode: 'signup' }, navigate)}
            >
              Get started <ArrowRight size={18} aria-hidden="true" />
            </a>
            <a className="site-more" {...siteLink({ page: 'docs', slug: page.docs }, navigate)}>
              Read the docs <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
        </div>
        <div className="site-feature-visual">
          {mockOf(item)}
          {page.stat && (
            <p className="site-feature-stat">
              <strong>{page.stat.value}</strong> {page.stat.label}. <span>{page.stat.versus}.</span>
            </p>
          )}
        </div>
      </section>

      <section className="site-band site-band-flush" aria-labelledby="feature-how">
        <h2 id="feature-how" className="site-band-head">
          How it works
        </h2>
        <ul className="site-cells site-tiles site-feature-blocks">
          {page.blocks.map((block) => (
            <li key={block.title}>
              <strong>{block.title}</strong>
              <span>{inline(block.text, block.title)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="site-band site-band-flush" aria-labelledby="feature-related">
        <h2 id="feature-related" className="site-band-head">
          Related features
        </h2>
        <ul className="site-cells site-tiles site-feature-related">
          {related.map(({ page: other, item: otherItem }) => {
            const Icon = otherItem.icon;
            return (
              <li key={other.slug}>
                <a
                  className="site-feature-link"
                  {...siteLink({ page: 'feature', slug: other.slug }, navigate)}
                >
                  <span className="site-menu-icon" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <strong>{otherItem.title}</strong>
                  <span>{otherItem.subtitle}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
