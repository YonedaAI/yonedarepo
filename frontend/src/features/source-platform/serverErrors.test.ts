// Server faults as people see them: a read the server could not answer (503 OVERLOADED,
// other 5xx, a dropped connection) is retried with backoff before it fails; a write is
// never retried; a failure shows a plain "Couldn't load …" with its reference set apart and
// never the raw platform error (D1_ERROR, internal error).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppSidebar } from '../shell/AppSidebar';
import { Failure } from './SourceStatus';
import { RETRY_DELAYS_MS, SERVER_FAILURE, SourceApiError, sourceApi } from './sourceApi';

const RAW = 'D1_ERROR: internal error; reference = l2hpofb8abc';
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message = RAW) =>
  json(status, { error: { code, message } });

let calls: string[] = [];
const answer = (...responses: (Response | Error)[]) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    const next = responses.shift() ?? json(200, {});
    if (next instanceof Error) throw next;
    return next;
  });
const settle = async <T>(promise: Promise<T>) => {
  const outcome = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
  return outcome as Promise<{ value?: T; error?: SourceApiError }>;
};

beforeEach(() => {
  calls = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reads the server could not answer', () => {
  it('retries a 503 OVERLOADED read and answers once the server does', async () => {
    answer(failure(503, 'OVERLOADED'), failure(503, 'OVERLOADED'), json(200, { repos: [] }));
    expect(await settle(sourceApi('/repos'))).toEqual({ value: { repos: [] } });
    expect(calls).toHaveLength(3);
  });

  it('retries a 5xx read and a dropped connection three times, then fails plainly', async () => {
    answer(
      failure(500, 'D1_ERROR'),
      new TypeError('fetch failed'),
      failure(502, 'BAD'),
      failure(500, 'D1_ERROR'),
    );
    const { error } = await settle(sourceApi('/repos'));
    expect(calls).toHaveLength(1 + RETRY_DELAYS_MS.length);
    expect(error).toBeInstanceOf(SourceApiError);
    expect(error?.message).toBe(`${SERVER_FAILURE} Reference: l2hpofb8abc`);
    expect(error?.message).not.toContain('D1_ERROR');
    expect(error?.status).toBe(500);
  });

  it('shows a full repository in its own words, without retrying', async () => {
    const said = "This repository's database is full";
    answer(failure(507, 'REPO_FULL', said));
    const { error } = await settle(sourceApi('/repos/r0000000000000000000a'));
    expect(calls).toHaveLength(1);
    expect(error?.code).toBe('REPO_FULL');
    expect(error?.message).toBe(said);
  });

  it('never retries a write, nor a request the server refused', async () => {
    answer(failure(503, 'OVERLOADED'));
    const write = await settle(sourceApi('/repos', { body: { name: 'x' } }));
    expect(calls).toEqual(['POST /api/v1/repos']);
    expect(write.error?.message).toBe(`${SERVER_FAILURE} Reference: l2hpofb8abc`);
    calls = [];
    answer(failure(404, 'NOT_FOUND', 'Unknown repository'));
    const missing = await settle(sourceApi('/repos/r0000000000000000000a'));
    expect(calls).toHaveLength(1);
    expect(missing.error?.message).toBe('Unknown repository');
  });
});

describe('failure messages', () => {
  it('says what could not load, with Retry and the reference, never the raw error', () => {
    for (const error of [RAW, `${SERVER_FAILURE} Reference: l2hpofb8abc`]) {
      const html = renderToStaticMarkup(
        createElement(Failure, { error, what: 'your repositories', onRetry: () => {} }),
      );
      expect(html).toContain('Couldn&#x27;t load your repositories.');
      expect(html).toContain('Retry');
      expect(html).toContain('<small class="failure-reference">Reference l2hpofb8abc</small>');
      expect(html).not.toMatch(/D1_ERROR|internal error/);
    }
    // A request the server refused keeps its own words.
    const refused = renderToStaticMarkup(createElement(Failure, { error: 'Unknown repository' }));
    expect(refused).toContain('Unknown repository');
  });

  it('shows the sidebar a plain message and Retry when the repository list fails', () => {
    const html = renderToStaticMarkup(
      createElement(AppSidebar, {
        authenticated: true,
        loading: false,
        route: { view: 'home' },
        rowsError: RAW,
        onRetry: () => {},
      }),
    );
    expect(html).toContain('Couldn&#x27;t load your repositories.');
    expect(html).toContain('>Retry<');
    expect(html).not.toContain('D1_ERROR');
  });
});
