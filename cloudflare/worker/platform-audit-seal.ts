// Sealing an organization's audit log to R2 (accounts/audit_seal.rs): immutable segments under
// `audit/v1/<org>/`, written after the answer, never inside a transaction. No purge touches
// that prefix: a purge names `platform/v1/<repo>/`, `derived/v1/<repo>/` and `store/v1/<name>/`.
// The object goes first and the seal moves after, so a failure repeats the same rows. A
// segment holds its rows with their hashes, so it can be checked without the log.

import { afterAnswer } from './background';
import { log } from './log';
import type { Env, Json } from './types';
import { auditLog } from './workspace';

/** Segments one call writes; a longer backlog waits for the next. */
const ROUNDS = 5;

const warned = (e: any) => log.warn('audit.seal_failed', { error: e });
const place = (seq: number) => String(seq).padStart(12, '0');

/** Where a segment lives: its keys sort in log order. */
export const sealKey = (org: string, from: number, to: number) =>
  `audit/v1/${org}/${place(from)}-${place(to)}.json`;

/** Seals what is due in `org`'s log, or with `all`, everything so far. */
export async function sealAudit(env: Env, org: string, all = false) {
  for (let round = 0; round < ROUNDS; round++) {
    const next: Json = await auditLog(env, org, { op: 'audit_seal_next', all });
    if (!next.due) return;
    const { from, to, previous, hash, rows } = next;
    const key = sealKey(org, from, to);
    const segment = JSON.stringify({ v: 1, org, from, to, previous, hash, rows });
    await env.OBJECTS.put(key, segment, { httpMetadata: { contentType: 'application/json' } });
    await auditLog(env, org, { op: 'audit_seal_done', to, hash });
  }
}

/** Seals what is due, costing the caller nothing. */
export const sealWarned = (env: Env, org: string, all = false) =>
  sealAudit(env, org, all).catch(warned);

/** After an answer: what is due. Never fails the answer. */
export const sealAfterAnswer = (env: Env, org: string) => afterAnswer(() => sealWarned(env, org));
