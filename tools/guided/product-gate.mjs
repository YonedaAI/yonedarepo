#!/usr/bin/env node
// Driver-side wrapper: run the generic browser check against the isolated preview of one exact
// checked evaluation, with the agents' tests/ files from that candidate's own revision.
// Separate from the protected oracle; never reported as an in-container check.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBrowserCheck, testPath } from './browser-check.mjs';
import { reviewerClient } from './credentials.mjs';

export const defaultOutRoot = '.local/guided-task-board/product-gate';
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Removes the signed preview token (JWT-like or long path segment) from persisted text. */
export function redactor(url) {
  const secrets = new URL(url).pathname
    .split('/')
    .filter((part) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(part) || part.length > 80);
  return (text) => secrets.reduce((value, secret) => value.split(secret).join('[token]'), String(text));
}

/** Exact checked evaluation -> its isolated preview URL; refuses a mismatched candidate/revision. */
export async function resolvePreview(api, repo, { evaluation, candidate, revision }) {
  check(/^repo-[a-f0-9]{32}$/.test(repo ?? ''), 'Repository id required');
  check(typeof evaluation === 'string' && evaluation, 'Evaluation id required');
  const snapshot = await api(`repos/${repo}/snapshot`);
  const record = snapshot.evaluations?.find((item) => item.id === evaluation);
  check(record, 'Evaluation not found in repository snapshot');
  check(!candidate || record.candidate === candidate, 'Evaluation belongs to a different candidate');
  check(!revision || record.revision?.commit === revision, 'Evaluation revision differs from requested revision');
  check(/^[a-f0-9]{7,64}$/.test(record.revision?.commit ?? ''), 'Evaluation has no exact revision');
  const preview = await api(`repos/${repo}/site_preview?evaluation=${encodeURIComponent(evaluation)}`);
  check(typeof preview?.url === 'string', 'Preview link unavailable');
  return { url: preview.url, candidate: record.candidate, revision: record.revision.commit, snapshot };
}

/** Writes the candidate's tests/ text files to a private temp dir; null when there are none. */
export async function agentTests(api, repo, candidate, dir) {
  const source = await api(`repos/${repo}/candidate_source?id=${encodeURIComponent(candidate)}`);
  const files = Object.entries(source.files ?? {}).filter(
    ([path, file]) => /^tests\/[\w./-]+\.m?js$/.test(path) && !path.includes('..') && typeof file?.content === 'string' && !file.encoding,
  );
  if (!files.some(([path]) => path === testPath)) return null;
  for (const [path, file] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, path), file.content, { mode: 0o600 });
  }
  return join(dir, testPath);
}

export async function runProductGate(api, repo, { evaluation, candidate, revision, outRoot = defaultOutRoot, check: browserCheck = runBrowserCheck }) {
  const target = await resolvePreview(api, repo, { evaluation, candidate, revision });
  const dir = await mkdtemp(join(tmpdir(), 'guided-agent-tests-'));
  try {
    const outDir = resolve(outRoot, target.revision);
    const result = await browserCheck({
      url: target.url,
      testFile: await agentTests(api, repo, target.candidate, dir),
      revision: target.revision,
      outDir,
      redact: redactor(target.url),
      meta: { candidate: target.candidate, evaluation, kind: 'driver_side_browser_check' },
    });
    return { result, outDir, snapshot: target.snapshot };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Compact summary for driver state; full detail stays in result.json beside the screenshots. */
export function gateSummary(result, outDir) {
  return {
    kind: 'driver_side_browser_check',
    revision: result.revision,
    candidate: result.candidate,
    evaluation: result.evaluation,
    outcome: result.outcome,
    failed: result.failed,
    agent_tests: result.agent_tests?.status,
    duration_ms: result.duration_ms,
    finished_at: result.finished_at,
    result_path: join(outDir, 'result.json'),
    steps: result.steps.map(({ name, status, duration_ms }) => ({ name, status, duration_ms })),
  };
}

export const usage = `node tools/guided/product-gate.mjs --repo REPO --evaluation EVALUATION_ID [--candidate ID] [--revision SHA] [--origin URL] [--key-file MODE0600_FILE | --username ACCOUNT] [--out-root DIR]
One login; the signed preview link is never printed or stored. Writes <out-root>/<revision>/result.json
and screenshots; exits 1 if any check fails or the agents provided no ${testPath}.`;

export async function main(args = process.argv.slice(2)) {
  const names = { '--repo': 'repo', '--evaluation': 'evaluation', '--candidate': 'candidate', '--revision': 'revision', '--origin': 'origin', '--key-file': 'keyFile', '--username': 'username', '--out-root': 'outRoot' };
  const options = { origin: 'https://yonedarepo.com' };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') return console.log(usage);
    const key = names[args[index]];
    check(key && args[index + 1] && !args[index + 1].startsWith('--'), 'Invalid product-gate arguments; use --help');
    options[key] = args[++index];
  }
  const client = await reviewerClient(options.origin, options);
  const { result, outDir } = await runProductGate(client.api, options.repo, options);
  console.log(JSON.stringify(gateSummary(result, outDir), null, 2));
  if (result.outcome !== 'pass') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(`Product gate stopped: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`);
    process.exitCode = 1;
  });
