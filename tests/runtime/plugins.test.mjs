// The agent plugins (plugins/): the Claude Code plugin is the source of the skill, and the
// Codex and Gemini copies that `yoneda setup` installs must stay identical to it. Every
// client points at the production account MCP (dev only by an explicit override) and takes
// its token from YONEDA_TOKEN. The public marketplace (served from the site, no Git host
// needed) lists the same plugin.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const json = (path) => JSON.parse(read(path));
const MCP = 'https://api.yonedarepo.com/api/v1/mcp';

test('the Codex skill and Gemini context are the Claude Code skill', () => {
  const skill = read('plugins/yoneda/skills/yoneda/SKILL.md');
  assert.match(skill, /^---\nname: yoneda\ndescription: .+\n---\n/);
  assert.equal(read('plugins/codex/skills/yoneda/SKILL.md'), skill);
  assert.equal(read('plugins/gemini/GEMINI.md'), skill.replace(/^---\n[\s\S]*?\n---\n\n/, ''));
});

test('every client uses the account MCP with the YONEDA_TOKEN bearer', () => {
  const claude = json('plugins/yoneda/.mcp.json').mcpServers.yoneda;
  assert.equal(claude.type, 'http');
  assert.equal(claude.url, `\${YONEDA_MCP_URL:-${MCP}}`);
  assert.equal(claude.headers.Authorization, 'Bearer ${YONEDA_TOKEN}');
  const gemini = json('plugins/gemini/gemini-extension.json');
  assert.equal(gemini.mcpServers.yoneda.httpUrl, MCP);
  assert.equal(gemini.mcpServers.yoneda.headers.Authorization, 'Bearer ${YONEDA_TOKEN}');
  assert.equal(gemini.settings[0].envVar, 'YONEDA_TOKEN');
  const codex = read('plugins/codex/config.toml');
  assert.match(codex, /^\[mcp_servers\.yoneda\]$/m);
  assert.match(codex, new RegExp(`^url = "${MCP}"$`, 'm'));
  assert.match(codex, /^bearer_token_env_var = "YONEDA_TOKEN"$/m);
});

test('the marketplace lists the plugin and the hook runs only the status script', () => {
  const market = json('.claude-plugin/marketplace.json');
  assert.deepEqual(
    market.plugins.map((p) => [p.name, p.source]),
    [['yoneda', './plugins/yoneda']],
  );
  assert.equal(json('plugins/yoneda/.claude-plugin/plugin.json').name, 'yoneda');
  const start = json('plugins/yoneda/hooks/hooks.json').hooks.SessionStart;
  assert.deepEqual(
    start.flatMap((m) => m.hooks.map((h) => h.command)),
    ['sh "${CLAUDE_PLUGIN_ROOT}/hooks/yoneda-status.sh"'],
  );
});

const files = (dir) =>
  readdirSync(new URL(dir, root)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(new URL(path, root)).isDirectory() ? files(path) : [path];
  });

test('no plugin file defaults to the dev platform', () => {
  for (const path of [...files('plugins'), '.claude-plugin/marketplace.json'])
    assert.doesNotMatch(read(path), /dev\.yonedarepo\.com/, path);
});

test('the public marketplace installs the plugin from an archive pinned by sha256', () => {
  const market = json('plugins/public-marketplace.json');
  assert.match(market.name, /^[a-z0-9][a-z0-9._-]*$/);
  assert.notEqual(market.name, json('.claude-plugin/marketplace.json').name);
  assert.equal(market.owner.name, 'YonedaAI');
  const [entry] = market.plugins;
  assert.equal(market.plugins.length, 1);
  assert.equal(entry.name, json('plugins/yoneda/.claude-plugin/plugin.json').name);
  assert.deepEqual(entry.source, {
    source: 'archive',
    url: '{site}/downloads/claude/yoneda-{version}.zip',
    sha256: '{sha256}',
  });
});
