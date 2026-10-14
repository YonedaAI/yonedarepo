import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coalesceRefresh } from './refreshCoalescer';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('live refresh coalescing', () => {
  it('turns a resync burst into one refresh now and one trailing refresh', async () => {
    let active = 0;
    let overlapped = false;
    let finish = () => {};
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          active += 1;
          overlapped ||= active > 1;
          finish = () => {
            active -= 1;
            resolve();
          };
        }),
    );
    const live = coalesceRefresh(task, 3000);
    for (let index = 0; index < 10; index++) live.signal();
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    // Signals during the in-flight refresh queue exactly one more.
    for (let index = 0; index < 10; index++) live.signal();
    finish();
    await vi.advanceTimersByTimeAsync(2999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(overlapped).toBe(false);
  });

  it('keeps coalescing after a failed refresh and stops when the page closes', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const live = coalesceRefresh(task, 3000);
    live.signal();
    await vi.advanceTimersByTimeAsync(0);
    live.signal();
    await vi.advanceTimersByTimeAsync(3000);
    expect(task).toHaveBeenCalledTimes(2);
    live.signal();
    live.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
