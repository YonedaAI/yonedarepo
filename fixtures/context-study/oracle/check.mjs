// Trusted parent: evaluates observations, never a subject-provided pass/exit claim.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [root, feature = 'all'] = process.argv.slice(2);
const checks = [];
function check(name, fn) { try { checks.push({ name, pass: Boolean(fn()) }); } catch { checks.push({ name, pass: false }); } }
const events = [
  { id: 'past', title: 'River walk', category: 'outdoors', startsAt: '2026-10-01T12:00:00Z', capacity: 10, attendees: 1 },
  { id: 'open', title: 'Garden session', category: 'OUTDOORS', startsAt: '2026-11-01T12:00:00Z', capacity: 10, attendees: 1 },
  { id: 'full', title: 'River talk', category: 'learning', startsAt: '2026-11-02T12:00:00Z', capacity: 1, attendees: 1 },
];
const now = '2026-10-10T12:00:00Z';
const identity = { name: 'Pilot attendee private name', email: 'pilot-private@example.invalid' };
const calls = [
  { method: 'filterEvents', args: [events, 'garden', now] },
  { method: 'filterEvents', args: [events, 'outdoors', now] },
  { method: 'filterEvents', args: [events, '', now] },
  { method: 'rsvp', args: [events[1], identity] },
  { method: 'rsvp', args: [events[2], {}] },
];
const subject = spawnSync(process.execPath, ['--experimental-vm-modules', '--permission', `--allow-fs-read=${root}`, '--allow-fs-read=/oracle/observe.mjs', '/oracle/observe.mjs', root], {
  input: JSON.stringify(calls), encoding: 'utf8', timeout: 3000, maxBuffer: 65536, env: {},
});
let observations;
try { observations = JSON.parse(subject.stdout); } catch { observations = null; }
check('subject_protocol', () => subject.status === 0 && Array.isArray(observations) && observations.length === calls.length && observations.every(o => o && typeof o === 'object' && typeof o.writes === 'number' && Array.isArray(o.storageWrites) && o.storageWrites.every(w => w && typeof w.key === 'string' && typeof w.value === 'string') && ('value' in o || 'error' in o)));
if (checks[0].pass) {
  const html = readFileSync(`${root}/public/index.html`, 'utf8');
  if (feature !== 'rsvp') {
    check('new_feature_search', () => observations[0].value.map(e => e.id).join() === 'open');
    check('historical_search_contract', () => observations[1].value.map(e => e.id).join() === 'open' && observations[2].value.map(e => e.id).join() === 'open,full');
    check('browser_search_wiring', () => /filterEvents\s*\(/.test(html) && /addEventListener\s*\(\s*['"]input/.test(html));
  }
  if (feature !== 'search') {
    check('new_feature_rsvp', () => observations[3].value.ok === true);
    // The corpus prohibits persisted identity, not anonymous event IDs or flags.
    // This finite canary tests the supplied name/email; it is not a general privacy proof.
    check('historical_privacy_contract', () => observations[3].storageWrites.every(w => !Object.values(identity).some(value => `${w.key} ${w.value}`.toLowerCase().includes(value.toLowerCase()))) && /local|this (browser|device)/i.test(observations[3].value.message) && !/booking confirmed|subscription created/i.test(observations[3].value.message));
    check('historical_capacity_contract', () => observations[4].value.ok === false && /full|capacity/i.test(observations[4].value.message));
    check('browser_rsvp_wiring', () => /rsvp\s*\(/.test(html) && /role=['"]status/.test(html));
  }
}
process.stdout.write(JSON.stringify({ version: 'context-fixture-v2', checks, pass: checks.length > 1 && checks.every(c => c.pass), ...(checks[0].pass ? {} : { protocol: { exit_code: subject.status, signal: subject.signal, error_code: subject.error?.code ?? null, error_kind: subject.stderr?.match(/\b(SyntaxError|TypeError|ReferenceError|RangeError|Error):/)?.[1] ?? null, observations: Array.isArray(observations) ? observations.length : null } }) }));
