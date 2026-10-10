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
    const candidates = details.flatMap(detail => detail.candidates).filter(candidate => !candidate.refresh_of && !candidate.conflict_id);
    if (candidates.some(candidate => ['rejected', 'failed'].includes(candidate.status)) || details.some(detail => ['failed', 'cancelled'].includes(detail.runs[0].status)))
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
  // The request id maps to a deterministic decision id. Look up the recorded decision first,
  // so a restart after publication never submits the old approval against the new head.
  const selected = candidates[0];
  access.selection_request ??= randomUUID();
  const decisionId = `decision:${access.selection_request}`;
  let decision;
  try { decision = await api(`repos/${access.repo_id}/decision?id=${encodeURIComponent(decisionId)}`); }
  catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
  if (decision) {
    assert.equal(decision.request_id, access.selection_request, 'Recorded decision must belong to the frozen request.');
    assert.equal(decision.candidate, selected.id, 'Recorded decision must select the frozen fixture candidate.');
  } else {
    if (!access.selection_input) {
      const overview = await api(`repos/${access.repo_id}/repository_overview`);
      access.selection_input = {
        request_id: access.selection_request, expected_commit: overview.repository.head_commit,
        expected_version: overview.repository.version, candidate: selected.id,
        decision_kind: 'development_verification',
        rationale: 'Controlled isolated publication acknowledgement-loss exercise; not human product acceptance.', alternatives: [],
      };
      await savePrivate(credentialsPath, access);
    }
    assert.equal(access.selection_input.request_id, access.selection_request);
    assert.equal(access.selection_input.candidate, selected.id, 'Persisted approval must still refer to the same fixture candidate.');
    decision = await api(`repos/${access.repo_id}/accept`, access.selection_input);
  }
  const published = await until(async () => {
    const detail = await api(`repos/${access.repo_id}/decision?id=${encodeURIComponent(decision.id ?? decisionId)}`);
    return detail.status === 'published' ? detail : false;
  }, 'publication readback recovery', deadline);
  await collectEvents();
  assert.ok(events.some(event => event.kind === 'job.progress' && event.data?.progress?.stage === 'controlled_publish_ack_loss'), 'The deployed acknowledgement loss must actually be injected.');
  const remote = await git(directory, ['ls-remote', `${access.origin}/git/${access.repo_id}/source`, 'refs/heads/main'], access.grant.token);
  assert.equal(remote.split(/\s+/)[0], selected.revision.commit);

  // Refresh a second, disjoint candidate that was captured on the old base. The owner route
  // performs trusted Git merge/capture and schedules a fresh independent evaluation.
  const stale = candidates.find(candidate => candidate.id !== selected.id
    && candidate.base.commit === selected.base.commit
    && candidate.paths?.every(path => !selected.paths?.includes(path)));
  assert.ok(stale, 'A second initially evaluated candidate must have paths disjoint from the published candidate.');
  const publishedHead = selected.revision.commit;
  const publishedOverview = await api(`repos/${access.repo_id}/repository_overview`);
  assert.equal(publishedOverview.repository.head_commit, publishedHead, 'Refresh must start from the read-back published head.');
  access.refresh_request ??= {
    request_id: randomUUID(), candidate_id: stale.id,
    expected_version: publishedOverview.repository.version, expected_commit: publishedHead,
    old_candidate_revision: stale.revision.commit, old_candidate_evaluation: stale.evaluation,
    candidate_path: stale.paths[0], published_path: selected.paths[0],
  };
  await savePrivate(credentialsPath, access);
  const refreshReceipt = await api(`repos/${access.repo_id}/refresh_candidate`, {
    request_id: access.refresh_request.request_id, candidate_id: access.refresh_request.candidate_id,
    expected_version: access.refresh_request.expected_version, expected_commit: access.refresh_request.expected_commit,
  });
  assert.equal(refreshReceipt.conflict_id, `conflict:${access.refresh_request.request_id}`);
  const conflict = await until(async () => {
    const status = await api(`repos/${access.repo_id}/conflict_status?conflict_id=${encodeURIComponent(refreshReceipt.conflict_id)}`);
    if (['unresolved', 'stale', 'failed'].includes(status.status)) throw new Error(`Disjoint refresh did not merge cleanly: ${status.status}`);
    return status.status === 'clean' ? status : false;
  }, 'trusted stale-candidate refresh', deadline);
  assert.equal(conflict.evidence.observed_head, publishedHead);
  assert.equal(conflict.evidence.candidate_commit, access.refresh_request.old_candidate_revision);
  assert.deepEqual(conflict.evidence.overlapping_paths, [], 'Disjoint candidate changes must remain conflict-free.');
  const refreshedRun = await until(async () => {
    const detail = await readRun(api, access.repo_id, stale.run_id);
    return detail.candidates.find(candidate => candidate.id === conflict.refreshed_candidate_id) ?? false;
  }, 'refreshed candidate record', deadline);
  const evaluated = await until(async () => {
    const detail = await readRun(api, access.repo_id, stale.run_id);
    const candidate = detail.candidates.find(item => item.id === refreshedRun.id);
    if (['rejected', 'failed'].includes(candidate?.status)) throw new Error('Freshly refreshed candidate failed independent evaluation.');
    return candidate?.status === 'eligible' && candidate.evaluation && candidate.evaluation !== access.refresh_request.old_candidate_evaluation
      ? { candidate, detail } : false;
  }, 'fresh eligible refresh evaluation', deadline);
  const refreshed = evaluated.candidate;
  assert.deepEqual(refreshed.approved_parents, [publishedHead, access.refresh_request.old_candidate_revision],
    'The merge commit must retain the exact ordered [new head, stale source] Git parents.');
  assert.equal(refreshed.base.commit, publishedHead);
  assert.equal(refreshed.revision.commit, conflict.merge_commit);
  assert.equal(refreshed.status, 'eligible');
  assert.ok(evaluated.detail.evaluations.some(item => item.id === refreshed.evaluation
    && item.candidate === refreshed.id && item.revision?.commit === refreshed.revision.commit
    && item.checks?.length && item.checks.every(check => check.status === 'pass')),
  'Require an independent passing evaluation for the refreshed revision.');
  const source = await api(`repos/${access.repo_id}/candidate_source?id=${encodeURIComponent(refreshed.id)}`);
  assert.equal(source.revision.commit, refreshed.revision.commit, 'Read back the actual refreshed Git tree.');
  assert.equal(source.files?.[access.refresh_request.published_path]?.content,
    'Controlled deployed fixture; not a product acceptance claim.\n', 'Published candidate file must survive refresh.');
  assert.equal(source.files?.[access.refresh_request.candidate_path]?.content,
    'Controlled deployed fixture; not a product acceptance claim.\n', 'Stale candidate file must survive refresh.');
  const evidence = { controlled_fixture: true, paid_inference: false, origin: access.origin, revision: health.revision,
    repo_id: access.repo_id, recorded_at: new Date().toISOString(), capacity_deferrals: deferred,
    candidates: candidates.map(({ id, revision, status }) => ({ id, revision, status })), decision: published,
    refresh: { conflict_id: refreshReceipt.conflict_id, status: conflict.status, merge_commit: conflict.merge_commit,
      refreshed_candidate: refreshed.id, refreshed_revision: refreshed.revision, ordered_git_parents: refreshed.approved_parents,
      evaluation: refreshed.evaluation, evaluation_status: refreshed.status,
      evidence: conflict.evidence, files_preserved: [access.refresh_request.published_path, access.refresh_request.candidate_path] }, events };
  await savePrivate(`${directory}/evidence.json`, evidence);
  console.log(`Verified deployed capacity deferral and publication recovery. Evidence: ${directory}/evidence.json`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
