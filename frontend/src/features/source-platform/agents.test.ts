import { describe, expect, it } from 'vitest';
import {
  appendPage,
  type ContractRecord,
  groupContracts,
  groupSessions,
  NO_FILTERS,
  recorder,
  type SessionRecord,
  sessionsPath,
  transcriptUrl,
} from './agentModel';
import { formatSourceRoute, parseSourceRoute, routeTab } from './sourceRoute';

const repo = 'r0123456789abcdef0123';

describe('agent pages', () => {
  it('reads sessions with only the filters that are set', () => {
    expect(sessionsPath(repo, NO_FILTERS)).toBe(`/repos/${repo}/sessions`);
    expect(sessionsPath(repo, { cli: 'opencode', model: ' ', ref: 'feat/x' }, 42)).toBe(
      `/repos/${repo}/sessions?cli=opencode&ref=feat%2Fx&before=42`,
    );
  });

  it('links only web transcripts', () => {
    expect(transcriptUrl('https://example.com/t/1')).toBe('https://example.com/t/1');
    expect(transcriptUrl('claude-code:3f2a')).toBeNull();
    expect(transcriptUrl('javascript:alert(1)')).toBeNull();
    expect(transcriptUrl(null)).toBeNull();
  });

  it('names who recorded a session', () => {
    expect(recorder('user:alice')).toBe('alice');
    expect(recorder('token:agent')).toBe('agent (token)');
    expect(recorder('admin')).toBe('admin');
  });

  it('groups contract records per symbol, newest first', () => {
    const record = (seq: number, path: string, symbol: string): ContractRecord => ({
      seq,
      path,
      symbol_path: symbol,
      commit: 'c'.repeat(40),
      node_digest: 'd'.repeat(64),
      contract: { summary: `#${seq}` },
      recorded_by: 'token:agent',
      recorded_at: seq,
      recorded_version: seq,
    });
    const groups = groupContracts([
      record(1, 'src/a.rs', 'a'),
      record(2, 'src/b.rs', 'b'),
      record(3, 'src/a.rs', 'a'),
    ]);
    expect(groups.map((g) => [g.path, g.symbol, g.records.map((r) => r.seq)])).toEqual([
      ['src/a.rs', 'a', [3, 1]],
      ['src/b.rs', 'b', [2]],
    ]);
  });

  it('groups records into the sessions that produced them', () => {
    const record = (id: number, transcript: string | null): SessionRecord => ({
      id,
      commit: String(id).repeat(40).slice(0, 40),
      cli: 'claude-code',
      model: null,
      summary: `#${id}`,
      prompt_digest: null,
      transcript_ref: transcript,
      read_set_digest: null,
      recorded_by: 'token:agent',
      at: id,
      subject: 'change',
      reads: 0,
    });
    const groups = groupSessions([
      record(4, 'claude-code:a'),
      record(3, null),
      record(2, 'claude-code:a'),
      record(1, null),
    ]);
    expect(groups.map((g) => [g.key, g.latest.id, g.records.map((r) => r.id)])).toEqual([
      ['claude-code:a', 4, [4, 2]],
      ['#3', 3, [3]],
      ['#1', 1, [1]],
    ]);
  });

  it('appends a page without repeating rows', () => {
    expect(appendPage([{ id: 3 }, { id: 2 }], [{ id: 2 }, { id: 1 }], (r) => r.id)).toEqual([
      { id: 3 },
      { id: 2 },
      { id: 1 },
    ]);
  });

  it('addresses every agent page and keeps them under the Agents tab', () => {
    for (const route of [
      { view: 'agents', repo, section: 'sessions' },
      { view: 'agents', repo, section: 'contracts' },
      { view: 'agents', repo, section: 'pins' },
      { view: 'agents', repo, section: 'bisects' },
      { view: 'session', repo, id: 7 },
    ] as const) {
      const url = formatSourceRoute(route);
      expect(parseSourceRoute(url, '')).toEqual(route);
      expect(routeTab(route)).toBe('agents');
    }
    expect(formatSourceRoute({ view: 'agents', repo, section: 'sessions' })).toBe(
      `/source/${repo}/agents`,
    );
    expect(parseSourceRoute(`/source/${repo}/agents/sessions/x`, '')).toEqual({
      view: 'agents',
      repo,
      section: 'sessions',
    });
    expect(parseSourceRoute(`/source/${repo}/agents/nope`, '')).toEqual({
      view: 'agents',
      repo,
      section: 'sessions',
    });
  });
});
