#!/usr/bin/env node
// No work is created or started without --run. No signup, provider keys, funding or publishing.
import { mkdir, writeFile, rename, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { reviewerClient, safeOrigin, privateFile } from './guided/credentials.mjs';
import { driveGuided } from './guided/driver.mjs';

export const usage = `node tools/guided-acceptance.mjs --expected-revision SHA [--transport api-source-v1|git-native-v1] [--guided-version 1|2] [--run] [--state PATH] [--key-file MODE0600_FILE | --username EXISTING_ACCOUNT] [--product-gate [--gate-out DIR]]
Default: read-only session inspection. --run creates a fresh task-board-v1 project and advances its bounded steps.
Resume with --run and the SAME --state file; saved session/request IDs are never replaced.
Key input is hidden terminal/stdin or a mode-0600 file; never an argument.
No publication, funding reset, provider reconfiguration or context-causality claim.
--product-gate: after read_only_review, run the driver-side browser check (system Chrome) on the
exact checked final preview and record stage timing in the state file. Failure exits 1 and
leaves demo_ready false. It is not an in-container check.`;

export function parseArgs(args) {
  const options = {
    run: false,
    origin: 'https://yonedarepo.com',
    state: '.local/guided-task-board/session.json',
  };
  const names = {
    '--origin': 'origin',
    '--state': 'state',
    '--key-file': 'keyFile',
    '--username': 'username',
    '--expected-revision': 'expectedRevision',
    '--transport': 'transport',
    '--guided-version': 'guidedVersion',
    '--gate-out': 'gateOut',
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' && args.length === 1) return { help: true };
    if (argument === '--run' || argument === '--product-gate') {
      options[argument === '--run' ? 'run' : 'productGate'] = true;
      continue;
    }
    if (!names[argument] || !args[index + 1] || args[index + 1].startsWith('--'))
      throw new Error('Invalid acceptance arguments; use --help');
    options[names[argument]] = args[++index];
  }
  options.origin = safeOrigin(options.origin);
  options.transport ??= 'api-source-v1';
  if (options.guidedVersion !== undefined) {
    options.guidedVersion = Number(options.guidedVersion);
    if (![1, 2].includes(options.guidedVersion)) throw new Error('--guided-version must be 1 or 2');
  }
  if (!['api-source-v1', 'git-native-v1'].includes(options.transport))
    throw new Error('Transport must be api-source-v1 or git-native-v1');
  if (!/^[a-f0-9]{7,64}$/.test(options.expectedRevision ?? ''))
    throw new Error('Explicit approved platform revision required');
  return options;
}

async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage);
    return;
  }
  const path = resolve(options.state);
  let state = {};
  try {
    await lstat(path);
    state = JSON.parse(await privateFile(path));
  } catch (failure) {
    if (failure.code !== 'ENOENT') throw failure;
  }
  const client = await reviewerClient(options.origin, options);
  const owner = createHash('sha256').update(client.owner).digest('hex');
  if (
    (state.origin && state.origin !== options.origin) ||
    (state.owner_digest && state.owner_digest !== owner)
  )
    throw new Error('Retained session belongs to another platform/account');
  if (options.run) {
    state.origin = options.origin;
    state.owner_digest = owner;
  }
  const result = await driveGuided(client, state, {
    ...options,
    save: (value) => save(path, value),
  });
  let gate;
  if (options.productGate && result.mode === 'read_only_review') {
    // Loaded lazily: the browser dependency is needed only for this optional post-step.
    const { productGateStep } = await import('./guided/post-review.mjs');
    gate = await productGateStep(client, state, {
      outRoot: options.gateOut,
      save: (value) => save(path, value),
    });
    if (!gate.demo_ready) process.exitCode = 1;
  }
  // Print only public identifiers and truthful mode, never API bodies or credential state.
  console.log(
    JSON.stringify({
      mode: result.mode,
      repo_id: result.repo_id,
      session_id: result.session_id,
      next_step: result.next_step ?? result.session?.next_step,
      message: result.message,
      context_causal_effect: null,
      product_gate: options.productGate
        ? (gate && {
            outcome: gate.product_gate.outcome,
            failed: gate.product_gate.failed,
            result_path: gate.product_gate.result_path,
          }) ?? 'runs only after read_only_review'
        : undefined,
      demo_ready: gate?.demo_ready,
      bottleneck: gate?.timing?.total?.bottleneck,
      review: result.repo_id
        ? `${options.origin}/?repo=${encodeURIComponent(result.repo_id)}`
        : undefined,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(
      'Guided acceptance stopped; inspect the retained private session. No credential/response body logged.',
    );
    process.exitCode = 1;
  });
