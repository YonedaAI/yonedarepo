import type { TailComponent } from './tail';

/** Durable Object classes of the platform Worker, by tail `entrypoint`. */
const OBJECT_CLASSES: Record<string, TailComponent> = {
  SourceRepository: 'source_repository',
  CheckContainer: 'check_runs',
  LandCombiner: 'land_queue',
  CommitShard: 'commit_shards',
  PackBuilder: 'pack_builder',
  SshGateway: 'ssh_gateway',
  WorkspaceAuthority: 'workspace_authority',
};
/** An alarm or an explicitly identified keep-alive is maintenance, never a Git request.
 * Unknown events retain the request failure rules rather than silently disappearing. */
export function classify(item: TraceItem): TailComponent | null {
  const event = item.event as Record<string, unknown> | null;
  if (item.executionModel === 'durableObject') {
    const component = OBJECT_CLASSES[item.entrypoint ?? ''] ?? null;
    if (component === 'ssh_gateway' && event) {
      const methods = Array.isArray(event.rpcMethods) ? event.rpcMethods : [event.rpcMethod];
      const keepAlive = methods.length > 0 && methods.every((m) => m === 'keepAlive');
      const alarm = 'scheduledTime' in event && !('cron' in event);
      if (alarm || keepAlive) return 'ssh_maintenance';
    }
    return component;
  }
  if (event && 'cron' in event) return 'cron';
  if (event && 'queue' in event) return 'derived_jobs';
  if (event && 'request' in event) return 'api_worker';
  return null;
}
