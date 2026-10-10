export { RepositoryAuthority,LiveRoom,WorkspaceAuthority } from '../../backend/crates/yoneda-worker/build/index.js';
import { YonedaEntrypoint } from '../../cloudflare/worker/entrypoint';
import type { Envelope } from '../../cloudflare/worker/types';
export default class TestEntrypoint extends YonedaEntrypoint {
  // Intentionally withhold dispatch: tests inspect the real durable outbox,
  // without launching inference or containers.
  override async deliver(_repo:string,_entries:Record<string,unknown>[]) {return [] as string[];}
  override async enqueueProjects(_owner:string,_entries:Record<string,unknown>[]) {return [] as string[];}

  async dispatchOneForTest(body: Envelope) {
    const result = { acked: false, retries: [] as number[] };
    await this.queue({ messages: [{
      body,
      ack: () => { result.acked = true; },
      retry: (options?: { delaySeconds?: number }) => { result.retries.push(options?.delaySeconds ?? 0); },
    }] } as unknown as MessageBatch<Envelope>);
    return result;
  }
}
