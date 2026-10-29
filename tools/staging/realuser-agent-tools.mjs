// Kit item 30.6 (`--agent-tools`, and part of `--realuser` after 30.4): the agent tools a
// person or an agent uses on a real repository, through both the repository MCP (git_* and
// symbol_* tools over /mcp, with a repository token) and the REST API, then in the browser.
// - Contracts: a real function (symbol_get), an authored contract (symbol_contract_record),
//   read back by GET /contracts, GET /contract and `yoneda context` in a clone changing that
//   file; the function changed on a scratch branch (symbol_edit) shows the contract stale.
// - Pins: a scratch commit pinned (git_pin), its branch deleted and a vacuum run by the owner;
//   its objects still read and GET /pins lists it; unpinned (REST) it leaves the list.
// - Bisect: a scratch branch of six commits whose fourth breaks a tiny command check added to
//   the policy for the run (not required, restored after); POST /bisect, polled with
//   git_bisect until found, must name exactly that commit. Check time is recorded. The
//   commits are made before the runner is added (recording a commit queues every runner).
// - Browser: Agents → contracts, pins and bisects (by route; their labels are being renamed)
//   render the rows above.
// Every branch is a `realuser/<ts>-*` scratch branch (deleted by the run's cleanup), the pin
// is released and the policy restored even on failure; the contract record stays (records are
// history; the repository keeps it).
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bisectPlan,
  bisectReport,
  bisectRunner,
  checkSeconds,
  contextContracts,
  contractListed,
  editedSource,
  pickFunction,
  pinListed,
  sourceCandidates,
  subdirectories,
  withoutRunner,
  withRunner,
} from './agent-tools-plan.mjs';
import { agentToolPages } from './browser-agent-flow.mjs';
import { until } from './client.mjs';
import { McpClient } from './mcp-client.mjs';
import { AUTHOR, settledRef } from './realuser-git.mjs';
import { scratch, scratchPrefix, timedSteps } from './realuser-plan.mjs';

const b64 = (text) => Buffer.from(text).toString('base64');
const q = (params) => new URLSearchParams(params).toString();
/** Directories walked looking for a function, and files whose symbols are read. */
const MAX_DIRS = 60;
const MAX_FILES = 25;
const BISECT_COMMITS = 6;
const BREAK_AT = 4;
const BISECT_TIMEOUT_MS = 20 * 60_000;

/** A real function of `repo` at main: the first Rust/TypeScript/JavaScript file (breadth
 * first) whose symbols include a mid-sized function. REST: GET /tree and GET /symbols. */
export async function findFunction(rest, path) {
  const dirs = [''];
  const files = [];
  for (let walked = 0; dirs.length && walked < MAX_DIRS && files.length < MAX_FILES; walked++) {
    const dir = dirs.shift();
    const { entries } = await rest.get(`${path}/tree?${q({ ref: 'main', path: dir })}`);
    files.push(...sourceCandidates(dir, entries));
    dirs.push(...subdirectories(dir, entries));
  }
  for (const file of files.slice(0, MAX_FILES)) {
    const listed = await rest.get(`${path}/symbols?${q({ ref: 'main', path: file })}`);
    const symbol = pickFunction(listed.symbols);
    if (symbol) return { path: file, symbol_path: symbol.symbol_path };
  }
  throw new Error(`no Rust, TypeScript or JavaScript function in ${files.length} source files at main; run on a repository with some (--agent-tools-repo oss-commander)`);
}

export async function realuserAgentTools(ctx, metrics, { headed = false } = {}) {
  const { ws, repo, ts, owner, mint } = ctx;
  const token = await mint('tools', ['read', 'write', 'check'], repo);
  const rest = ctx.tokenSession(token);
  const path = `/repos/${repo}`;
  const mcp = new McpClient(`${ws.api}/api/v1${path}/mcp`, token);
  await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'realuser-kit', version: '1' } });
  const tools = (await mcp.rpc('tools/list', {})).tools.map((t) => t.name);
  for (const name of ['symbol_get', 'symbol_contract_record', 'symbol_edit', 'symbol_contract', 'git_branch', 'git_pin', 'git_bisect'])
    assert.ok(tools.includes(name), `the repository MCP lacks ${name}`);
  const main = (await rest.get(`${path}/refs`)).refs['refs/heads/main'];
  const branch = (name) => scratch(`${scratchPrefix(ts)}${name}`, ts);
  /** Creates (expected null) or moves a scratch branch over MCP, then waits until REST sees it. */
  const setBranch = async (name, commit, expected = null) => {
    await mcp.tool('git_branch', { ref: branch(name), commit, expected });
    assert.equal(await settledRef(owner, repo, `refs/heads/${branch(name)}`, commit, metrics), commit, `${branch(name)} is at ${commit}`);
  };
  const shown = {};
  let pinned = null;
  let policy = null;
  try {
    await timedSteps(metrics, [
      ['contract: a real function (REST tree, symbols; MCP symbol_get)', async () => {
        const found = await findFunction(rest, path);
        const got = await mcp.tool('symbol_get', { path: found.path, symbol: found.symbol_path, ref: 'main' });
        assert.equal(got.handle?.commit, main, 'symbol_get read main');
        Object.assign(shown, { contract: { ...found, handle: got.handle, source: got.source } });
        Object.assign(metrics, { contract_path: found.path, contract_symbol: found.symbol_path });
      }],
      ['contract: recorded (MCP symbol_contract_record)', async () => {
        const contract = { summary: `realuser ${ts}: what ${shown.contract.symbol_path} promises, recorded by the kit.` };
        const recorded = await mcp.tool('symbol_contract_record', { handle: shown.contract.handle, contract });
        assert.equal(recorded.commit, main, 'the record binds to main');
        shown.contract.record = { commit: main, path: shown.contract.path, symbol_path: shown.contract.symbol_path, contract };
      }],
      ['contract: listed and shown (REST GET /contracts, GET /contract)', async () => {
        const listed = await rest.get(`${path}/contracts?limit=50`);
        assert.ok(contractListed(listed.records, shown.contract.record), 'GET /contracts lists the record');
        const read = await rest.get(`${path}/contract?${q({ path: shown.contract.path, symbol: shown.contract.symbol_path, ref: 'main' })}`);
        assert.equal(read.status, 'authored', `the contract at main is ${read.status}`);
        assert.equal(read.contract?.summary, shown.contract.record.contract.summary);
      }],
      ['contract: `yoneda context` in a clone changing the file', async () => {
        const dir = ws.path('tools-context');
        await ws.ok('git', ['clone', '-q', '--filter=blob:none', `${ws.api}/git/${repo}.git`, dir], { token });
        // An uncommitted change to the file: `yoneda context` puts contracts on it first.
        appendFileSync(join(dir, shown.contract.path), '\n');
        const contracts = contextContracts((await ws.ok('yoneda', ['context', '--json'], { cwd: dir, token })).stdout);
        const ours = contracts.find((c) => c.path === shown.contract.path && c.symbol_path === shown.contract.symbol_path);
        assert.ok(ours, `yoneda context names no contract on ${shown.contract.path}`);
        assert.equal(ours.contract?.summary, shown.contract.record.contract.summary);
      }],
      ['contract: the function changed on a scratch branch reads stale (MCP symbol_edit, REST and MCP contract)', async () => {
        await setBranch('contract', main);
        const edited = await mcp.tool('symbol_edit', {
          handle: shown.contract.handle,
          replacement: editedSource(shown.contract.source, ts),
          ref: branch('contract'),
          message: `realuser ${ts}: change ${shown.contract.symbol_path}`,
          author: AUTHOR,
        });
        const head = (await rest.get(`${path}/refs`)).refs[`refs/heads/${branch('contract')}`];
        if (head !== edited.commit) await setBranch('contract', edited.commit, head);
        const read = await rest.get(`${path}/contract?${q({ path: shown.contract.path, symbol: shown.contract.symbol_path, ref: branch('contract') })}`);
        assert.equal(read.status, 'stale', `the contract after the change is ${read.status}`);
        const atMain = await mcp.tool('symbol_contract', { path: shown.contract.path, symbol: shown.contract.symbol_path, ref: 'main' });
        assert.equal(atMain.status, 'authored', 'main still has the authored contract');
        metrics.contract_stale_commit = edited.commit;
      }],
      ['pin: a scratch commit pinned (REST commit, MCP git_branch, MCP git_pin, REST GET /pins)', async () => {
        const file = `.realuser/${ts}-pin.txt`;
        const made = await rest.post(`${path}/commits`, {
          parent: main,
          changes: [{ path: file, content_b64: b64(`kept by a pin, realuser ${ts}\n`) }],
          message: `realuser ${ts}: pinned commit`,
          author: AUTHOR,
        });
        await setBranch('pin', made.commit);
        const reason = `realuser ${ts} pin`;
        const answer = await mcp.tool('git_pin', { commit: made.commit, reason });
        assert.equal(answer.pinned, true);
        pinned = { commit: made.commit, reason, file };
        assert.ok(pinListed((await rest.get(`${path}/pins`)).pins, made.commit, reason), 'GET /pins lists the pin');
        metrics.pinned = made.commit;
      }],
      ['pin: branch deleted, vacuum run, objects still read (REST refs/batch, POST /vacuum, GET /commits, GET /blob)', async () => {
        const deleted = await owner.raw('POST', `${path}/refs/batch`, { updates: [{ ref: `refs/heads/${branch('pin')}`, commit: null, expected: pinned.commit }] });
        assert.ok(deleted.ok, `deleting ${branch('pin')}: ${deleted.status} ${deleted.body?.error?.code ?? ''}`);
        const vacuum = await owner.post(`${path}/vacuum`, {});
        Object.assign(metrics, { vacuum_released: vacuum.released, vacuum_failed: vacuum.failed?.length ?? 0 });
        assert.equal((await rest.get(`${path}/commits/${pinned.commit}`)).commit, pinned.commit, 'the pinned commit reads');
        const blob = await rest.get(`${path}/blob?${q({ commit: pinned.commit, path: pinned.file })}`);
        assert.equal(blob.content, `kept by a pin, realuser ${ts}\n`, 'the pinned file reads back after the vacuum');
        assert.ok(pinListed((await rest.get(`${path}/pins`)).pins, pinned.commit, pinned.reason), 'the pin is still listed');
      }],
      ['bisect: six commits, the fourth breaks (REST commits, MCP git_branch)', async () => {
        const plan = bisectPlan(ts, BISECT_COMMITS, BREAK_AT);
        let parent = main;
        const commits = [];
        for (const step of plan.commits) {
          const made = await rest.post(`${path}/commits`, { parent, changes: [{ path: plan.file, content_b64: b64(step.text) }], message: step.message, author: AUTHOR });
          commits.push(made.commit);
          parent = made.commit;
        }
        await setBranch('bisect', parent);
        shown.bisect = { plan, commits, breaking: commits[plan.breaking] };
        metrics.breaking_commit = shown.bisect.breaking;
      }],
      ['bisect: a check runner for the run (owner PUT /policy)', async () => {
        // Added after the commits: recording a commit queues every runner of the policy.
        const { name, runner } = bisectRunner(shown.bisect.plan);
        policy = { name };
        await owner.call('PUT', `${path}/policy`, { policy: withRunner((await owner.get(path)).policy, name, runner) });
        shown.bisect.name = name;
      }],
      ['bisect: started (REST POST /bisect), polled (MCP git_bisect) until found', async () => {
        const { commits, name } = shown.bisect;
        const started = await rest.post(`${path}/bisect`, { ref: branch('bisect'), good: main, bad: commits.at(-1), check: name });
        const began = performance.now();
        const done = await until(
          async () => {
            const step = await mcp.tool('git_bisect', { id: started.id });
            return step.status === 'running' ? null : step;
          },
          { timeoutMs: BISECT_TIMEOUT_MS, intervalMs: 10_000, what: `bisect ${started.id}` },
        );
        const details = await Promise.all(commits.map((c) => rest.get(`${path}/commits/${c}`)));
        const used = checkSeconds(details, name);
        const report = bisectReport(done, commits, details, name);
        // The whole final record and every check run go to the evidence, pass or fail.
        Object.assign(metrics, { bisect: started.id, bisect_s: Math.round((performance.now() - began) / 1000), check_runs: used.runs, check_minutes: (used.seconds / 60).toFixed(2), bisect_record: report.record, bisect_runs: report.runs });
        assert.equal(done.status, 'found', `bisect ended ${done.status}: ${report.text}`);
        assert.equal(report.first_bad, shown.bisect.breaking, `bisect names exactly the breaking commit: ${report.text}`);
        Object.assign(shown.bisect, { id: started.id });
      }],
      ['browser: Agents → contracts, pins and bisects show the rows', () =>
        agentToolPages(
          {
            origin: ctx.origin,
            cookie: ctx.cookie,
            repo,
            dir: ctx.evidence,
            headed,
            expect: {
              contracts: [`${shown.contract.path} · ${shown.contract.symbol_path}`, shown.contract.record.contract.summary],
              pins: [pinned.commit.slice(0, 10), pinned.reason],
              bisects: [shown.bisect.name, `First bad commit: ${shown.bisect.breaking.slice(0, 10)}`],
            },
          },
          metrics,
        )],
      ['pin: released (REST POST /commits/:sha/pin unpin)', async () => {
        const released = await rest.post(`${path}/commits/${pinned.commit}/pin`, { unpin: true });
        assert.equal(released.pinned, false);
        assert.ok(!(await rest.get(`${path}/pins`)).pins.some((p) => p.commit === pinned.commit), 'the pin is gone from GET /pins');
        pinned = null;
      }],
    ], ws.scrub);
  } finally {
    // The pin and the policy runner never outlive the run, whatever failed.
    if (pinned) await owner.post(`${path}/commits/${pinned.commit}/pin`, { unpin: true }).catch((e) => console.error(`Unpinning ${pinned.commit} failed: ${e.message}`));
    if (policy) {
      const restored = withoutRunner((await owner.get(path)).policy, policy.name);
      await owner.call('PUT', `${path}/policy`, { policy: restored }).catch((e) => console.error(`Restoring the policy failed: ${e.message}`));
      const now = (await owner.get(path)).policy;
      assert.ok(!now.runners?.[policy.name], `the policy still has runner ${policy.name}`);
      metrics.policy_restored = true;
    }
  }
}
