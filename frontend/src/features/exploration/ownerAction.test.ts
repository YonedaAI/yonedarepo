import { describe, expect, it } from 'vitest';
import { actionErrorMessage, sendOwnerAction } from './ownerAction';

describe('owner actions', () => {
  it('sends the request when the action has no follow-up', async () => {
    // Regression: `await then?.(await api(...))` skipped the request when `then` was absent,
    // so Retry task and Cancel run sent nothing and reported success.
    const sent: string[] = [];
    const value = await sendOwnerAction(async () => {
      sent.push('retry_team_task');
      return { ok: true };
    });
    expect(sent).toEqual(['retry_team_task']);
    expect(value).toEqual({ ok: true });
  });

  it('passes the response to the follow-up after the request', async () => {
    const order: string[] = [];
    await sendOwnerAction(
      async () => {
        order.push('request');
        return { id: 'decision-1' };
      },
      async (value) => {
        order.push(`then:${value.id}`);
      },
    );
    expect(order).toEqual(['request', 'then:decision-1']);
  });

  it('never yields an empty message for a caught failure', () => {
    expect(actionErrorMessage(new Error('Stale task revision'))).toBe('Stale task revision');
    for (const thrown of [undefined, null, '', new Error(''), { code: 'X' }])
      expect(actionErrorMessage(thrown, 'retry_team_task')).toMatch(/retry team task failed/i);
    expect(actionErrorMessage('Plain refusal')).toBe('Plain refusal');
  });
});
