// A Landing held in line for as long as an item needs it. A queued landing lasts a moment, so a
// test of what waits behind one would be a race. With automation paused the merger can't claim
// tickets, while the owner can still ask to land: a commit whose base moved then sits pending, and
// CTC's separation can be read at leisure. Cancelling the ticket and resuming puts things back.
// The line is on another base than main, whose landings batch with no ticket at all.
import assert from 'node:assert/strict';
import { NO_SESSION } from './agent-hooks-flow.mjs';
import { pushWork, refusal, settled } from './feature-kit.mjs';

const SHARED = 'src/shared.ts';
/** What the Landing in line writes and the one behind read. The base never moves on it: a read
 * the base had changed would send that Landing around, not hold it. */
export const READ = 'src/read.ts';
export const LINE_BASE = 'kit-line';
const LINES = Array.from({ length: 12 }, (_, i) => `export const line${i} = ${i};`);
const edited = (at, value) => `${LINES.map((line, i) => (i === at ? `export const line${i} = ${value};` : line)).join('\n')}\n`;
/** The repository's seed: the file both ends of a three-way merge change. */
export const LINE_FILES = { [SHARED]: `${LINES.join('\n')}\n`, [READ]: 'export const read = 1;\n' };

/** A Landing `dir` pushes that read `path`, declared by its push; answers `{ number, head }`. */
export async function readerOf(kit, repo, dir, { branch, title, path = READ }) {
  const env = kit.env(NO_SESSION);
  await kit.ok('git', ['fetch', '-q', 'origin'], { cwd: dir, env });
  await kit.gitOk(dir, 'switch', '-q', '-C', branch, 'origin/main');
  await kit.yonedaOk(['reads', 'add', path], { cwd: dir, env });
  const head = await pushWork(kit, dir, { branch, from: null, message: title, files: { 'src/reader.ts': 'export const reader = 1;\n' } });
  assert.deepEqual((await kit.pat().get(repo.path(`/commits/${head}`))).read_set, [path], 'the push declared the read');
  const { number } = await kit.pat().post(repo.path('/changes'), { branch, title, base: LINE_BASE });
  return { number, head };
}

/** The base the line forms on, at main's head. Before `readerOf`, which proposes for it. */
export async function lineBase(kit, dir) {
  const env = kit.env(NO_SESSION);
  await kit.gitOk(dir, 'switch', '-q', '-C', LINE_BASE, 'origin/main');
  await kit.ok('git', ['push', '-q', 'origin', `HEAD:refs/heads/${LINE_BASE}`], { cwd: dir, env });
}

export const glass = async (kit, repo, body) => {
  const done = await kit.platformAccount.raw('POST', repo.path('/break-glass'), { reason: 'Kit: a ticket held in line', ...body });
  assert.ok(done.ok, `break-glass ${body.action}: ${refusal(done)}`);
};

/**
 * Puts a Landing writing `READ` in line on `repo`'s line base, the approval `reviewer`
 * gives included. Answers `{ front, ticket, release }`; `release()` cancels the ticket and
 * resumes automation.
 */
export async function lineUp(kit, repo, dir, reviewer) {
  const api = kit.pat();
  const from = `origin/${LINE_BASE}`;
  const head = await pushWork(kit, dir, { branch: 'kit/front', from, message: 'Front of the line', files: { [SHARED]: edited(0, 'front'), [READ]: 'export const read = 2;\n' } });
  const { number } = await api.post(repo.path('/changes'), { branch: 'kit/front', title: 'Front of the line', base: LINE_BASE });
  const front = { number, head };
  // Another line of the same file: disjoint files would land at once, with no ticket.
  const moved = await pushWork(kit, dir, { branch: 'kit/moved', from, message: 'The base moves', files: { [SHARED]: edited(11, 'moved') } });
  await reviewer.session.post(repo.path(`/commits/${head}/reviews`), { decision: 'approve' });
  const direct = await api.raw('POST', repo.path('/land'), { ref: LINE_BASE, commit: moved });
  assert.ok(direct.ok, `moving the base: ${refusal(direct)}`);

  await glass(kit, repo, { action: 'pause_automation' });
  // It answers when its ticket settles, which is what the pause stops.
  let answered = null;
  const landing = kit.platformAccount.raw('POST', repo.path('/land'), { ref: LINE_BASE, commit: head }).then((done) => (answered = done));
  const ticket = await settled(async () => {
    assert.ok(!answered, `the landing answered instead of waiting: ${answered && `${refusal(answered)} ${JSON.stringify(answered.body).slice(0, 200)}`}`);
    const { landings } = await api.get(repo.path('/ctc'));
    return landings.find((l) => l.number === front.number)?.place?.ticket;
  }, 'the Landing to hold a ticket in line', 20_000);
  const release = async () => {
    await glass(kit, repo, { action: 'release_land_lease', ref: LINE_BASE, expected_epoch: null, cancel_pending: true });
    await glass(kit, repo, { action: 'resume_automation' });
    return landing;
  };
  return { front, ticket, release };
}
