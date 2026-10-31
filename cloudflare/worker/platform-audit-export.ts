// `GET /api/v1/orgs/:org/audit/export[?format=json|csv&kind=&actor=&before=]`: the log as a
// file, newest first, streamed a page at a time. Its own path because `route()` answers
// JSON. Whoever may read the log may export it. A log too long for one request fails the
// download rather than ending it early; `before` continues from the last row received.
import { auditCatchUp, auditOn } from './platform-audit';
import { auditFilters } from './platform-audit-read';
import { orgArg, orgCaller, orgCommand } from './platform-orgs';
import { ApiError, type Credentials, type Json } from './repo-ops';
import type { Env } from './types';
import { auditLog } from './workspace';

const PATH = /^\/api\/v1\/orgs\/([^/]+)\/audit\/export$/;
const COLUMNS = [
  'seq',
  'at',
  'kind',
  'actor',
  'source',
  'source_seq',
  'details',
  'previous',
  'hash',
];
/** Pages of 200 one export may read: 100,000 rows, within a Worker's subrequests. */
const MOST_PAGES = 500;

export const auditExportOrg = (url: URL) => PATH.exec(url.pathname)?.[1];

/** A CSV cell. One a spreadsheet would run as a formula gets a leading `'`. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const safe = /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const csvRow = (row: Json) =>
  COLUMNS.map((c) => csvCell(c === 'at' ? new Date(row.at as number).toISOString() : row[c])).join(
    ',',
  );

/** The file's three parts in the format asked for. */
function shape(format: string, org: string) {
  if (format === 'csv')
    return {
      type: 'text/csv; charset=utf-8',
      open: `${COLUMNS.join(',')}\r\n`,
      row: (row: Json) => `${csvRow(row)}\r\n`,
      close: '',
    };
  return {
    type: 'application/json',
    open: `{"org":${JSON.stringify(org)},"items":[\n`,
    row: (row: Json, first: boolean) => `${first ? '' : ',\n'}${JSON.stringify(row)}`,
    close: '\n]}\n',
  };
}

export async function auditExport(
  env: Env,
  auth: Credentials,
  name: string,
  query: URLSearchParams,
): Promise<Response> {
  if (!auditOn(env)) throw new ApiError('NOT_FOUND', 'Unknown API path');
  const org = orgArg(name);
  const { account: actor } = orgCaller(auth, true, org);
  await orgCommand(env, org, { op: 'org_audit', actor });
  const format = query.get('format') ?? 'json';
  if (format !== 'json' && format !== 'csv')
    throw new ApiError('INVALID_INPUT', 'format must be json or csv');
  const filters = auditFilters(query);
  await auditCatchUp(env, org);
  const file = shape(format, org);
  const encoder = new TextEncoder();
  let before: number | null | undefined = filters.before;
  let pages = 0;
  let first = true;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(encoder.encode(file.open)),
    async pull(controller) {
      if (pages++ >= MOST_PAGES) throw new Error('Audit log too long for one export');
      const page = await auditLog(env, org, {
        op: 'audit_read',
        ...filters,
        ...(before !== undefined && { before }),
      });
      const rows = (page.items as Json[]).map((row, i) => file.row(row, first && i === 0));
      if (rows.length > 0) first = false;
      before = page.next;
      if (before === null) rows.push(file.close);
      controller.enqueue(encoder.encode(rows.join('')));
      if (before === null) controller.close();
    },
  });
  return new Response(body, {
    headers: {
      'content-type': file.type,
      'content-disposition': `attachment; filename="${org}-audit.${format}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
