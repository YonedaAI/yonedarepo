// Codex CLI, opencode and MiMo Code events into the activity log, from recorded CLI output.
import { describe, expect, it } from 'vitest';
import {
  parseActivity,
  parseActivityLines,
  resultOutcome,
  sessionId,
} from '../../cloudflare/worker/sandbox-activity';
import * as samples from './sandbox-cli-samples';

const outcome = (lines: string[]) =>
  lines.reduce((last, line) => resultOutcome(line) ?? last, null as ReturnType<typeof resultOutcome>);
const session = (lines: string[]) => lines.map(sessionId).find(Boolean) ?? null;

describe('Codex CLI --json activity', () => {
  it('turns a thread into a start, its commands, edits, message and token usage', () => {
    expect(parseActivityLines(samples.codex)).toEqual([
      { kind: 'init', text: 'Agent started (Codex CLI)' },
      { kind: 'tool', text: "bash /bin/bash -lc 'echo hello > /workspace/repo/hello.txt'" },
      { kind: 'text', text: 'Created hello.txt.' },
      { kind: 'result', text: 'Agent finished (300 input / 66 output tokens)' },
    ]);
    expect(parseActivityLines(samples.codexPatch)).toEqual([
      { kind: 'tool', text: 'edit add /workspace/repo/notes.md' },
    ]);
    expect(outcome(samples.codex)).toEqual({ ok: true, result: '' });
    expect(session(samples.codex)).toBe('01a17b48-ac8c-7dc1-898e-01609af3f934');
  });

  it('reports a failed turn and the error that caused it', () => {
    expect(parseActivityLines(samples.codexFailed).slice(1)).toEqual([
      { kind: 'error', text: 'exceeded retry limit, last status: 429 Too Many Requests' },
      {
        kind: 'result',
        text: 'Agent failed: exceeded retry limit, last status: 429 Too Many Requests',
      },
    ]);
    expect(outcome(samples.codexFailed)).toEqual({
      ok: false,
      error: 'exceeded retry limit, last status: 429 Too Many Requests',
    });
  });

  it('shows a failing command with its exit code and output tail', () => {
    const failed = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'FAIL src/math.test.js',
        exit_code: 1,
        status: 'failed',
      },
    });
    expect(parseActivity(failed)).toEqual([
      { kind: 'tool_error', text: 'exit 1: FAIL src/math.test.js' },
    ]);
  });
});

describe('opencode and MiMo Code --format json activity', () => {
  it('turns steps into text, tool calls and the last step as the result', () => {
    expect(parseActivityLines(samples.opencode)).toEqual([
      { kind: 'text', text: 'I will write hello.txt.' },
      { kind: 'tool', text: 'write /workspace/repo/hello.txt' },
      { kind: 'text', text: 'Created hello.txt.' },
      { kind: 'result', text: 'Agent finished (last step 150 input / 42 output tokens)' },
    ]);
    expect(outcome(samples.opencode)).toEqual({ ok: true, result: '' });
    expect(session(samples.opencode)).toMatch(/^ses_[A-Za-z0-9]+$/);
  });

  it('reports a session error as the failure and a failed tool call', () => {
    const [failure] = parseActivityLines(samples.opencodeFailed);
    expect(failure.kind).toBe('error');
    expect(failure.text).toMatch(/^APIError: Too Many Requests/);
    expect(outcome(samples.opencodeFailed)).toMatchObject({ ok: false });
    expect(parseActivityLines(samples.opencodeToolError)).toEqual([
      { kind: 'tool', text: 'bash' },
      { kind: 'tool_error', text: 'Tool execution aborted' },
    ]);
  });

  it('records a tool call MiMo Code repeats only once', () => {
    expect(samples.mimoRepeatedTool).toHaveLength(3);
    expect(parseActivityLines(samples.mimoRepeatedTool)).toEqual([
      { kind: 'tool', text: 'write /workspace/repo/hello.txt' },
    ]);
  });
});

describe('session ids', () => {
  it('accepts only ids that are safe as one resume argument', () => {
    const line = (id: unknown) => JSON.stringify({ type: 'thread.started', thread_id: id });
    expect(sessionId(line('01a17b48-ac8c-7dc1-898e-01609af3f934'))).toBe(
      '01a17b48-ac8c-7dc1-898e-01609af3f934',
    );
    for (const id of ['--help-me-now', 'a b c d e f g h', 'short', 42, 'x'.repeat(200)])
      expect(sessionId(line(id))).toBeNull();
  });
});
