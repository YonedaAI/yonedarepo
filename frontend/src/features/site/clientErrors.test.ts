import { describe, expect, it } from 'vitest';
import { clientErrorReporter } from './clientErrors';

const reporter = (answer: () => Promise<Pick<Response, 'headers'>>) => {
  const bodies: Record<string, unknown>[] = [];
  const report = clientErrorReporter(
    () => '/ada/plans',
    (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return answer();
    },
  );
  return { report, bodies };
};
const answered = async () => ({ headers: new Headers({ 'x-request-id': 'ref-123' }) });

describe('client error reports', () => {
  it('sends the message and the path, and nothing else', async () => {
    const { report, bodies } = reporter(answered);
    expect(await report(new Error('it broke'))).toBe('ref-123');
    expect(bodies).toEqual([{ message: 'it broke', route: '/ada/plans' }]);
  });

  it('sends a message once, and a handful in all', async () => {
    const { report, bodies } = reporter(answered);
    await report(new Error('again'));
    expect(await report(new Error('again'))).toBeNull();
    for (let n = 0; n < 20; n++) await report(new Error(`loop ${n}`));
    expect(bodies).toHaveLength(5);
  });

  it('bounds a long message', async () => {
    const { report, bodies } = reporter(answered);
    await report(new Error('x'.repeat(5000)));
    expect(String(bodies[0].message)).toHaveLength(300);
  });

  it('answers null, never an error, when it cannot send', async () => {
    const { report } = reporter(() => Promise.reject(new Error('offline')));
    await expect(report(new Error('it broke'))).resolves.toBeNull();
  });
});
