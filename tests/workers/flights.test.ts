import { afterEach, expect, it, vi } from 'vitest';
import { Flights } from '../../cloudflare/worker/flights';

afterEach(() => vi.useRealTimers());

it('joins work in flight, and starts afresh once it settles', async () => {
  const flights = new Flights<number>();
  let calls = 0;
  const load = async () => ++calls;
  const first = flights.join('k', load);
  const second = flights.join('k', load);
  expect([first.joined, second.joined]).toEqual([false, true]);
  expect(await second.work).toBe(1);
  expect(await flights.join('k', load).work).toBe(2);
});

it('does not wait on work a cancelled request left unsettled', async () => {
  vi.useFakeTimers();
  const flights = new Flights<string>();
  flights.join('k', () => new Promise(() => {}));
  expect(flights.join('k', async () => 'second').joined).toBe(true);
  vi.advanceTimersByTime(31_000);
  const fresh = flights.join('k', async () => 'fresh');
  expect(fresh.joined).toBe(false);
  expect(await fresh.work).toBe('fresh');
});

it('a failure reaches those who joined, and the next caller tries again', async () => {
  const flights = new Flights<string>();
  await expect(flights.join('k', () => Promise.reject(new Error('no'))).work).rejects.toThrow('no');
  expect(await flights.join('k', async () => 'ok').work).toBe('ok');
});
