// A session's transcript as the server would render it: not recorded, loading, failed,
// empty, and in full (the context packet, prompts, replies, tool calls collapsed and named
// by what they acted on, left-out turns and redactions), inside the session page.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord, StoredTranscript, TranscriptMeta } from './agentModel';
import type { Loaded } from './useSource';

const state: { byPath: Record<string, Loaded<any>>; paths: (string | null)[] } = {
  byPath: {},
  paths: [],
};
vi.mock('./useSource', () => ({
  useSource: (path: string | null) => {
    state.paths.push(path);
    return (path && state.byPath[path]) ?? { loading: false, reload: () => {} };
  },
}));

const { SessionTranscript } = await import('./SessionTranscript');
const { SessionView } = await import('./SessionView');
const { HowSessionsAreRecorded } = await import('./AgentSessions');
const { transcriptNotes, transcriptPath, toolLabel } = await import('./agentModel');

const html = (type: any, props: any) => renderToStaticMarkup(createElement(type, props));
const loaded = (value: Partial<Loaded<any>>): Loaded<any> => ({
  loading: false,
  reload: () => {},
  ...value,
});
const repo = 'r0123456789abcdef0123';
const meta: TranscriptMeta = {
  sha256: 'a'.repeat(64),
  bytes: 2048,
  turns: 4,
  redactions: 1,
  truncated: true,
  context: true,
};
const record = (transcript: TranscriptMeta | null): SessionRecord => ({
  id: 7,
  commit: 'c'.repeat(40),
  cli: 'claude-code',
  model: 'claude-sonnet-5-5',
  summary: 'Added the parser.',
  prompt_digest: null,
  transcript_ref: transcript ? `transcript:sha256:${transcript.sha256}` : null,
  read_set_digest: null,
  session_id: 'claude-code:s1',
  recorded_by: 'token:agent',
  at: 1,
  subject: 'parser',
  reads: 0,
  transcript,
});
const stored: StoredTranscript = {
  session: 7,
  transcript: meta,
  document: {
    format: 'yoneda-transcript/1',
    context: 'YonedaRepo: main at abc1234; 0 approvals required.',
    turns: [
      { kind: 'prompt', text: 'Add a parser for <config> files' },
      { kind: 'omitted', turns: 12 },
      {
        kind: 'tool',
        name: 'Read',
        subject: 'src/parse.rs',
        input: 'file_path: src/parse.rs',
        output: 'fn parse() {}',
      },
      { kind: 'tool', name: 'Bash', subject: 'cargo test', output: '1 failed', error: true },
      { kind: 'reply', text: 'Added the **parser**; tests pass.' },
    ],
    redactions: { 'anthropic-key': 1 },
    truncated: true,
  },
};
const path = transcriptPath(repo, 7);

beforeEach(() => {
  state.byPath = {};
  state.paths = [];
});

describe('session transcript', () => {
  it('says when none was recorded, without reading one', () => {
    const page = html(SessionTranscript, { repo, session: record(null) });
    expect(page).toContain('No transcript was recorded for this session');
    expect(page).toContain('yoneda session record --transcript');
    expect(state.paths).toEqual([null]);
  });

  it('shows loading, then a failure with a retry', () => {
    state.byPath[path] = loaded({ loading: true });
    expect(html(SessionTranscript, { repo, session: record(meta) })).toContain(
      'Loading the transcript',
    );
    expect(state.paths).toEqual([path]);
    state.byPath[path] = loaded({ error: 'Session 7&#x27;s transcript is missing from storage' });
    const failed = html(SessionTranscript, { repo, session: record(meta) });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Retry');
  });

  it('says when the stored transcript is empty', () => {
    state.byPath[path] = loaded({
      data: { ...stored, document: { ...stored.document, context: null, turns: [] } },
    });
    expect(html(SessionTranscript, { repo, session: record(meta) })).toContain(
      'The transcript is empty.',
    );
  });

  it('renders the context, prompts, collapsed tool calls and replies in order', () => {
    state.byPath[path] = loaded({ data: stored });
    const page = html(SessionTranscript, { repo, session: record(meta) });
    expect(page).toContain('Context given at session start');
    expect(page).toContain('YonedaRepo: main at abc1234; 0 approvals required.');
    // Text is text: markup in a prompt is escaped.
    expect(page).toContain('Add a parser for &lt;config&gt; files');
    expect(page).toContain('12 turns left out');
    // Tool calls are collapsed, named by tool and what they acted on, failures marked.
    expect(page).not.toMatch(/<details[^>]* open/);
    expect(page).toMatch(/<summary[^>]*>.*Read.*src\/parse\.rs/);
    expect(page).toContain('fn parse() {}');
    expect(page).toMatch(/Bash.*cargo test.*failed/);
    expect(page).toContain('<strong>parser</strong>');
    expect(page.indexOf('Add a parser')).toBeLessThan(page.indexOf('src/parse.rs'));
    expect(page.indexOf('src/parse.rs')).toBeLessThan(page.indexOf('tests pass'));
    expect(page).toContain('1 credential redacted before storing');
  });

  it('notes redactions and cuts in words', () => {
    expect(transcriptNotes({ ...meta, redactions: 0, truncated: false })).toEqual([]);
    expect(transcriptNotes({ ...meta, redactions: 3, truncated: false })).toEqual([
      '3 credentials redacted before storing.',
    ]);
    expect(transcriptNotes(meta)[1]).toMatch(/1 MiB/);
    expect(toolLabel({ kind: 'tool', name: 'Bash' })).toBe('Bash');
    expect(toolLabel({ kind: 'tool', name: 'Read', subject: 'a.rs' })).toBe('Read · a.rs');
  });

  it('is part of the session page, which no longer says transcripts stay off the platform', () => {
    state.byPath[`/repos/${repo}/sessions/7`] = loaded({
      data: {
        session: record(meta),
        commit: { id: 'c'.repeat(40), message: 'parser', principal: 'token:agent', parents: [] },
        reads: [],
        reads_truncated: false,
        related: [],
      },
    });
    state.byPath[path] = loaded({ data: stored });
    const page = html(SessionView, { repo, id: 7, navigate: () => {} });
    expect(page).toContain('id="session-transcript-heading"');
    expect(page).toContain('Stored on the platform · 4 turns');
    expect(page).toContain('src/parse.rs');
    expect(html(HowSessionsAreRecorded, {})).not.toContain('never the transcript');
  });
});
