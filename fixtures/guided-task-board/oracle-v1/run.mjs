// Installed in the digest-pinned owner test bundle, never candidate source.
// Runtime must set these from frozen run.guided, overriding candidate env/argv.
const phase = process.env.GUIDED_CHECK_PHASE;
const variant = process.env.GUIDED_CHECK_VARIANT;
const { checkTaskBoard } = await import('./check.mjs');
try {
  const result = checkTaskBoard(process.cwd(), phase, variant);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.pass ? 0 : 1;
} catch {
  process.stderr.write('Trusted guided phase/variant missing or invalid\n');
  process.exitCode = 1;
}
