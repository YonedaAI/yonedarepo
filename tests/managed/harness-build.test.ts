// The Worker refuses a harness image that is not its own build (a container rollout still in
// progress serves an older image): the start is refused, the container destroyed, and the
// retried start uses a fresh container.
import { describe, expect, it } from 'vitest';
import { buildMismatch, HARNESS_BUILD } from '../../cloudflare/managed/harness';

describe('harness build identity', () => {
  it('accepts only the build this Worker was made with', () => {
    expect(HARNESS_BUILD).toMatch(/^[0-9a-f]{16}$/);
    expect(buildMismatch({ phase: 'starting', build: HARNESS_BUILD })).toBeNull();
    // An image from before build identity answers without one.
    expect(buildMismatch({ phase: 'starting' })).toMatch(
      /harness image \(unknown\) is not this Worker's/,
    );
    expect(buildMismatch({ build: '0000000000000000' })).toMatch(/\(0000000000000000\)/);
    expect(buildMismatch(null)).not.toBeNull();
  });
});
