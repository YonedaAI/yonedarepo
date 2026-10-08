export { RepositoryAuthority,LiveRoom,WorkspaceAuthority } from '../../crates/yoneda-worker/build/index.js';
import { YonedaEntrypoint } from '../../worker/entrypoint';
export default class TestEntrypoint extends YonedaEntrypoint {
  // Intentionally withhold dispatch: tests inspect the real durable outbox,
  // without launching inference or containers.
  override async deliver(_repo:string,_entries:Record<string,unknown>[]) {return [] as string[];}
}
