// Model check item of the staging kit (B2c): a repository whose policy requires a `security`
// model runner. A seeded vulnerable commit (SQL built by string concatenation) must fail it
// and be refused landing; the fix must pass and land. One review call per commit on the
// platform's own key (REVIEW_MODEL_KEY), so the spend is a fraction of a cent.
import assert from 'node:assert/strict';
import { b64, until } from './client.mjs';

const author = { name: 'Staging kit', email: 'kit@yonedarepo.invalid' };
const RUBRIC = 'Security review. Fail when the change builds SQL, shell commands or HTML by concatenating or formatting untrusted input, or adds a hard-coded credential. Otherwise pass.';
const VULNERABLE = 'import sqlite3\n\n\ndef find_user(db: sqlite3.Connection, name: str):\n    query = "SELECT id, email FROM users WHERE name = \'" + name + "\'"\n    return db.execute(query).fetchone()\n';
const FIXED = 'import sqlite3\n\n\ndef find_user(db: sqlite3.Connection, name: str):\n    query = "SELECT id, email FROM users WHERE name = ?"\n    return db.execute(query, (name,)).fetchone()\n';

/** Commits `text` as users.py on main and waits for its security run to finish. */
async function reviewed(platform, repo, text, message) {
  const made = await platform.post(`/repos/${repo}/commits`, { ref: 'main', changes: [{ path: 'users.py', content_b64: b64(text) }], message, author });
  const run = made.check_runs?.find((r) => r.name === 'security');
  assert.ok(run, 'Recording the commit queued no security run');
  const done = await until(
    async () => {
      const current = await platform.get(`/repos/${repo}/check-runs/${run.id}`);
      return ['passed', 'failed', 'errored'].includes(current.status) && current;
    },
    { timeoutMs: 5 * 60_000, intervalMs: 3000, what: 'model check run' },
  );
  return { commit: made.commit, status: done.status, result: done.result ?? {} };
}

const summary = (r) => `${r.status} (verdict ${r.result.verdict ?? '-'}, score ${r.result.score ?? '-'}, $${((r.result.cost_microusd ?? 0) / 1e6).toFixed(5)})`;

export async function modelCheck(platform, metrics) {
  const policy = { required_checks: ['security'], approvals: 0, runners: { security: { kind: 'model', rubric: RUBRIC } } };
  const name = `kit-model-${Date.now()}`;
  const repo = await platform.post('/repos', { name, policy, files: [{ path: 'README.md', content_b64: b64('# Model check\n') }], author });
  metrics.repo = repo.id;
  try {
    const bad = await reviewed(platform, repo.id, VULNERABLE, 'Look up a user by name');
    metrics.vulnerable = summary(bad);
    metrics.vulnerable_findings = (bad.result.findings ?? []).map((f) => `${f.severity} ${f.path}:${f.line ?? '-'} ${f.message}`).join(' | ');
    assert.equal(bad.status, 'failed', `Vulnerable commit: ${JSON.stringify(bad.result).slice(0, 400)}`);
    const refused = await platform.raw('POST', `/repos/${repo.id}/land`, { ref: 'main', commit: bad.commit });
    metrics.vulnerable_land = refused.body?.error?.code ?? refused.status;
    assert.equal(refused.body?.error?.code, 'NOT_READY', 'Landing the failed commit was not refused');

    const good = await reviewed(platform, repo.id, FIXED, 'Bind the user name as a query parameter');
    metrics.fixed = summary(good);
    assert.equal(good.status, 'passed', `Fixed commit: ${JSON.stringify(good.result).slice(0, 400)}`);
    const landed = await platform.post(`/repos/${repo.id}/land`, { ref: 'main', commit: good.commit });
    assert.equal(landed.landed, true, 'The passing commit did not land');
    metrics.fixed_land = 'landed';
    metrics.model = good.result.model;
    metrics.spend_usd = (((bad.result.cost_microusd ?? 0) + (good.result.cost_microusd ?? 0)) / 1e6).toFixed(5);
  } finally {
    await platform.raw('DELETE', `/repos/${repo.id}?confirm=${encodeURIComponent(name)}`);
  }
}
