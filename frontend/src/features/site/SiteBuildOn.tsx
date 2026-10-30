// The home page's "Build on YonedaRepo" tour: a sticky list of features on the left and one
// panel per feature on the right. The list follows the panel in view (scroll-spy); choosing
// an item scrolls to its panel, smoothly unless the visitor prefers reduced motion.
import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Navigate } from '../shell/useRoute';
import { inline } from '../source-platform/markdown';
import { BUILD_ON, mockOf, pickActive } from './buildOn';
import { featurePageFor } from './featurePages';
import { siteLink } from './SiteLayout';

const panelId = (id: string) => `build-${id}`;
const ORDER = BUILD_ON.map((item) => item.id);

function useActivePanel() {
  const [active, setActive] = useState(ORDER[0]);
  const visible = useRef(new Set<string>());
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    // A panel counts as in view while it crosses the band 35–45% down the viewport.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.id.slice('build-'.length);
          if (entry.isIntersecting) visible.current.add(id);
          else visible.current.delete(id);
        }
        setActive((current) => pickActive(ORDER, visible.current, current));
      },
      { rootMargin: '-35% 0px -55% 0px' },
    );
    for (const id of ORDER) {
      const panel = document.getElementById(panelId(id));
      if (panel) observer.observe(panel);
    }
    return () => observer.disconnect();
  }, []);
  return [active, setActive] as const;
}

export function SiteBuildOn({ navigate }: { navigate: Navigate }) {
  const [active, setActive] = useActivePanel();

  const jump = (id: string) => {
    const panel = document.getElementById(panelId(id));
    if (!panel) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    panel.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    panel.focus({ preventScroll: true });
    setActive(id);
  };

  return (
    <section className="site-band site-build" aria-labelledby="build-heading">
      <div className="site-build-aside">
        <p className="site-eyebrow">One platform for every writer</p>
        <h2 id="build-heading">Build on YonedaRepo.</h2>
        <nav aria-label="Build on YonedaRepo">
          <ul className="site-build-nav">
            {BUILD_ON.map(({ id, icon: Icon, title, subtitle }) => (
              <li key={id}>
                <a
                  className="site-build-link"
                  href={`#${panelId(id)}`}
                  aria-current={active === id ? 'true' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    jump(id);
                  }}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>
                    <strong>{title}</strong>
                    <small>{subtitle}</small>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <a className="site-more" {...siteLink({ page: 'features' }, navigate)}>
          All features <ArrowRight size={16} aria-hidden="true" />
        </a>
      </div>
      <div className="site-build-panels">
        {BUILD_ON.map((item) => (
          <article
            key={item.id}
            id={panelId(item.id)}
            className="site-build-panel"
            tabIndex={-1}
            aria-labelledby={`${panelId(item.id)}-heading`}
          >
            <div className="site-build-copy">
              <h3 id={`${panelId(item.id)}-heading`} className="site-two-tone">
                {item.lead} <span>{inline(item.more, item.id)}</span>
              </h3>
              <a className="site-more" {...siteLink(featurePageFor(item.id), navigate)}>
                Learn more <span className="sr-only">about {item.title}</span>
                <ArrowRight size={16} aria-hidden="true" />
              </a>
            </div>
            <div className="site-build-visual">{mockOf(item)}</div>
          </article>
        ))}
      </div>
    </section>
  );
}
