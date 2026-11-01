// After a landing, the browser's reads of main name the landed version, so a read served from
// a copy of main that predates the landing waits for it instead of missing the new file.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceApi } from './sourceApi';

const asked: { url: string; method: string }[] = [];
let answers: Record<string, { status?: number; body: unknown }> = {};
let repoNumber = 0;
const repoId = () => {
  repoNumber += 1;
  return `r${String(repoNumber).padStart(20, '0')}`;
};

beforeEach(() => {
  asked.length = 0;
  answers = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    asked.push({ url, method: String(init.method) });
    const answer = answers[url.replace('/api/v1', '').split('?')[0]];
    return new Response(JSON.stringify(answer?.body ?? {}), { status: answer?.status ?? 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const land = (repo: string, version: unknown) => {
  answers[`/repos/${repo}/land`] = { body: { landed: true, version } };
  return sourceApi(`/repos/${repo}/land`, { body: { ref: 'main', commit: 'c' } });
};
const landAgain = (repo: string) =>
  sourceApi(`/repos/${repo}/land`, { body: { ref: 'main', commit: 'c' } });
const lastUrl = () => asked[asked.length - 1].url;

describe('reads after a landing', () => {
  it('names the landed version on the reads main’s published head answers', async () => {
    const repo = repoId();
    await land(repo, 7);
    await sourceApi(`/repos/${repo}/tree?path=&ref=main`);
    expect(lastUrl()).toBe(`/api/v1/repos/${repo}/tree?path=&ref=main&min_version=7`);
    await sourceApi(`/repos/${repo}/blob?path=README.md&ref=main`);
    expect(lastUrl()).toBe(`/api/v1/repos/${repo}/blob?path=README.md&ref=main&min_version=7`);
    await sourceApi(`/repos/${repo}/refs`);
    expect(lastUrl()).toBe(`/api/v1/repos/${repo}/refs?min_version=7`);
  });

  it('leaves alone a read that is not of main now', async () => {
    const repo = repoId();
    await land(repo, 7);
    for (const path of [
      `/repos/${repo}/tree?path=&ref=main&at=3`,
      `/repos/${repo}/tree?path=&ref=topic`,
      `/repos/${repo}/blob?path=a&commit=abc`,
      `/repos/${repo}/refs?min_version=9`,
      `/repos/${repo}`,
      `/repos/${repo}/log?limit=30`,
    ]) {
      await sourceApi(path);
      expect(lastUrl()).toBe(`/api/v1${path}`);
    }
  });

  it('asks nothing of a repository with no landing here', async () => {
    const landed = repoId();
    const other = repoId();
    await land(landed, 7);
    await sourceApi(`/repos/${other}/tree?path=&ref=main`);
    expect(lastUrl()).toBe(`/api/v1/repos/${other}/tree?path=&ref=main`);
  });

  it('keeps the newest landing, and ignores an answer with no version', async () => {
    const repo = repoId();
    await land(repo, 7);
    await land(repo, 4);
    await land(repo, undefined);
    await sourceApi(`/repos/${repo}/refs`);
    expect(lastUrl()).toBe(`/api/v1/repos/${repo}/refs?min_version=7`);
  });

  it('takes nothing from a landing that was refused', async () => {
    const repo = repoId();
    answers[`/repos/${repo}/land`] = {
      status: 409,
      body: { version: 7, error: { code: 'CONFLICT', message: 'No' } },
    };
    await expect(landAgain(repo)).rejects.toThrow('No');
    await sourceApi(`/repos/${repo}/refs`);
    expect(lastUrl()).toBe(`/api/v1/repos/${repo}/refs`);
  });

  it('counts a landing it reads about, as when the platform landed it', async () => {
    const repo = repoId();
    answers[`/repos/${repo}/changes/3`] = { body: { number: 3, landed_version: 12 } };
    await sourceApi(`/repos/${repo}/changes/3`);
    await sourceApi(`/repos/${repo}/tree?path=src&ref=main`);
    expect(lastUrl()).toBe(`/api/v1/repos/${repo}/tree?path=src&ref=main&min_version=12`);
  });

  it('reads again when main has not reached the version yet', async () => {
    vi.useFakeTimers();
    const repo = repoId();
    await land(repo, 7);
    let tries = 0;
    vi.stubGlobal('fetch', async () => {
      tries += 1;
      return tries === 1
        ? new Response(
            JSON.stringify({ error: { code: 'STALE_READ', message: 'main has not reached' } }),
            { status: 409 },
          )
        : new Response(JSON.stringify({ entries: [] }));
    });
    const read = sourceApi(`/repos/${repo}/tree?path=&ref=main`);
    await vi.runAllTimersAsync();
    await expect(read).resolves.toEqual({ entries: [] });
    expect(tries).toBe(2);
    vi.useRealTimers();
  });
});
