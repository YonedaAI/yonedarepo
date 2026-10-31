#!/usr/bin/env node
// The only door between a deploy or kit run and a public Actions log. This repository is
// public, so everything a command prints is dropped except lines allowed here: wrangler's
// failures can name the account's email, and kit reasons and metrics name accounts and
// repository ids. The job summary is closed the same way (xtask tables append to it). The
// allowed lines say what failed; the why stays off GitHub: rerun the command locally.
//   node tools/ship/quiet.mjs deploy|kit -- <command> [args...]
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const GUARD = /^(Refusing|Stopping)\b/;
const WRANGLER_FAILED = /^wrangler [ -~]* failed \(exit status: \d+\)$/;
// Rows of the deploy timings table (step, seconds, ok or FAILED), never the smoke's details.
const TIMING = /^\| .+ \| +[0-9.]+ +\| +(ok|FAILED)? +\|$/;
const KIT_RESULT = /^(PASS|FAIL|SKIP) (\S+) (\d+ms)/;

/** What `line` may show on a public log, or null. */
export function publicLine(profile, line) {
  if (profile === 'kit') {
    const result = line.match(KIT_RESULT);
    return result ? `${result[1]} ${result[2]} ${result[3]}` : null;
  }
  if (GUARD.test(line) || WRANGLER_FAILED.test(line)) return `::error::${line}`;
  return TIMING.test(line) ? line : null;
}

/** Runs the command with its output filtered; resolves with its exit code. */
export function runQuiet(profile, command, args, write = (line) => console.log(line)) {
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const filter = (stream) =>
    createInterface({ input: stream }).on('line', (line) => {
      const shown = publicLine(profile, line);
      if (shown !== null) write(shown);
    });
  filter(child.stdout);
  filter(child.stderr);
  return new Promise((done) => {
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
  }).then((code) => {
    if (code !== 0) write(`::error::${profile} exited ${code}. Its details stay off this public log: rerun it locally.`);
    return code;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [profile, separator, command, ...args] = process.argv.slice(2);
  if (!['deploy', 'kit'].includes(profile) || separator !== '--' || !command) {
    console.error('Usage: quiet.mjs deploy|kit -- <command> [args...]');
    process.exit(2);
  }
  process.exitCode = await runQuiet(profile, command, args);
}
