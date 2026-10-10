#!/usr/bin/env node
// Real isolated Containers/Artifacts exercise; no inference and no production mutations.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { client, git, load, savePrivate, until } from './acceptance/client.mjs';
import { readRun } from './reviewer-client.mjs';

const directory = resolve('.local/platform-acceptance');
const credentialsPath = `${directory}/access.json`;
const configPath = resolve('.local/deploy/yonedarepo-acceptance/platform.json');

async function main() {
  assert.equal(process.argv.length, 2, 'Use node tools/platform-acceptance.mjs; configure the isolated deployment first.');
  const configuration = await load(configPath);
  const access = await load(credentialsPath);
  assert.equal(configuration.name, 'yonedarepo-acceptance');
  assert.equal(configuration.containers[0].max_instances, 2);
  assert.ok(configuration.vars.ARTIFACTS_NAMESPACE.endsWith('-acceptance'));
  assert.equal(configuration.vars.ACCEPTANCE_FAULTS, 'publish-ack-once');
  assert.equal(configuration.vars.ACCEPTANCE_REPOSITORY, access.repo_id);
  assert.equal(access.origin, 'https://yonedarepo-acceptance.mlong-f01.workers.dev');
  assert.ok(!configuration.routes?.length, 'Acceptance must never claim production domains.');
  const deadline = Date.now() + 15 * 60 * 1000;
  const { api, mcp } = client(access.origin);
  const health = await (await fetch(`${access.origin}/health`, { signal: AbortSignal.timeout(15000) })).json();
  assert.equal(health.service, 'yonedarepo');
  if (!access.registered) {
    try {
      const signup = await api('auth/signup', { username: access.username, password: access.password });
      access.recovery_code = signup.recovery_code;
    } catch (error) { if (error.code !== 'ALREADY_EXISTS') throw error; }
    access.registered = true;
    await savePrivate(credentialsPath, access);
  }
  await api('auth/login', { username: access.username, password: access.password });
  const policy = {
    version: 'controlled-capacity-v1', suite: 'commands-v1', environment: 'linux-node24-rust1.94-v1', required_checks: ['hold-capacity'],
    build: { setup: [], checks: [{ name: 'hold-capacity', timeout_seconds: 60,
      argv: ['node', '-e', "const fs=require('node:fs');if(!fs.existsSync('public/index.html'))process.exit(1);setTimeout(()=>process.exit(0),45000)"] }] },
  };
  const project = await api('projects', { request_id: access.request_id, name: 'Controlled capacity and publication fixture', policy });
  assert.equal(project.id, access.repo_id);
  await until(async () => {
    const project = await api(`projects/${access.repo_id}`);
    if (project.status === 'failed') throw new Error(`Fixture setup failed: ${project.error?.code ?? 'unknown'}`);
    return project.status === 'ready';
  }, 'fixture project setup', deadline);
  if (!access.grant) {
    access.grant = await api(`repos/${access.repo_id}/grants`, { label: 'Controlled acceptance fixture', scope: 'contribute', days: 1 });
    await savePrivate(credentialsPath, access);
  }
  access.contributions ??= [];
  for (let index = access.contributions.length; index < 3; index++) {
    access.contributions.push({ request_id: randomUUID() });
    await savePrivate(credentialsPath, access);
  }
  for (let index = 0; index < 3; index++) {
    const receipt = access.contributions[index];
    if (receipt.pushed) continue;
    const attempt = await mcp(access.repo_id, access.grant.token, 'attempt_begin', {
      request_id: receipt.request_id, intent: `Controlled capacity fixture ${index + 1}; no model inference`, criteria: ['A real clean evaluator must finish'],
    });
    receipt.attempt = attempt;
    await savePrivate(credentialsPath, access);
    const worktree = `${directory}/contribution-${index}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // A persisted Git checkout is reused after interruption; never delete unfamiliar files.
    try { await git(worktree, ['rev-parse', '--git-dir']); }
    catch { await git(directory, ['clone', attempt.git_url, worktree], access.grant.token); }
    await writeFile(`${worktree}/acceptance-${index}.txt`, 'Controlled deployed fixture; not a product acceptance claim.\n');
    await git(worktree, ['add', `acceptance-${index}.txt`]);
    const staged = await git(worktree, ['diff', '--cached', '--name-only']);
    if (staged) await git(worktree, ['-c', 'user.name=YonedaRepo acceptance fixture', '-c', 'user.email=acceptance@invalid.example', 'commit', '-m', 'Controlled deployed fixture']);
    await git(worktree, ['push', 'origin', 'HEAD:main'], access.grant.token);
    receipt.pushed = true;
    await savePrivate(credentialsPath, access);
  }
  // Submit three real capture/evaluation pipelines together to contend for two slots.
  await Promise.all(access.contributions.map(receipt => mcp(access.repo_id, access.grant.token, 'attempt_submit', { attempt_id: receipt.attempt.attempt_id })));
  console.log('Three real fixture pipelines submitted to the isolated two-container deployment; no inference started.');
  const candidates = await until(async () => {
    const details = await Promise.all(access.contributions.map(receipt => readRun(api, access.repo_id, receipt.attempt.execution.run_id)));
    const candidates = details.flatMap(detail => detail.candidates);
    if (candidates.some(candidate => candidate.status === 'rejected') || details.some(detail => ['failed', 'cancelled'].includes(detail.runs[0].status)))
      throw new Error('A controlled fixture pipeline failed; inspect its recorded events.');
    return candidates.length === 3 && candidates.every(candidate => candidate.status === 'eligible') ? candidates : false;
  }, 'all three clean evaluations', deadline);
  const events = [];
  let after = 0;
  async function collectEvents() {
    for (;;) {
      const page = await api(`repos/${access.repo_id}/events?after=${after}`);
      const batch = page.events;
      assert.ok(Array.isArray(batch), 'Expected ordered event page');
      events.push(...batch);
      if (!batch.length) break;
      after = batch.at(-1).seq;
      if (batch.length < 200) break;
    }
  }
  await collectEvents();
  const deferred = events.filter(event => event.kind === 'job.deferred');
  assert.ok(deferred.length, 'Capacity exhaustion must actually occur; an ordinary successful run is insufficient.');
  const overview = await api(`repos/${access.repo_id}/repository_overview`);
  access.selection_request ??= randomUUID();
  await savePrivate(credentialsPath, access);
  const selected = candidates[0];
  const decision = await api(`repos/${access.repo_id}/accept`, {
    request_id: access.selection_request, expected_commit: overview.repository.head_commit, expected_version: overview.repository.version,
    candidate: selected.id, decision_kind: 'development_verification',
    rationale: 'Controlled isolated publication acknowledgement-loss exercise; not human product acceptance.', alternatives: [],
  });
  const published = await until(async () => {
    const detail = await api(`repos/${access.repo_id}/decision?id=${encodeURIComponent(decision.id)}`);
    return detail.status === 'published' ? detail : false;
  }, 'publication readback recovery', deadline);
  await collectEvents();
  assert.ok(events.some(event => event.kind === 'job.progress' && event.data?.progress?.stage === 'controlled_publish_ack_loss'), 'The deployed acknowledgement loss must actually be injected.');
  const remote = await git(directory, ['ls-remote', `${access.origin}/git/${access.repo_id}/source`, 'refs/heads/main'], access.grant.token);
  assert.equal(remote.split(/\s+/)[0], selected.revision.commit);
  const evidence = { controlled_fixture: true, paid_inference: false, origin: access.origin, revision: health.revision,
    repo_id: access.repo_id, recorded_at: new Date().toISOString(), capacity_deferrals: deferred,
    candidates: candidates.map(({ id, revision, status }) => ({ id, revision, status })), decision: published, events };
  await savePrivate(`${directory}/evidence.json`, evidence);
  console.log(`Verified deployed capacity deferral and publication recovery. Evidence: ${directory}/evidence.json`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
