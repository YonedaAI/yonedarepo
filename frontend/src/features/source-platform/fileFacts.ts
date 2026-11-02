// How a file is shown, before any editor loads: its size in words, its limits, and which
// language it reads as. Grammars load one at a time, the first time a file needs one.
import type { Extension } from '@codemirror/state';

/** Past this a file is plain text: no grammar, with a way to the raw text. */
export const PLAIN_BYTES = 512 * 1024;

type Grammar = () => Promise<Extension>;

const UNITS = ['bytes', 'KB', 'MB', 'GB'];

/** `2.8 KB`, `512 bytes`. */
export function fileSize(bytes: number) {
  let value = bytes;
  let unit = 0;
  for (; value >= 1024 && unit < UNITS.length - 1; unit++) value /= 1024;
  const shown = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${shown === 1 && unit === 0 ? 'byte' : UNITS[unit]}`;
}

const javascript = (typescript: boolean) => async () =>
  (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript });
const legacy = (load: () => Promise<Parameters<typeof define>[0]>) => async () =>
  define(await load());
const define = async (mode: import('@codemirror/language').StreamParser<unknown>) =>
  (await import('@codemirror/language')).StreamLanguage.define(mode);

const GRAMMARS: Record<string, Grammar> = {
  javascript: javascript(false),
  typescript: javascript(true),
  python: async () => (await import('@codemirror/lang-python')).python(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  go: async () => (await import('@codemirror/lang-go')).go(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  markdown: async () => (await import('@codemirror/lang-markdown')).markdown(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  shell: legacy(async () => (await import('@codemirror/legacy-modes/mode/shell')).shell),
  toml: legacy(async () => (await import('@codemirror/legacy-modes/mode/toml')).toml),
};

const BY_EXTENSION = new Map<string, keyof typeof GRAMMARS>(
  Object.entries({
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    py: 'python',
    pyi: 'python',
    rs: 'rust',
    go: 'go',
    json: 'json',
    jsonc: 'json',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    html: 'html',
    htm: 'html',
    svg: 'html',
    xml: 'html',
    css: 'css',
    scss: 'css',
    yml: 'yaml',
    yaml: 'yaml',
    c: 'cpp',
    h: 'cpp',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    java: 'java',
    kt: 'java',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    toml: 'toml',
  }),
);

/** The language a path reads as, or null for plain text. */
export function languageOf(path: string): string | null {
  const name = path.split('/').pop() ?? '';
  if (/^(\.bashrc|\.zshrc|\.profile)$/.test(name)) return 'shell';
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  return (extension && BY_EXTENSION.get(extension)) || null;
}

const FENCES = new Map(
  Object.entries({
    javascript: 'js',
    typescript: 'ts',
    python: 'py',
    python3: 'py',
    rust: 'rs',
    golang: 'go',
    'c++': 'cpp',
    shell: 'sh',
    console: 'sh',
    shellsession: 'sh',
  }),
);

/** The extension a fence's language stands for, or null when no grammar reads it. */
export function fenceExtension(lang: string) {
  const name = lang.toLowerCase();
  const extension = FENCES.get(name) ?? name;
  return BY_EXTENSION.has(extension) ? extension : null;
}

/** The grammar of `path`, loaded, or null for plain text and files past the limit. */
export async function grammarOf(path: string, size: number): Promise<Extension | null> {
  const language = languageOf(path);
  if (!language || size > PLAIN_BYTES) return null;
  return GRAMMARS[language]();
}

/** A file's raw text in a tab of its own. As `text/plain`, nothing in it runs. */
export function showRaw(content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
