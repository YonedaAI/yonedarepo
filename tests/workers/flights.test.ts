import { afterEach, expect, it, vi } from 'vitest';
import { Flights } from '../../cloudflare/worker/flights';
import { currentScope, inScope } from '../../cloudflare/worker/request-scope';

afterEach(() => vi.useRealTimers());
const request = <T>(run: () => T) => inScope({ req: new Request('https://yoneda/api/v1/repos') }, run);

it('joins unfinished work within one request and starts afresh once it settles', () => request(async () => {
  const flights = new Flights<number>();
  let calls = 0;
  const load = async () => ++calls;
  const first = flights.join('k', load);
  const second = flights.join('k', load);
  expect([first.joined, second.joined]).toEqual([false, true]);
  expect(await second.work).toBe(1);
  expect(await flights.join('k', load).work).toBe(2);
}));

it('late cleanup from stale work cannot remove its replacement in the same request', () => request(async () => {
  vi.useFakeTimers();
  const flights = new Flights<string>();
  let releaseOld!: (value: string) => void;
  let releaseFresh!: (value: string) => void;
  const old = flights.join('k', () => new Promise<string>((resolve) => { releaseOld = resolve; }));
  expect(flights.join('k', async () => 'second').joined).toBe(true);
  vi.advanceTimersByTime(31_000);
  const fresh = flights.join('k', () => new Promise<string>((resolve) => { releaseFresh = resolve; }));
  expect(fresh.joined).toBe(false);
  releaseOld('old');
  await old.work;
  expect(flights.join('k', async () => 'must not replace fresh').joined).toBe(true);
  releaseFresh('fresh');
  expect(await fresh.work).toBe('fresh');
}));

it('a failure reaches those who joined, and the next caller tries again', () => request(async () => {
  const flights = new Flights<string>();
  const first = flights.join('k', () => Promise.reject(new Error('no')));
  const second = flights.join('k', async () => 'must join');
  expect(second.joined).toBe(true);
  await expect(first.work).rejects.toThrow('no');
  await expect(second.work).rejects.toThrow('no');
  expect(await flights.join('k', async () => 'ok').work).toBe('ok');
}));

it('a held load in one request cannot hold another request using the same key', async () => {
  const flights = new Flights<string>();
  let release!: (value: string) => void;
  const old = request(() => flights.join('k', () => new Promise<string>((resolve) => { release = resolve; })));
  try {
    const fresh = request(() => flights.join('k', async () => 'independent'));
    expect(fresh.joined).toBe(false);
    expect(await fresh.work).toBe('independent');
  } finally {
    release('old');
    await old.work;
  }
});

it('calls without a request scope do not share pending work', async () => {
  expect(currentScope()).toBeUndefined();
  const flights = new Flights<string>();
  let release!: (value: string) => void;
  const old = flights.join('k', () => new Promise<string>((resolve) => { release = resolve; }));
  try {
    const fresh = flights.join('k', async () => 'independent');
    expect(fresh.joined).toBe(false);
    expect(await fresh.work).toBe('independent');
  } finally {
    release('old');
    await old.work;
  }
});

it('explicit durable ownership shares work across requests and retains it until settled', async () => {
  const retained: Promise<unknown>[] = [];
  const owner = { waitUntil: (work: Promise<unknown>) => { retained.push(work); } };
  const flights = new Flights<string>(owner);
  let release!: (value: string) => void;
  const first = request(() => flights.join('k', () => new Promise<string>((resolve) => { release = resolve; })));
  const second = request(() => flights.join('k', async () => 'duplicate'));
  try {
    expect(second.joined).toBe(true);
    expect(retained).toHaveLength(1);
    const other = new Flights<string>({ waitUntil: () => {} });
    expect(await request(() => other.join('k', async () => 'separate object')).work).toBe('separate object');
  } finally {
    release('held');
    expect(await second.work).toBe('held');
    await Promise.all(retained);
  }
  expect(await request(() => flights.join('k', async () => 'fresh')).work).toBe('fresh');
});

it('durable work keeps stale replacement and retry semantics across caller scopes', async () => {
  vi.useFakeTimers();
  const retained: Promise<unknown>[] = [];
  const flights = new Flights<string>({ waitUntil: (work) => { retained.push(work); } });
  let releaseOld!: (value: string) => void;
  let releaseFresh!: (value: string) => void;
  const old = request(() => flights.join('k', () => new Promise<string>((resolve) => { releaseOld = resolve; })));
  vi.advanceTimersByTime(31_000);
  const fresh = request(() => flights.join('k', () => new Promise<string>((resolve) => { releaseFresh = resolve; })));
  expect(fresh.joined).toBe(false);
  releaseOld('old');
  await old.work;
  expect(request(() => flights.join('k', async () => 'duplicate')).joined).toBe(true);
  releaseFresh('fresh');
  expect(await fresh.work).toBe('fresh');
  const failed = request(() => flights.join('k', async () => { throw new Error('retry'); }));
  const joined = request(() => flights.join('k', async () => 'must join'));
  await expect(failed.work).rejects.toThrow('retry');
  await expect(joined.work).rejects.toThrow('retry');
  expect(await request(() => flights.join('k', async () => 'recovered')).work).toBe('recovered');
  await Promise.all(retained);
});
