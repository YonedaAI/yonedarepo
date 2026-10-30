// "On this page": the page's H2s and H3s, the section in view marked (scroll-spy). Hidden
// below 1200px by the stylesheet.
import { useEffect, useState } from 'react';
import { inline } from '../../source-platform/markdown';
import type { DocHeading } from './docsHeadings';

export function DocsToc({ headings }: { headings: DocHeading[] }) {
  const [active, setActive] = useState(headings[0]?.id ?? '');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const order = headings.map((h) => h.id);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          entry.isIntersecting ? visible.add(entry.target.id) : visible.delete(entry.target.id);
        // The first heading in the band below the headers; when none is in it, keep the last.
        const first = order.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      // The band: from under the sticky headers to 60% down the window.
      { rootMargin: '-120px 0px -40% 0px' },
    );
    for (const id of order) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [headings]);
  if (!headings.length) return null;
  return (
    <nav className="docs-toc" aria-label="On this page">
      <p className="docs-toc-title">On this page</p>
      <ul>
        {headings.map((h) => (
          <li key={h.id} className={h.level === 3 ? 'docs-toc-sub' : undefined}>
            <a
              className="docs-toc-link"
              href={`#${h.id}`}
              aria-current={h.id === active ? 'location' : undefined}
            >
              {inline(h.text, h.id)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
