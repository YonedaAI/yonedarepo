#!/usr/bin/env node
// Live test of the managed agents on dev (cloudflare/managed): run by the lead, never by a
// builder. Signs the dev owner in (DEV_OWNER_USERNAME / DEV_OWNER_PASSWORD from the environment
// only; nothing secret is printed), creates a throwaway repository, enables the agents through
// /api/managed exactly as the Agents page does, opens one change seeded with a bug for each agent,
// waits for each run and checks what it left (line comments, the check, the transcript, the
// cost against its cap and the workspace credit), then disables every agent (their token and
// webhook must be gone) and deletes the repository. Every step that spends money says PAID.
// Stops at the first failure, then still disables the agents and cleans up (unless --keep).
//
//   set -a; . ~/.config/yonedarepo/dev-owner.env; set +a
//   node tools/staging/managed-live.mjs [--origin https://dev.yonedarepo.com] [--only code]
//        [--keep] [--pause-test]
//   Recall eval (PAID, one change per round, all seeded files in each):
//   node tools/staging/managed-live.mjs --only security --seed all --repeat 5 --eval
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { b64, Recorder, Session, sleep } from './client.mjs';

const { values } = parseArgs({
  options: {
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    only: { type: 'string' },
    keep: { type: 'boolean', default: false },
    'pause-test': { type: 'boolean', default: false },
    // Recall evaluation: --seed all puts every seeded file in each change, --repeat opens that
    // many changes in a row, and --eval counts a missed seeded problem instead of stopping.
    seed: { type: 'string', default: 'agents' },
    repeat: { type: 'string', default: '1' },
    eval: { type: 'boolean', default: false },
    'timeout-min': { type: 'string', default: '10' },
  },
});

/** Each agent, its cap (must equal what the API reports) and what the seeded change gives it. */
const AGENTS = {
  code: { id: 'code-review', check: 'code-review', cap: 1, valueType: 'pass_fail' },
  security: { id: 'security-review', check: 'security-review', cap: 3, valueType: 'pass_fail' },
  slop: { id: 'slop-review', check: 'slop-review', cap: 0.5, valueType: 'level' },
};
const chosen = values.only ? values.only.split(',').map((s) => s.trim()) : Object.keys(AGENTS);
for (const name of chosen)
  assert.ok(AGENTS[name], `--only takes code, security, slop (got ${name})`);
const REPEAT = Number(values.repeat);
assert.ok(Number.isInteger(REPEAT) && REPEAT >= 1 && REPEAT <= 20, '--repeat takes 1 to 20');
assert.ok(['agents', 'all'].includes(values.seed), '--seed takes agents or all');
/** The seeded file each agent must flag (its anchored comment proves it caught the problem). */
const SEED_FILE = { code: 'src/window.js', security: 'src/users.js', slop: 'src/cart.js' };
const TERMINAL = new Set(['passed', 'findings', 'failed', 'superseded', 'cancelled', 'paused']);
const TIMEOUT_MS = Number(values['timeout-min']) * 60_000;
const author = { name: 'Managed live test', email: 'managed-live@yonedarepo.invalid' };

/** One file per agent, each with the problem that agent exists to catch (all invented code). */
const SEEDED = {
  'src/window.js': [
    '// Returns the last n items of a list.',
    'export function lastN(items, n) {',
    '  const unused = items.length * 2;',
    '  const out = [];',
    '  for (let i = items.length - n; i <= items.length; i++) out.push(items[i]);',
    '  return out;',
    '}',
    '',
  ],
  'src/users.js': [
    '// Looks a user up by the id from the request.',
    'export function findUser(db, request) {',
    "  const sql = 'SELECT * FROM users WHERE id = ' + request.query.id;",
    '  return db.query(sql);',
    '}',
    '',
  ],
  'src/cart.js': [
    'export function total(items) {',
    "  console.log('items', items);",
    '  // TODO: fix this later',
    '  // const old = items.reduce((a, b) => a + b.price, 0);',
    '  return items.reduce((sum, item) => sum + item.price, 0);',
    '}',
    '',
  ],
};

const ts = Date.now();
const rec = new Recorder();
const ctx = { agents: chosen.map((k) => ({ key: k, ...AGENTS[k] })), runs: {} };
const paid = (what) => process.stdout.write(`PAID: ${what}\n`);

async function step(id, title, run) {
  const item = await rec.step(id, title, run);
  if (item.status === 'fail') throw Object.assign(new Error(item.reason), { recorded: true });
  return item;
}

async function main() {
  const { DEV_OWNER_USERNAME: username, DEV_OWNER_PASSWORD: password } = process.env;
  assert.ok(
    username && password,
    'set DEV_OWNER_USERNAME and DEV_OWNER_PASSWORD (set -a; . ~/.config/yonedarepo/dev-owner.env; set +a)',
  );
  const origin = values.origin.replace(/\/$/, '');
  let platform;
  let managed;
  let failed = false;
  try {
    await step('1', `Sign in, create managed-live-${ts} with one file`, async (m) => {
      const login = await new Session(origin).raw('POST', '/api/auth/login', {
        username,
        password,
      });
      assert.equal(
        login.status,
        200,
        `owner sign-in failed: ${login.body?.error?.code ?? login.status}`,
      );
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      platform = new Session(`${origin}/api/v1`, { cookie });
      const name = `managed-live-${ts}`;
      const repo = await platform.post('/repos', {
        name,
        policy: { approvals: 0, required_checks: [] },
        files: [{ path: 'README.md', content_b64: b64('# Managed agents live test\n') }],
        author,
      });
      const listed = (await platform.get('/repos')).repos.find((r) => r.id === repo.id);
      assert.ok(listed, 'the new repository is not listed');
      ctx.repo = { id: repo.id, name };
      ctx.workspace = listed.owner;
      managed = new Session(
        `${origin}/api/managed/workspaces/${encodeURIComponent(ctx.workspace)}`,
        { cookie },
      );
      ctx.creditBefore = (await managed.get('')).credit;
      Object.assign(m, {
        repo: repo.id,
        workspace: ctx.workspace,
        balance_before: ctx.creditBefore.balance_usd,
      });
    });

    for (const agent of ctx.agents)
      await step(
        `2.${agent.key}`,
        `Enable ${agent.id} on the repository (maintained defaults)`,
        async (m) => {
          const state = await managed.call('PUT', `/agents/${agent.id}`, { repos: [ctx.repo.id] });
          assert.deepEqual(state.enabled_repos, [ctx.repo.id], 'enabled_repos');
          assert.deepEqual(state.customized, [], 'a fresh workspace customized nothing');
          assert.equal(state.cost_cap_usd, agent.cap, 'the cost cap the API reports');
          agent.settings = state.settings;
          Object.assign(m, {
            harness: state.settings.harness,
            model: `${state.settings.provider}/${state.settings.model}`,
            cap_usd: state.cost_cap_usd,
          });
        },
      );

    await step('2.c', 'The connection exists: the agents token and the webhook', async (m) => {
      const tokens = (await platform.get(`/repos/${ctx.repo.id}/tokens`)).tokens;
      const token = tokens.find((t) => t.name.startsWith('yoneda-managed-agents') && !t.revoked_at);
      assert.ok(
        token,
        `no live yoneda-managed-agents token: ${tokens.map((t) => t.name).join(', ')}`,
      );
      const scopes = typeof token.scopes === 'string' ? JSON.parse(token.scopes) : token.scopes;
      assert.deepEqual([...scopes].sort(), ['check', 'read', 'review'], 'the agents token scopes');
      const hooks = (await platform.get(`/repos/${ctx.repo.id}/hooks`)).hooks;
      const hook = hooks.find((h) => String(h.url).endsWith(`/hooks/${ctx.repo.id}`));
      assert.ok(hook?.active, `no active managed webhook: ${hooks.map((h) => h.url).join(', ')}`);
      ctx.token = token.name;
      ctx.hook = hook;
      Object.assign(m, {
        token: token.name,
        hook: hook.id,
        hook_url: hook.url,
        events: hook.events.join('+'),
      });
    });

    ctx.recall = Object.fromEntries(
      ctx.agents.map((a) => [a.key, { caught: 0, runs: 0, cost: 0 }]),
    );
    for (let round = 1; round <= REPEAT; round++) {
      const sid = (id) => (REPEAT > 1 ? `${id}.r${round}` : id);
      const branch = REPEAT > 1 ? `managed-live-${round}` : 'managed-live';
      ctx.creditRound = (await managed.get('')).credit;
      await step(sid('3'), 'PAID: open one change seeded for every enabled agent', async (m) => {
        const files =
          values.seed === 'all'
            ? Object.values(SEED_FILE)
            : ctx.agents.map((a) => SEED_FILE[a.key]);
        const made = await platform.post(`/repos/${ctx.repo.id}/commits`, {
          ref: 'main',
          changes: files.map((path) => ({ path, content_b64: b64(SEEDED[path].join('\n')) })),
          message: 'Managed live test: seeded change',
          author,
        });
        await platform.post(`/repos/${ctx.repo.id}/branches`, {
          ref: branch,
          commit: made.commit,
          expected: null,
        });
        const change = await platform.post(`/repos/${ctx.repo.id}/changes`, {
          branch,
          title: 'Seeded change for the managed agents',
          body: 'Live test fixture: each file carries one problem.',
        });
        paid(
          `change #${change.number} starts ${ctx.agents.length} run(s): ${ctx.agents.map((a) => a.id).join(', ')}`,
        );
        Object.assign(ctx, { change: change.number, head: made.commit });
        Object.assign(m, {
          change: change.number,
          head: made.commit.slice(0, 12),
          files: files.join(' '),
        });
      });

      await step(
        sid('4'),
        `PAID: wait for every run to finish (timeout ${values['timeout-min']} min)`,
        async (m) => {
          const started = Date.now();
          for (;;) {
            const runs = (await managed.get(`/runs?repo=${ctx.repo.id}&limit=50`)).runs.filter(
              (r) => r.change === ctx.change && r.head === ctx.head,
            );
            for (const agent of ctx.agents)
              ctx.runs[agent.key] = runs.find((r) => r.agent === agent.id);
            const done = ctx.agents.filter((a) => TERMINAL.has(ctx.runs[a.key]?.status));
            m.progress = ctx.agents
              .map((a) => `${a.key}:${ctx.runs[a.key]?.status ?? 'none'}`)
              .join(' ');
            if (done.length === ctx.agents.length) break;
            if (Date.now() - started > TIMEOUT_MS) {
              const deliveries = await platform
                .get(`/repos/${ctx.repo.id}/hooks/${ctx.hook.id}/deliveries`)
                .catch((e) => ({ error: e.message }));
              m.deliveries = JSON.stringify(deliveries).slice(0, 300);
              throw new Error(
                `runs not finished after ${values['timeout-min']} min: ${m.progress}; hook deliveries ${m.deliveries}`,
              );
            }
            await sleep(10_000);
          }
          m.wait_s = Math.round((Date.now() - started) / 1000);
        },
      );

      const change = await platform.get(`/repos/${ctx.repo.id}/changes/${ctx.change}`);
      for (const agent of ctx.agents)
        await step(
          sid(`5.${agent.key}`),
          `${agent.id}: result, comments, check, transcript, cost`,
          async (m) => {
            const run = ctx.runs[agent.key];
            Object.assign(m, {
              status: run.status,
              value: run.value,
              harness: run.harness,
              model: `${run.provider}/${run.model}`,
              fallback: run.fallback ?? 'none',
              duration_s: run.finished_at
                ? Math.round((run.finished_at - run.created_at) / 1000)
                : null,
              container_s: run.container_seconds,
              // The container is billed from its start to its destroy, so it started this long before the run ended.
              container_started: run.finished_at
                ? new Date(run.finished_at - run.container_seconds * 1000).toISOString()
                : null,
              calls: run.calls,
              tokens_in: run.input_tokens,
              tokens_out: run.output_tokens,
              cost_usd: run.cost_usd,
              cap_usd: agent.cap,
              findings: run.findings,
              withheld: run.withheld,
            });
            assert.ok(
              ['passed', 'findings'].includes(run.status),
              `run ended ${run.status}: ${run.error ?? ''}`,
            );
            assert.ok(
              run.cost_usd > 0 && run.cost_usd <= agent.cap + 0.05,
              `cost $${run.cost_usd} against the $${agent.cap} cap`,
            );
            assert.ok(run.container_seconds > 0, 'no container time was recorded');
            assert.ok(run.input_tokens > 0 && run.calls > 0, 'no model call was metered');
            const mine = change.comments.filter((c) => String(c.body).includes(run.id));
            const anchored = mine.filter((c) => c.path && c.line);
            m.comments = `${anchored.length} anchored + ${mine.length - anchored.length} summary`;
            assert.ok(mine.length - anchored.length >= 1, 'no summary comment from this run');
            m.anchors = anchored.map((c) => `${c.path}:${c.line}`).join(' ');
            const caught = anchored.some((c) => c.path === SEED_FILE[agent.key]);
            m.caught = caught;
            Object.assign(ctx.recall[agent.key], {
              caught: ctx.recall[agent.key].caught + (caught ? 1 : 0),
              runs: ctx.recall[agent.key].runs + 1,
              cost: ctx.recall[agent.key].cost + run.cost_usd,
            });
            if (!values.eval)
              assert.ok(
                caught,
                `no comment anchored in ${SEED_FILE[agent.key]} (the seeded problem was missed)`,
              );
            const check = (change.head_commit?.checks ?? []).find((c) => c.name === agent.check);
            assert.ok(check, `no ${agent.check} check on the head`);
            m.check = check.status;
            if (agent.valueType === 'pass_fail')
              assert.equal(
                check.status,
                run.value === 'fail' ? 'fail' : 'pass',
                'the check matches the value',
              );
            else assert.equal(check.status, 'pass', 'Slop never blocks by default');
            const detail = await managed.get(`/runs/${ctx.repo.id}/${encodeURIComponent(run.id)}`);
            assert.ok(
              typeof detail.transcript === 'string' && detail.transcript.length > 0,
              'no transcript through the API',
            );
            m.transcript_bytes = detail.transcript.length;
            m.cost_lines = detail.cost.length;
            assert.ok(
              detail.cost.some((c) => /^Container/.test(c.note ?? '')),
              'no container line in the cost breakdown',
            );
          },
        );

      await step(sid('6'), 'The workspace credit went down by the runs’ cost', async (m) => {
        const after = (await managed.get('')).credit;
        const spent = ctx.agents.reduce((sum, a) => sum + ctx.runs[a.key].cost_usd, 0);
        const delta = after.used_usd - ctx.creditRound.used_usd;
        Object.assign(m, {
          balance_after: after.balance_usd,
          used_delta: delta.toFixed(6),
          runs_cost: spent.toFixed(6),
        });
        // Another run in this workspace during the test would also count; this test expects none.
        assert.ok(
          Math.abs(delta - spent) < 0.0001,
          `credit used grew by $${delta}, the runs cost $${spent}`,
        );
      });
    }

    if (values['pause-test'])
      await step('7', 'Automation pause: a change opened while paused starts no run', async (m) => {
        await platform.post(`/repos/${ctx.repo.id}/break-glass`, {
          action: 'pause_automation',
          reason: 'managed live test',
        });
        try {
          const made = await platform.post(`/repos/${ctx.repo.id}/commits`, {
            ref: 'main',
            changes: [{ path: 'src/paused.js', content_b64: b64('export const paused = true;\n') }],
            message: 'Managed live test: while paused',
            author,
          });
          await platform.post(`/repos/${ctx.repo.id}/branches`, {
            ref: 'managed-paused',
            commit: made.commit,
            expected: null,
          });
          const paused = await platform.post(`/repos/${ctx.repo.id}/changes`, {
            branch: 'managed-paused',
            title: 'Opened while paused',
          });
          await sleep(90_000);
          const runs = (await managed.get(`/runs?repo=${ctx.repo.id}&limit=50`)).runs.filter(
            (r) => r.change === paused.number,
          );
          m.runs_while_paused = runs.length;
          assert.equal(
            runs.length,
            0,
            `runs started while paused: ${runs.map((r) => `${r.agent}:${r.status}`).join(', ')}`,
          );
        } finally {
          await platform.post(`/repos/${ctx.repo.id}/break-glass`, {
            action: 'resume_automation',
            reason: 'managed live test done',
          });
        }
      });
  } catch (e) {
    failed = true;
    if (!e.recorded) process.stdout.write(`FAIL ${String(e.message ?? e).slice(0, 400)}\n`);
  } finally {
    if (managed && ctx.repo) {
      await rec.step('8', 'Disable every agent: token revoked, webhook deleted', async (m) => {
        for (const agent of ctx.agents)
          await managed.call('PUT', `/agents/${agent.id}`, { repos: [] });
        const tokens = (await platform.get(`/repos/${ctx.repo.id}/tokens`)).tokens.filter((t) =>
          t.name.startsWith('yoneda-managed-agents'),
        );
        const hooks = (await platform.get(`/repos/${ctx.repo.id}/hooks`)).hooks.filter((h) =>
          String(h.url).endsWith(`/hooks/${ctx.repo.id}`),
        );
        Object.assign(m, {
          tokens: tokens.map((t) => `${t.name}:${t.revoked_at ? 'revoked' : 'LIVE'}`).join(' '),
          hooks_left: hooks.length,
        });
        assert.ok(
          tokens.every((t) => t.revoked_at),
          'an agents token is still live',
        );
        assert.equal(hooks.length, 0, 'the managed webhook is still registered');
        const state = await managed.get('');
        assert.ok(
          state.agents.every((a) => !a.enabled_repos.includes(ctx.repo.id)),
          'an agent is still enabled on the repository',
        );
      });
      if (values.keep)
        process.stdout.write(`KEEP: ${ctx.repo.name} (${ctx.repo.id}) left for debugging\n`);
      else
        await rec.step('9', 'Delete the throwaway repository', async (m) => {
          await platform.call(
            'DELETE',
            `/repos/${ctx.repo.id}?confirm=${encodeURIComponent(ctx.repo.name)}`,
          );
          m.deleted = ctx.repo.id;
        });
    }
  }
  process.stdout.write(`\n${rec.table()}\n`);
  if (ctx.recall && (REPEAT > 1 || values.eval)) {
    const rows = Object.entries(ctx.recall).map(
      ([key, r]) =>
        `| ${AGENTS[key].id} | ${r.caught}/${r.runs} | $${(r.runs ? r.cost / r.runs : 0).toFixed(4)} |`,
    );
    process.stdout.write(
      `\n| Agent | Caught its seeded problem | Mean cost |\n|---|---|---|\n${rows.join('\n')}\n`,
    );
  }
  return failed || rec.items.some((i) => i.status === 'fail') ? 1 : 0;
}

process.exitCode = await main();
