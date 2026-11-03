// A single driver reserves the maintained per-review maxima before one pushed head. No model
// pricing estimate is treated as a limit, and temporary rules affect only the selected demo.
import assert from 'node:assert/strict';

const TERMINAL = new Set(['passed', 'findings', 'failed', 'cancelled', 'superseded']);
const micros = value => {
  assert.ok(Number.isFinite(value) && value >= 0, 'invalid managed credit or review cap');
  return Math.round(value * 1_000_000);
};

export class DemoGuards {
  restores = new Map();
  suppressed = new Map();
  constructor({ account, owner, managed, baseline, capUsd }) {
    assert.ok(Number.isFinite(capUsd) && capUsd > 0 && capUsd <= 2.9, 'the original demo cap is $2.90');
    Object.assign(this, { account, owner, managed, baseline, capUsd });
  }
  async reserve(repo) {
    const workspace = await this.account.get(this.managed);
    const { runs } = await this.account.get(`${this.managed}/runs?limit=200`);
    assert.ok(runs.every(run => TERMINAL.has(run.status)), 'unsettled reviews: wait before another head');
    const enabled = workspace.agents.filter(agent => agent.active && agent.enabled_repos.includes(repo));
    for (const id of ['slop-review', 'intent-drift'])
      assert.ok(enabled.some(agent => agent.id === id), `${id} must be enabled for the demo`);
    const worst = enabled.reduce((sum, agent) => sum + micros(agent.cost_cap_usd), 0);
    const spent = micros(workspace.credit.used_usd) - micros(this.baseline);
    assert.ok(spent >= 0 && spent + worst <= micros(this.capUsd), 'next head could exceed the managed cap');
    return { spent_usd: spent / 1_000_000, worst_usd: worst / 1_000_000, remaining_usd: (micros(this.capUsd) - spent) / 1_000_000 };
  }
  async suppress(repo) {
    if (this.suppressed.has(repo)) return;
    const { agents, capabilities } = await this.account.get(this.managed);
    assert.ok(capabilities?.includes('exact_head_review'), 'exact-head review selection is not deployed');
    const enabled = agents.filter(agent => agent.active && agent.enabled_repos.includes(repo));
    for (const agent of enabled)
      assert.ok(!(agent.repo_overrides[repo] ?? []).includes('trigger'), 'existing repository trigger override cannot be read; refusing to overwrite it');
    const { refs } = await this.owner.get(`/repos/${repo}/refs`);
    this.suppressed.set(repo, { refs, allowed: {}, agents: enabled.map(agent => agent.id) });
    for (const agent of enabled) {
      const trigger = structuredClone(agent.settings.trigger);
      this.restores.set(`trigger:${repo}:${agent.id}`, async () => {
        await this.safeToRestore(repo);
        await this.account.call('PUT', `${this.managed}/agents/${agent.id}`, { scope: repo, settings: { trigger } });
      });
      // '?' is forbidden in a Git ref and matched literally by the trigger filter.
      await this.account.call('PUT', `${this.managed}/agents/${agent.id}`, { scope: repo, settings: { trigger: { ...trigger, branches: ['?'] } } });
    }
  }
  async review(repo, change) {
    const paused = this.suppressed.get(repo);
    assert.ok(paused, 'suppress automatic reviews before coding');
    const reserved = await this.reserve(repo);
    for (const agent of paused.agents)
      await this.account.call('POST', `${this.managed}/agents/${agent}/run`, { repo, change: change.number, head: change.head });
    return reserved;
  }
  async complete(repo, change) {
    const paused = this.suppressed.get(repo);
    paused.allowed[`refs/heads/${change.branch}`] = change.head;
    if (change.status === 'landed') {
      const { refs } = await this.owner.get(`/repos/${repo}/refs`);
      paused.allowed['refs/heads/main'] = refs['refs/heads/main'];
    }
  }
  async safeToRestore(repo) {
    const { refs, allowed } = this.suppressed.get(repo);
    const now = (await this.owner.get(`/repos/${repo}/refs`)).refs;
    // Landing currently retains its branch. A landed result alone is not evidence that
    // the platform was meant to delete it, and no initial tag may disappear.
    const deleted = Object.keys(refs).filter(ref => !Object.hasOwn(now, ref));
    assert.equal(deleted.length, 0, `deleted initial ref: ${deleted.join(', ')}; automatic reviews remain suppressed`);
    assert.ok(Object.entries(now).every(([ref, head]) => refs[ref] === head || allowed[ref] === head), 'unreviewed additional publication: automatic reviews remain suppressed');
    const { runs } = await this.account.get(`${this.managed}/runs?repo=${repo}&limit=200`);
    assert.ok(runs.every(run => TERMINAL.has(run.status)), 'unsettled reviews: automatic reviews remain suppressed');
  }
  async slop(repo, level) {
    const key = `slop:${repo}`;
    if (!this.restores.has(key)) {
      const { agents } = await this.account.get(this.managed);
      const agent = agents.find(agent => agent.id === 'slop-review');
      assert.ok(agent && !(agent.repo_overrides[repo] ?? []).includes('block_at'), 'existing repository block_at override cannot be read; refusing to overwrite it');
      const previous = agent.settings.block_at;
      this.restores.set(key, () => this.account.call('PUT', `${this.managed}/agents/slop-review`, { scope: repo, settings: { block_at: previous } }));
    }
    await this.account.call('PUT', `${this.managed}/agents/slop-review`, { scope: repo, settings: { block_at: level } });
  }
  async relax(repo) {
    const key = `slop:${repo}`;
    const restore = this.restores.get(key);
    assert.ok(restore, 'relax requires strict in the same invocation');
    await restore();
    this.restores.delete(key);
  }
  async approvals(repo, body) {
    const key = `approval:${repo}`;
    if (!this.restores.has(key)) {
      const { policy } = await this.owner.get(`/repos/${repo}`);
      this.restores.set(key, () => this.owner.call('PUT', `/repos/${repo}/policy`, { policy }));
    }
    return body();
  }
  async run(body) {
    const errors = [];
    let result;
    try { result = await body(); } catch (error) { errors.push(error); }
    for (const [key, restore] of this.restores) {
      try { await restore(); this.restores.delete(key); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
    return result;
  }
}
