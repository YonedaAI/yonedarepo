// A docs page's body: the site's Markdown, plus headings with anchor links, code blocks with
// their language and a Copy button, note and warning callouts, and card grids.
import {
  BookOpen,
  Bot,
  Check,
  Copy,
  GitBranch,
  Info,
  KeyRound,
  type LucideIcon,
  ShieldCheck,
  Terminal,
  TriangleAlert,
  UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import {
  type Block,
  blocks,
  inline,
  type LinkResolver,
  renderBlock,
} from '../../source-platform/markdown';
import { CALLOUT, parseCards } from './docsContent';
import { pageHeadings } from './docsHeadings';

const CARD_ICONS: Record<string, LucideIcon> = {
  account: UserPlus,
  git: GitBranch,
  terminal: Terminal,
  agent: Bot,
  review: ShieldCheck,
  key: KeyRound,
  book: BookOpen,
};

const LANGS: Record<string, string> = {
  sh: 'Shell',
  bash: 'Shell',
  shell: 'Shell',
  json: 'JSON',
  toml: 'TOML',
  text: 'Text',
  http: 'HTTP',
  ts: 'TypeScript',
};

/** Copies `text` and says so for two seconds; a blocked clipboard leaves the label as is. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => {},
    );
  };
  return [copied, copy];
}

function CodeBlock({ text, lang }: { text: string; lang: string }) {
  const [copied, copy] = useCopy();
  return (
    <figure className="docs-code">
      <figcaption>
        <span>{LANGS[lang] ?? (lang || 'Code')}</span>
        <button type="button" onClick={() => copy(text)} aria-label="Copy code">
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre>
        <code>{text}</code>
      </pre>
    </figure>
  );
}

function Cards({ text, link }: { text: string; link: LinkResolver }) {
  return (
    <ul className="docs-cards">
      {parseCards(text).map((card) => {
        const Icon = CARD_ICONS[card.icon] ?? BookOpen;
        return (
          <li key={card.href}>
            <a className="docs-card" {...(link(card.href) ?? { href: card.href })}>
              <Icon className="docs-card-icon" size={20} aria-hidden="true" />
              <strong>{card.title}</strong>
              <span>{inline(card.text, card.href)}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function Callout({
  block,
  link,
  k,
}: {
  block: Block & { kind: 'quote' };
  link: LinkResolver;
  k: string;
}) {
  const kind = (CALLOUT.exec(block.text)?.[1] ?? 'note').toLowerCase();
  const warning = kind === 'warning';
  const Icon = warning ? TriangleAlert : Info;
  return (
    <aside className={`docs-callout docs-callout-${warning ? 'warning' : 'note'}`}>
      <Icon className="docs-callout-icon" size={16} aria-hidden="true" />
      <p>
        <strong>{warning ? 'Warning' : kind === 'tip' ? 'Tip' : 'Note'}</strong>{' '}
        {inline(block.text.replace(CALLOUT, ''), k, link)}
      </p>
    </aside>
  );
}

export function DocsBody({ body, link }: { body: string; link: LinkResolver }) {
  const headings = pageHeadings(body);
  let h = 0;
  return (
    <>
      {blocks(body).map((block, n) => {
        // Blocks are positional parts of one immutable document.
        const key = `b${n}`;
        if (block.kind === 'heading') {
          const { id } = headings[h++];
          const Tag = `h${Math.min(block.level, 6)}` as 'h2';
          return (
            <Tag key={key} id={id} className="docs-heading">
              {inline(block.text, key, link)}
              <a className="docs-anchor" href={`#${id}`} aria-label="Link to this section">
                #
              </a>
            </Tag>
          );
        }
        if (block.kind === 'code' && block.lang === 'cards')
          return <Cards key={key} text={block.text} link={link} />;
        if (block.kind === 'code')
          return <CodeBlock key={key} text={block.text} lang={block.lang} />;
        if (block.kind === 'quote' && CALLOUT.test(block.text))
          return <Callout key={key} k={key} block={block} link={link} />;
        return renderBlock(block, key, { shift: 0, link });
      })}
    </>
  );
}
