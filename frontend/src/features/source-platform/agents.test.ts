import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type AgentSection,
  appendPage,
  type ContractRecord,
  changeSessionsPath,
  fetchEfficiency,
  groupByCommit,
  groupContracts,
  groupSessions,
  NO_FILTERS,
  recorder,
  type SessionRecord,
  sessionsPath,
  summaryText,
  transcriptUrl,
} from './agentModel';
import { RepoAgents } from './RepoAgents';
import { formatSourceRoute, parseSourceRoute, routeTab } from './sourceRoute';

const repo = 'r0123456789abcdef0123';

describe('agent pages', () => {
  it('shows a marker in place of a quarantined summary', () => {
    expect(summaryText({ summary: 'renamed a to b' })).toBe('renamed a to b');
    expect(summaryText({ summary: null, quarantined: true })).toBe(
      'Withheld by the repository owner (quarantined).',
    );
  });

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

  it('shows what a session fetched against what it read', () => {
    expect(fetchEfficiency({ fetched_bytes: 440_402, read_bytes: 104_858 })).toBe(
      'fetched 0.42 of 0.10 MiB read (4.2×)',
    );
    expect(fetchEfficiency({ fetched_bytes: 3 * 1024 * 1024, read_bytes: 0 })).toBe(
      'fetched 3.0 of 0.00 MiB read',
    );
    expect(fetchEfficiency({ fetched_bytes: null, read_bytes: 7 })).toBeNull();
    expect(fetchEfficiency({})).toBeNull();
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
    const record = (
      id: number,
      transcript: string | null,
      session: string | null = null,
    ): SessionRecord => ({
      id,
      commit: String(id).repeat(40).slice(0, 40),
      cli: 'claude-code',
      model: null,
      summary: `#${id}`,
      prompt_digest: null,
      transcript_ref: transcript,
      read_set_digest: null,
      session_id: session,
      recorded_by: 'token:agent',
      at: id,
      subject: 'change',
      reads: 0,
      transcript: null,
    });
    const groups = groupSessions([
      record(6, 'shared', 'opencode:x'),
      record(5, 'shared', 'opencode:y'),
      record(4, 'claude-code:a'),
      record(3, null),
      record(2, 'claude-code:a'),
      record(1, null),
      record(0, 'other', 'opencode:x'),
    ]);
    // The session id decides; older records without one group by transcript reference.
    expect(groups.map((g) => [g.key, g.latest.id, g.records.map((r) => r.id)])).toEqual([
      ['opencode:x', 6, [6, 0]],
      ['opencode:y', 5, [5]],
      ['claude-code:a', 4, [4, 2]],
      ['#3', 3, [3]],
      ['#1', 1, [1]],
    ]);
  });

  it('groups records by commit, the commit of the newest record first', () => {
    const record = (id: number, commit: string) =>
      ({ id, commit, subject: `s${commit}` }) as SessionRecord;
    const groups = groupByCommit([record(5, 'b'), record(4, 'a'), record(3, 'b')]);
    expect(groups.map((g) => [g.commit, g.subject, g.records.map((r) => r.id)])).toEqual([
      ['b', 'sb', [5, 3]],
      ['a', 'sa', [4]],
    ]);
    expect(changeSessionsPath(repo, 'h', null)).toBe(`/repos/${repo}/sessions?head=h&limit=200`);
  });

  it('appends a page without repeating rows', () => {
    expect(appendPage([{ id: 3 }, { id: 2 }], [{ id: 2 }, { id: 1 }], (r) => r.id)).toEqual([
      { id: 3 },
      { id: 2 },
      { id: 1 },
    ]);
  });

  it('addresses every agent page: Sessions, Memories, and the rest under Agent tools', () => {
    for (const route of [
      { view: 'agents', repo, section: 'sessions' },
      { view: 'agents', repo, section: 'memories' },
      { view: 'agents', repo, section: 'contracts' },
      { view: 'agents', repo, section: 'pins' },
      { view: 'agents', repo, section: 'bisects' },
      { view: 'session', repo, id: 7 },
    ] as const) {
      const url = formatSourceRoute(route);
      expect(parseSourceRoute(url, '')).toEqual(route);
      // Sessions and Memories have their own sidebar pages; the rest are Agent tools.
      expect(routeTab(route)).toBe(
        route.view === 'session' || route.section === 'sessions'
          ? 'sessions'
          : route.section === 'memories'
            ? 'memories'
            : 'agents',
      );
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

describe('agent tool tabs', () => {
  const render = (section: AgentSection) =>
    renderToStaticMarkup(
      createElement(RepoAgents, { repo, section, branches: [], navigate: () => {} }),
    );

  it('offer only the agent tools, in plain words, with the API slugs in the address', () => {
    const html = render('pins');
    const tabs = [...html.matchAll(/href="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]);
    expect(tabs).toEqual([
      [`/source/${repo}/agents/contracts`, 'Contracts'],
      [`/source/${repo}/agents/pins`, 'Kept commits'],
      [`/source/${repo}/agents/bisects`, 'Find a breaking commit'],
    ]);
    expect(html).toContain('aria-label="Agent tools"');
    expect(html).toMatch(/aria-current="page" href="[^"]+\/pins"/);
  });

  it('leave Sessions and Memories to their own sidebar pages, with no tab row', () => {
    for (const section of ['sessions', 'memories'] as const) {
      const html = render(section);
      expect(html).not.toContain('aria-label="Agent tools"');
      expect(html).not.toContain(`href="/source/${repo}/agents/contracts"`);
    }
  });
});
