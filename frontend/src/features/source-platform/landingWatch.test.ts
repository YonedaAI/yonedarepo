// A Landing on screen follows what happens to it: agents report and CTC lands while nobody
// touches the page. The cheap read is polled and the page's heavy ones only when it says so.
import { describe, expect, it, vi } from 'vitest';
import { saidChanged } from './landingWatch';

describe('saidChanged', () => {
  it('stays quiet on the first answer: the page just read everything', () => {
    const moved = vi.fn();
    saidChanged(moved)('{"ready":false}');
    expect(moved).not.toHaveBeenCalled();
  });
  it('tells once when the answer moves, and not when a poll repeats it', () => {
    const moved = vi.fn();
    const heard = saidChanged(moved);
    heard('{"ready":false}');
    heard('{"ready":false}');
    expect(moved).not.toHaveBeenCalled();
    heard('{"ready":true}');
    heard('{"ready":true}');
    expect(moved).toHaveBeenCalledTimes(1);
  });
  it('ignores a read with no answer: a failed poll is not news', () => {
    const moved = vi.fn();
    const heard = saidChanged(moved);
    heard('{"ready":false}');
    heard(undefined);
    heard('{"ready":false}');
    expect(moved).not.toHaveBeenCalled();
  });
});
