export { RepositoryAuthority,LiveRoom,WorkspaceAuthority } from '../../backend/crates/yoneda-worker/build/index.js';
import { YonedaEntrypoint } from '../../cloudflare/worker/entrypoint';
import type { Envelope, Scope } from '../../cloudflare/worker/types';
export default class TestEntrypoint extends YonedaEntrypoint {
  // Intentionally withhold dispatch: tests inspect the real durable outbox,
  // without launching inference or containers.
  override async deliver(_repo:string,_entries:Record<string,unknown>[]) {return [] as string[];}
  override async enqueueProjects(_owner:string,_entries:Record<string,unknown>[]) {return [] as string[];}
  private launchRequestedForTest = false;

  override async launchExecution(_name: string, _scope: Scope) {
    this.launchRequestedForTest = true;
  }

  async dispatchOneForTest(body: Envelope, loseAck = false) {
    this.launchRequestedForTest = false;
    const result = { acked: false, retries: [] as number[] };
    await this.queue({ messages: [{
      body,
      ack: () => {
        if (loseAck) throw new Error('Simulated acknowledgment loss');
        result.acked = true;
      },
      retry: (options?: { delaySeconds?: number }) => { result.retries.push(options?.delaySeconds ?? 0); },
    }] } as unknown as MessageBatch<Envelope>);
    return { ...result, launchRequested: this.launchRequestedForTest };
  }
}
