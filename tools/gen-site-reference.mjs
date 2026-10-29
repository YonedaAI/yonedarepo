// Regenerates the site's generated reference docs from their sources:
// - frontend/src/content/docs/reference/cli.md, wholly, from the CLI's usage text
//   (backend/crates/yoneda-cli/src/command/usage.rs);
// - the "MCP tools" table at the end of frontend/src/content/docs/reference/api.md, from
//   backend/crates/yoneda-core/src/platform_tools.json (the REST tables above it are written
//   by hand).
// Run `node tools/gen-site-reference.mjs` after changing either source; the site tests
// (frontend/src/features/site/site.test.ts) fail until the docs match.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const write = (path, text) => writeFileSync(new URL(path, root), text);

const SECTIONS = [
  ['account', 'Account'],
  ['organizations', 'Organizations'],
  ['repository', 'Repository'],
  ['declared reads', 'Declared reads'],
  ['offline checkouts', 'Offline checkouts'],
];

function cliReference() {
  const usage = /USAGE: &str = "\\\n([\s\S]*?)";/.exec(read('backend/crates/yoneda-cli/src/command/usage.rs'))?.[1];
  if (!usage) throw new Error('USAGE not found in usage.rs');
  const out = [
    '---',
    'title: CLI commands',
    'summary: Every yoneda command, as `yoneda` prints it with no arguments.',
    '---',
    '',
    "Run `yoneda` with no arguments to print this list. Repository commands use the current clone's `yoneda::` remote, or `--repo <id> [--origin <url>]`.",
    '',
  ];
  // The first block is the `usage:` line; each later block is one section.
  for (const block of usage.split('\n\n').slice(1)) {
    const heading = SECTIONS.find(([prefix]) => block.startsWith(prefix))?.[1] ?? 'Git';
    out.push(`## ${heading}`, '', '```text', block, '```', '');
  }
  return out.join('\n');
}

const TABLE_HEAD = '| Tool | What it does |';

function apiReference() {
  const current = read('frontend/src/content/docs/reference/api.md');
  const at = current.indexOf(TABLE_HEAD);
  if (at < 0) throw new Error(`api.md has no "${TABLE_HEAD}" table to replace`);
  const tools = JSON.parse(read('backend/crates/yoneda-core/src/platform_tools.json'));
  const cell = (text) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = tools.map((t) => `| \`${t.name}\` | ${cell(t.description)} |`);
  return `${current.slice(0, at)}${TABLE_HEAD}\n|---|---|\n${rows.join('\n')}\n`;
}

write('frontend/src/content/docs/reference/cli.md', cliReference());
write('frontend/src/content/docs/reference/api.md', apiReference());
console.log('regenerated reference/cli.md and reference/api.md');
