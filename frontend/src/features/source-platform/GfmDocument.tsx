// GitHub Flavored Markdown, from text a stranger wrote to React elements, never to an HTML string,
// so nothing here can run. The parser, the raw HTML pass and the sanitizer load with this chunk
// alone; `RichMarkdown` is the way in. Every URL goes through the same rule as the small reader:
// http(s) and mailto are live, an in-page `#` link stays in the page, and any other link keeps
// its words. An image is the page's to show (`image`), or its words in a chip: an outside image is
// never loaded, as that would tell a third party who reads the repository.
import GithubSlugger from 'github-slugger';
import type { Element, ElementContent, Root } from 'hast';
import { toJsxRuntime } from 'hast-util-to-jsx-runtime';
import type { Root as Mdast, Paragraph } from 'mdast';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { SCHEMA } from './gfmSchema';
import type { ImageResolver } from './markdown';

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/;
const TITLES: Record<string, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
};
const SAFE_LINK = /^(https?:|mailto:)/i;
/** Ids this reader makes, so a link to one needs no prefix. */
const OWN_ID = /^#(md-|user-content-)/;

/** `> [!NOTE]` as GitHub reads it: a blockquote whose first words name the kind. */
function alerts() {
  return (tree: Mdast) => {
    visit(tree, 'blockquote', (quote) => {
      const first = quote.children[0];
      if (first?.type !== 'paragraph') return;
      const text = first.children[0];
      const kind = text?.type === 'text' ? ALERT.exec(text.value) : null;
      if (!kind || text?.type !== 'text') return;
      text.value = text.value.slice(kind[0].length);
      if (!text.value) first.children.shift();
      if (first.children[0]?.type === 'break') first.children.shift();
      if (first.children.length === 0) quote.children.shift();
      const title: Paragraph = {
        type: 'paragraph',
        data: { hProperties: { className: ['md-alert-title'] } },
        children: [{ type: 'text', value: TITLES[kind[1]] }],
      };
      quote.children.unshift(title);
      quote.data = {
        hName: 'div',
        hProperties: { className: ['md-alert', `md-alert-${kind[1].toLowerCase()}`] },
      };
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(alerts)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, SCHEMA);

const textOf = (node: ElementContent | Root): string =>
  node.type === 'text'
    ? node.value
    : 'children' in node
      ? node.children.map((c) => textOf(c as ElementContent)).join('')
      : '';

/** Headings moved under the page's own, each with GitHub's slug and a link to itself. */
function placeHeadings(tree: Root, shift: number, anchors: boolean) {
  const slugs = new GithubSlugger();
  visit(tree, 'element', (node: Element) => {
    const level = /^h([1-6])$/.exec(node.tagName);
    if (!level || node.properties.className) return;
    node.tagName = `h${Math.min(Number(level[1]) + shift, 6)}`;
    if (!anchors) return;
    const id = `md-${slugs.slug(textOf(node))}`;
    node.properties.id = id;
    node.children.push({
      type: 'element',
      tagName: 'a',
      properties: { href: `#${id}`, className: ['md-anchor'], ariaLabel: 'Link to this heading' },
      children: [{ type: 'text', value: '#' }],
    });
  });
}

type Part = { text: string; className: string };

/** A fenced block, plain at once, in the viewer's colors as soon as its grammar has loaded. */
function CodeFence({ lang, text }: { lang: string; text: string }) {
  const [parts, setParts] = useState<Part[] | null>(null);
  useEffect(() => {
    if (!lang) return;
    let current = true;
    import('./fenceColors')
      .then(({ fenceSegments }) => fenceSegments(lang, text))
      .then((colored) => {
        if (current) setParts(colored);
      })
      .catch(() => {}); // A grammar that fails to load leaves plain text.
    return () => {
      current = false;
    };
  }, [lang, text]);
  return (
    <pre className="md-code">
      <code>
        {parts
          ? parts.map((part, at) =>
              part.className ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional runs of one text.
                <span key={at} className={part.className}>
                  {part.text}
                </span>
              ) : (
                part.text
              ),
            )
          : text}
      </code>
    </pre>
  );
}

function Fence({ node }: { node?: Element }) {
  const code = node?.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code',
  );
  const names = (code?.properties.className ?? []) as string[];
  const lang = names.find((n) => n.startsWith('language-'))?.slice('language-'.length) ?? '';
  return <CodeFence lang={lang} text={textOf(code ?? (node as Element)).replace(/\n$/, '')} />;
}

function Anchor({
  href = '',
  children,
  ...rest
}: {
  href?: string;
  children?: ReactNode;
  id?: string;
  className?: string;
  'aria-label'?: string;
  title?: string;
}) {
  if (SAFE_LINK.test(href))
    return (
      <a href={href} title={rest.title} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  if (!href.startsWith('#') || href.length < 2) return <>{children}</>;
  return (
    <a {...rest} href={OWN_ID.test(href) ? href : `#md-${href.slice(1).toLowerCase()}`}>
      {children}
    </a>
  );
}

const Table = ({ children }: { children?: ReactNode }) => (
  <div className="markdown-table">
    <table>{children}</table>
  </div>
);

const Checkbox = ({ checked }: { checked?: boolean }) => (
  <input type="checkbox" checked={Boolean(checked)} disabled readOnly />
);

const ImageResolverContext = createContext<ImageResolver | undefined>(undefined);

/** Stable component identity keeps an unchanged repository image mounted on parent renders. */
function Picture({ src = '', alt = '' }: { src?: string; alt?: string }) {
  const image = useContext(ImageResolverContext);
  const shown = src ? image?.(src, alt, src) : undefined;
  if (shown !== undefined && shown !== null) return <>{shown}</>;
  return alt ? <span className="md-chip">{alt}</span> : null;
}

export function GfmDocument({
  source,
  shift = 1,
  anchors = false,
  image,
}: {
  source: string;
  /** Moves headings down, under the page's own. */
  shift?: number;
  /** Ids and links on headings: one document to a page. */
  anchors?: boolean;
  image?: ImageResolver;
}) {
  const tree = useMemo(() => {
    const parsed = processor.runSync(processor.parse(source)) as Root;
    placeHeadings(parsed, shift, anchors);
    return parsed;
  }, [source, shift, anchors]);
  return (
    <ImageResolverContext.Provider value={image}>
      {toJsxRuntime(tree, {
        Fragment,
        jsx,
        jsxs,
        passNode: true,
        components: { a: Anchor, img: Picture, pre: Fence, table: Table, input: Checkbox },
      })}
    </ImageResolverContext.Provider>
  );
}
