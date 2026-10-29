import { describe, expect, it } from 'vitest';
import {
  anchorText,
  byteLength,
  deliveryCause,
  memoriesPath,
  memoryBody,
  NO_MEMORY_FILTERS,
  parseAnchors,
} from './memoryModel';
import { formatSourceRoute, parseSourceRoute, routeTab, tabRoute } from './sourceRoute';

const repo = 'r0123456789abcdef0123';

describe('memories page', () => {
  it('reads memories with only the filters that are set', () => {
    expect(memoriesPath(repo, NO_MEMORY_FILTERS)).toBe(`/repos/${repo}/memories`);
    expect(memoriesPath(repo, { path: ' src/ ', kind: 'gotcha', status: 'stale' }, 9)).toBe(
      `/repos/${repo}/memories?path=src%2F&kind=gotcha&status=stale&before=9`,
    );
  });

  it('parses typed anchors into files, symbols and directories', () => {
    expect(parseAnchors('src/net.rs#retry, docs/\nREADME.md,,')).toEqual([
      { path: 'src/net.rs', symbol_path: 'retry' },
      { path: 'docs/' },
      { path: 'README.md' },
    ]);
    expect(anchorText({ path: 'src/net.rs', symbol_path: 'retry' })).toBe('src/net.rs#retry');
    expect(anchorText({ path: 'docs/', symbol_path: null })).toBe('docs/');
  });

  it('posts a trimmed memory and supersedes only when asked', () => {
    expect(
      memoryBody({ kind: 'howto', text: ' run it \n', anchors: '', supersedes: null }),
    ).toEqual({ kind: 'howto', text: 'run it', anchors: [] });
    expect(memoryBody({ kind: 'decision', text: 'x', anchors: 'a.rs', supersedes: 4 })).toEqual({
      kind: 'decision',
      text: 'x',
      anchors: [{ path: 'a.rs' }],
      supersedes: 4,
    });
  });

  it('counts the limit in bytes and names what prompted a delivery', () => {
    expect(byteLength('é')).toBe(2);
    expect(deliveryCause({ trigger: 'read', subject: 'src/a.rs' })).toBe('Read src/a.rs');
    expect(deliveryCause({ trigger: 'prompt', subject: 'f'.repeat(64) })).toBe('New prompt');
    expect(deliveryCause({ trigger: 'start', subject: null })).toBe('Session start');
  });

  it('has a stable address under Agents', () => {
    const route = parseSourceRoute(`/source/${repo}/agents/memories`, '');
    expect(route).toEqual({ view: 'agents', repo, section: 'memories' });
    expect(formatSourceRoute(route)).toBe(`/source/${repo}/agents/memories`);
  });
});

describe('the Memories page in the shell', () => {
  it('is its own page in the Repository nav', () => {
    const route = parseSourceRoute(`/source/${repo}/agents/memories`, '');
    expect(routeTab(route)).toBe('memories');
    expect(formatSourceRoute(tabRoute('memories', repo))).toBe(`/source/${repo}/agents/memories`);
  });
});
