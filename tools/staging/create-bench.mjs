// Repository create time, as the New repository dialog asks for it: seeded, one at a time, on
// the platform's own clock (Server-Timing) and the client's. Each run's repositories are
// deleted (and purged, where the undo window keeps them) at its end. Compare ASYNC_STORE off
// and on with the same command on each deploy.
//
//   node tools/staging/create-bench.mjs [--origin URL] [--runs 3] [--creates 20]
//
// Signs in as the kit account (staging-kit.env, as the real-world kit); no secret is printed.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { accountSession, b64, kitCredentials, purgeWhatIsDeleted, readEnvFile, Session } from './client.mjs';

const { values: args } = parseArgs({
  options: {
    origin: { type: 'string', default: 'https://dev.yonedarepo.com' },
    runs: { type: 'string', default: '3' },
    creates: { type: 'string', default: '20' },
  },
});
const origin = args.origin.replace(/\/$/, '');
const kit = kitCredentials();
const { cookie } = await accountSession(origin, kit.KIT_USERNAME, kit.KIT_PASSWORD);
const api = new Session(`${origin}/api/v1`, { cookie });
const { OWNER_TOKEN } = readEnvFile('staging.env', { required: false });
if (OWNER_TOKEN) purgeWhatIsDeleted(new Session(`${origin}/api/v1`, { bearer: OWNER_TOKEN }));

const seconds = (ms) => (ms / 1000).toFixed(2).padStart(7);
function line(name, values) {
  const sorted = values.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  console.log(`${name.padEnd(16)} n=${String(sorted.length).padEnd(3)} min${seconds(sorted[0])}  median${seconds(median)}  max${seconds(sorted.at(-1))}`);
}

/** The `create.*` and `do.repo_init` phases of a Server-Timing header: [[name, ms]]. */
const phases = (headers) =>
  (headers.get('server-timing') ?? '')
    .split(',')
    .map((part) => /^\s*([^;]+);.*dur=([\d.]+)/.exec(part))
    .filter((m) => m && /^(create\.|do\.repo_init)/.test(m[1]))
    .map((m) => [m[1], Number(m[2])]);

const everything = { wall: [], by: new Map() };
const refused = new Map();
for (let run = 1; run <= Number(args.runs); run++) {
  const wall = [];
  const by = new Map();
  const made = [];
  try {
    for (let i = 0; i < Number(args.creates); i++) {
      const name = `create-bench-${randomBytes(4).toString('hex')}`;
      const created = await api.raw('POST', '/repos', {
        name,
        visibility: 'private',
        policy: { required_checks: [], approvals: 1 },
        files: [{ path: 'README.md', content_b64: b64(`# ${name}\n`) }],
        author: { name: 'Create bench', email: 'create-bench@yonedarepo.invalid' },
      });
      if (!created.ok) {
        const code = created.body?.error?.code ?? String(created.status);
        refused.set(code, (refused.get(code) ?? 0) + 1);
        continue;
      }
      made.push({ id: created.body.id, name });
      wall.push(created.ms);
      for (const [phase, ms] of phases(created.headers)) by.set(phase, [...(by.get(phase) ?? []), ms]);
    }
  } finally {
    for (const { id, name } of made) await api.raw('DELETE', `/repos/${id}?confirm=${name}`);
  }
  console.log(`\nrun ${run}`);
  line('create (client)', wall);
  for (const [phase, values] of by) {
    line(phase, values);
    everything.by.set(phase, [...(everything.by.get(phase) ?? []), ...values]);
  }
  everything.wall.push(...wall);
}
console.log('\nall runs');
line('create (client)', everything.wall);
for (const [phase, values] of everything.by) line(phase, values);
console.log(`refused: ${refused.size ? JSON.stringify(Object.fromEntries(refused)) : 'none'}`);
