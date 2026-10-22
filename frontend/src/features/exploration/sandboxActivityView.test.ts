import { describe, expect, it } from 'vitest';
import { ago, lastActivity } from './sandboxActivityView';

const sandbox = (status: string, at: number, summary = 'Edit src/math.js') => ({
  runtime: 'sandbox-cli-v1',
  status,
  activity: { phase: 'running', last_activity_at: at, summary, idle_ms: 0 },
});

describe('sandbox last activity', () => {
  it('says when the CLI last did something and what', () => {
    expect(lastActivity(sandbox('running', 1_000), 121_000)).toEqual({
      text: 'Last activity 2 min ago · Edit src/math.js',
      idleMinutes: null,
    });
  });

  it('marks a running CLI idle after ten silent minutes', () => {
    expect(lastActivity(sandbox('running', 0), 11 * 60_000)?.idleMinutes).toBe(11);
    // A finished attempt is quiet, not idle.
    expect(lastActivity(sandbox('evaluating', 0), 11 * 60_000)?.idleMinutes).toBeNull();
  });

  it('shows nothing for ordinary attempts or before any activity', () => {
    expect(lastActivity({ status: 'running', activity: { last_activity_at: 1 } }, 2)).toBeNull();
    expect(lastActivity({ runtime: 'sandbox-cli-v1', status: 'queued' }, 2)).toBeNull();
  });

  it('formats elapsed time', () => {
    expect(ago(4_000)).toBe('4s ago');
    expect(ago(-5)).toBe('0s ago');
    expect(ago(125 * 60_000)).toBe('2 h 5 min ago');
  });
});
