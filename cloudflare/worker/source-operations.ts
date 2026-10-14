import { sourceError } from './source-contract';
import type { Json } from './types';

const allowed: Record<string, string[]> = {
  source_status: [],
  source_list: ['prefix', 'recursive', 'cursor', 'limit', 'expected_workspace_version'],
  source_stat: ['path', 'expected_workspace_version'],
  source_read: ['path', 'expected_file_version', 'offset', 'limit'],
  source_create: [
    'request_id',
    'path',
    'ticket_id',
    'expected_workspace_version',
    'expected_file_version',
  ],
  source_write: [
    'request_id',
    'path',
    'ticket_id',
    'expected_workspace_version',
    'expected_file_version',
  ],
  source_truncate: [
    'request_id',
    'path',
    'ticket_id',
    'length',
    'expected_workspace_version',
    'expected_file_version',
  ],
  source_delete: ['request_id', 'path', 'expected_workspace_version', 'expected_file_version'],
  source_chmod: [
    'request_id',
    'path',
    'mode',
    'expected_workspace_version',
    'expected_file_version',
  ],
  source_copy: [
    'request_id',
    'from',
    'to',
    'expected_workspace_version',
    'expected_from_version',
    'expected_to_version',
    'overwrite',
  ],
  source_rename: [
    'request_id',
    'from',
    'to',
    'expected_workspace_version',
    'expected_from_version',
    'expected_to_version',
    'overwrite',
  ],
  source_checkpoint: ['request_id', 'expected_workspace_version'],
  source_events: ['after', 'limit'],
};
export function sourceArguments(op: string, body: Json, supervisor: boolean) {
  const fields =
    supervisor && op === 'source_seal'
      ? ['request_id', 'expected_workspace_version', 'checkpoint_id', 'expected_checkpoint_digest']
      : allowed[op];
  if (!fields) throw sourceError('FORBIDDEN', 'Source operation is not available to this actor');
  if (Object.keys(body).some((key) => !fields.includes(key)))
    throw sourceError('FORBIDDEN', 'Source arguments cannot supply authority or private selectors');
  return { ...body, op };
}

/** Private maintenance/signing/pointer data never reaches model or browser callers. */
export function publicSourceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicSourceValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !key.startsWith('_') &&
          ![
            'attestation',
            'actor_grant',
            'gc_grant',
            'seal_receipt',
            'content',
            'key',
            'certificate',
            'signature',
          ].includes(key),
      )
      .map(([key, item]) => [key, key === 'file_versions' ? item : publicSourceValue(item)]),
  );
}
