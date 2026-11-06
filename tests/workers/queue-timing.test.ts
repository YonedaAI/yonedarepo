import { expect, it } from 'vitest';
import { queueDelay, readyWait } from '../../cloudflare/worker/queue-timing';

it('subtracts a deliberate 12-hour delay, while measuring actual late starts', () => {
  const sent = 1700000000000;
  const delay = queueDelay({ delaySeconds: 43200 });
  const ready = sent + delay;
  const message = { timestamp: new Date(sent), attempts: 1, body: { queue_delay_ms: delay } };
  expect(readyWait(message as any, ready + 1161)).toBe(1161);
  expect(readyWait(message as any, ready + 120001)).toBe(120001);
  expect(readyWait({ ...message, attempts: 2 } as any, ready + 500000)).toBeNull();
});

it('does not invent a ready time for old or invalid metadata', () => {
  const timestamp = new Date(1700000000000);
  for (const queue_delay_ms of [undefined, 'bad', NaN, Infinity, -1, 43200001])
    expect(readyWait({ timestamp, attempts: 1, body: { queue_delay_ms } } as any, timestamp.getTime() + 5000)).toBeNull();
  expect(readyWait({ timestamp, attempts: 1, body: { queue_delay_ms: 5000 } } as any, timestamp.getTime())).toBe(0);
  expect(queueDelay()).toBe(0);
});
