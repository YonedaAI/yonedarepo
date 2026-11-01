// What a failed queue job does next. A repository deleted while its job waited leaves that job
// nothing to do, so it ends; retrying would only fill the dead letter queue. The deletion's own
// work is the exception: it has to finish.
import { log } from './log';
import type { Envelope } from './types';

const OF_THE_DELETION = new Set(['platform_purge', 'platform_erase']);

export function settleFailedJob(message: Message<Envelope>, e: unknown) {
  const gone = (e as { code?: string })?.code === 'GONE';
  if (gone && !OF_THE_DELETION.has(message.body.kind)) {
    log.info('job.dropped', { reason: 'repository_deleted' });
    message.ack();
    return;
  }
  // Which job failed and why, for `wrangler tail`; the queue retries it.
  log.error('job.failed', { error: e });
  message.retry();
}
