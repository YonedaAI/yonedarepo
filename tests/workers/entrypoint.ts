export { RepositoryAuthority,LiveRoom,WorkspaceAuthority } from '../../backend/crates/yoneda-worker/build/index.js';
import { YonedaEntrypoint } from '../../cloudflare/worker/entrypoint';
export default class TestEntrypoint extends YonedaEntrypoint {
  // Intentionally withhold dispatch: tests inspect the real durable outbox,
  // without launching inference or containers.
  override async deliver(_repo:string,_entries:Record<string,unknown>[]) {return [] as string[];}
  override async enqueueProjects(_owner:string,_entries:Record<string,unknown>[]) {return [] as string[];}
}
