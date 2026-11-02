import { describe, expect, it, vi } from 'vitest';
import { watchReturn } from './backToTab';

function page(visible = true) {
  const target = new EventTarget();
  const state = { visible, now: 1000 };
  const onBack = vi.fn();
  const stop = watchReturn(
    target,
    () => state.visible,
    onBack,
    () => state.now,
  );
  const send = (name: string) => target.dispatchEvent(new Event(name));
  return { state, onBack, stop, send };
}

describe('watchReturn', () => {
  it('calls back when the person comes back to the tab, by either event', () => {
    const { state, onBack, send } = page();
    send('focus');
    expect(onBack).toHaveBeenCalledTimes(1);
    state.now += 5000;
    send('visibilitychange');
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('counts the two events of one return once', () => {
    const { onBack, send } = page();
    send('visibilitychange');
    send('focus');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while the tab is hidden', () => {
    const { state, onBack, send } = page(false);
    send('visibilitychange');
    expect(onBack).not.toHaveBeenCalled();
    state.visible = true;
    send('visibilitychange');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('stops when told to', () => {
    const { onBack, stop, send } = page();
    stop();
    send('focus');
    expect(onBack).not.toHaveBeenCalled();
  });
});
