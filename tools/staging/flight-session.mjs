// The script of a flight (items 43 and 44): its file, its words, and what the pilot's Claude Code
// session does through the real `yoneda hook claude-*`.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hook } from './agent-hooks-flow.mjs';
import { pilotEnv } from './flight-kit.mjs';

export const FILE = 'src/net.ts';
export const BRANCH = 'flight/retry';
export const GOAL = 'Stop retry() running past the gateway limit';
export const MEMORY = 'Kit flight memory: the gateway drops a connection after 3 tries, so retry() must stop at 3.';
export const SUMMARY = 'Kit flight session: retry() now stops at 3 tries.';
export const FIRST_MESSAGE = 'First go: retry stops at 3 tries';
const LINES = Array.from({ length: 24 }, (_, i) => `export const line${i} = ${i};`);
/** The file with these lines replaced; the same file for lines of every other leg. */
export const net = (edits = {}) => `${LINES.map((line, i) => edits[i] ?? line).join('\n')}\n`;
export const FIX_LINE = 4;
/** What the Landing that moves main and the other pilot's Landing each change. */
export const MOVED = { 20: 'export const moved = true;' };
export const OTHER = { 12: 'export const timeout = 30;' };

/** The hook's added context, from its JSON. */
export const injected = (ran) => JSON.parse(ran.stdout || '{}').hookSpecificOutput?.additionalContext ?? '';

/** A transcript file, in the shape Claude Code leaves one. */
export function transcriptOf(kit, name, prompt, reply) {
  const path = kit.path(name);
  const turns = [
    { type: 'user', message: { role: 'user', content: prompt } },
    { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: reply }] } },
  ];
  writeFileSync(path, turns.map((t) => JSON.stringify(t)).join('\n'));
  return path;
}

/** One session's read of `path`, as Claude Code's hook reports it; answers what it was told. */
export async function readFile(f, session, path) {
  const payload = { session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(f.dir, path) }, tool_response: {}, cwd: f.dir };
  const ran = await hook(f.kit, 'claude-read', payload, pilotEnv(f.kit, f.crew.pilot));
  assert.equal(ran.code, 0, ran.stderr);
  return injected(ran);
}

/** The end of a session's turn: its record on what it pushed, with the transcript. */
export async function stopSession(f, session, prompt, reply) {
  const transcript = transcriptOf(f.kit, `${session}.jsonl`, prompt, reply);
  const stopped = await hook(f.kit, 'claude-stop', { session_id: session, cwd: f.dir, transcript_path: transcript, hook_event_name: 'Stop' }, pilotEnv(f.kit, f.crew.pilot));
  assert.equal(stopped.code, 0, stopped.stderr);
}
