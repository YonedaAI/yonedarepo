// A job for a repository deleted while it waited has nothing left to do: retrying it only
// fills the dead letter queue. Work that belongs to the deletion itself must still retry.
import { describe, expect, it, vi } from 'vitest';
import { settleFailedJob } from '../../cloudflare/worker/job-settle';

const message = (kind: string) =>
  ({ body: { kind, repo_id: 'r0123456789abcdef0123' }, ack: vi.fn(), retry: vi.fn() }) as never as {
    body: { kind: string };
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
const gone = Object.assign(new Error('Repository was deleted'), { code: 'GONE' });

describe('a job that fails', () => {
  it('is dropped when its repository was deleted', () => {
    const m = message('platform_derive');
    settleFailedJob(m as never, gone);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
  });

  it.each(['platform_purge', 'platform_erase'])('%s still retries: it is the deletion', (kind) => {
    const m = message(kind);
    settleFailedJob(m as never, gone);
    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
  });

  it('retries any other failure', () => {
    const m = message('platform_derive');
    settleFailedJob(m as never, new Error('storage reset'));
    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
  });
});
