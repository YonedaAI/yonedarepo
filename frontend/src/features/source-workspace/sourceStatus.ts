import type { SourceRevision } from '../../lib/sourceWorkspace';

export interface NativeSourceStatusView {
  version: 1;
  transport: 'api-source-v1';
  workspace_id: string;
  workspace_version: number;
  status: 'open' | 'sealed';
  base: SourceRevision & { tree: string };
  view_digest: string;
  access: 'read_only' | 'read_write';
  authority: 'staged_source';
  checked: false;
  published: false;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const hex = (value: unknown, lengths: number[]): value is string =>
  typeof value === 'string' && lengths.includes(value.length) && /^[a-f0-9]+$/.test(value);
/** Only the frozen public SourceStatus fields enter presentation; no grant/key/producer fields. */
export function parseSourceStatus(value: unknown): NativeSourceStatusView {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.transport !== 'api-source-v1' ||
    !record(value.capabilities) ||
    value.capabilities.source_api !== 1 ||
    value.authority !== 'staged_source' ||
    value.checked !== false ||
    value.published !== false ||
    typeof value.workspace_id !== 'string' ||
    !Number.isSafeInteger(value.workspace_version) ||
    typeof value.workspace_version !== 'number' ||
    value.workspace_version < 0 ||
    !['open', 'sealed'].includes(String(value.status)) ||
    !['read_only', 'read_write'].includes(String(value.access)) ||
    !record(value.base) ||
    typeof value.base.repository !== 'string' ||
    !hex(value.base.commit, [40, 64]) ||
    !hex(value.base.tree, [40, 64]) ||
    !hex(value.view_digest, [64])
  )
    throw new Error(
      'The source information does not match this app version. Refresh the workspace.',
    );
  return {
    version: 1,
    transport: 'api-source-v1',
    workspace_id: value.workspace_id,
    workspace_version: value.workspace_version,
    status: value.status === 'open' ? 'open' : 'sealed',
    base: { repository: value.base.repository, commit: value.base.commit, tree: value.base.tree },
    view_digest: value.view_digest,
    access: value.access === 'read_only' ? 'read_only' : 'read_write',
    authority: 'staged_source',
    checked: false,
    published: false,
  };
}
