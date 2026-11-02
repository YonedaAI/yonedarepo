// What survives of a Markdown file's raw HTML, and of Markdown itself: an allowlist, so that
// anything not named here goes. No `style`, no `on*`, no `class` a file chooses, no frames, forms
// or scripts. `strip` drops an element with what is inside it; any other unknown element goes and
// leaves its text. URLs keep the same rule as the rest of the site: http(s) and mailto, or
// relative, which only ever reaches the page's own handling (`GfmDocument`).
import type { Options } from 'rehype-sanitize';

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
const TEXT = ['p', 'em', 'strong', 'del', 'code', 'pre', 'blockquote', 'hr', 'br', 'span', 'div'];
const LISTS = ['ul', 'ol', 'li', 'input'];
const TABLES = ['table', 'thead', 'tbody', 'tr', 'th', 'td'];
const RAW_HTML = ['img', 'a', 'details', 'summary', 'kbd', 'sub', 'sup'];

export const SCHEMA: Options = {
  tagNames: [...HEADINGS, ...TEXT, ...LISTS, ...TABLES, ...RAW_HTML, 'section'],
  strip: ['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math'],
  attributes: {
    a: ['href', 'title', 'ariaLabel', ['id', /^user-content-/]],
    img: ['src', 'alt', 'title'],
    code: [['className', /^language-[\w+-]+$/]],
    input: [['type', 'checkbox'], 'checked', 'disabled'],
    details: ['open'],
    th: ['align'],
    td: ['align'],
    ol: ['start'],
    li: [['id', /^user-content-/]],
    // The alert and footnote markup this reader writes itself.
    div: [['className', /^md-alert/]],
    p: [['className', 'md-alert-title']],
    h2: [
      ['className', 'sr-only'],
      ['id', /^user-content-/],
    ],
    section: ['dataFootnotes', ['className', 'footnotes']],
  },
  required: { input: { type: 'checkbox', disabled: true } },
  ancestors: { input: ['li'], li: ['ul', 'ol'], tr: ['table'], summary: ['details'] },
  protocols: {
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
  clobber: [],
  clobberPrefix: '',
};
