// `POST /admin/repos/:id/audit-set-aside {seq, dry_run}` or `{seq, bytes}`, what `cargo xtask
// admin audit-set-aside` calls: an operator's way past one audit event the log can never take
// (repo_store/audit_outbox.rs, which decides everything). The dry run shows the row by its kind
// and size, and the real run has to repeat that size. An attempt is on the operators' record
// before it starts, and how it went after, since a person's repository has no org log. Nothing
// here sees what the row held.
import { auditBegin, auditEnd } from './platform-admin-queries';
import { auditRepo } from './repo-audit';
import { ApiError, caller, type Json } from './repo-ops';
import type { Env } from './types';

const OP = 'repo_audit_set_aside';

/** An erased repository has nothing left to mend: a repeat run's answer, not a failure. */
const orErased = (seq: number) => (e: unknown) => {
  if (e instanceof ApiError && e.code === 'GONE') return { state: 'erased', seq } as Json;
  throw e;
};

export async function setAsideAuditRow(env: Env, actor: string, repo: string, body: Json) {
  const { seq, bytes } = body;
  if (!Number.isSafeInteger(seq) || seq < 1)
    throw new ApiError('INVALID_INPUT', 'seq must be an event number');
  const call = caller(env, repo, { _system: 'audit' });
  if (body.dry_run === true) return call({ op: OP, seq, check: true }).catch(orErased(seq));
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new ApiError('INVALID_INPUT', 'bytes must be the size the dry run printed');
  const row = await auditBegin(env, actor, 'repo.audit_row_set_aside', repo, { seq, bytes });
  try {
    const done = await call({ op: OP, seq, bytes, operator: actor }).catch(orErased(seq));
    await auditEnd(env, row, { seq, bytes, state: done.state, kind: done.kind });
    // What was stuck behind it goes now, not at the next change.
    if (done.state !== 'erased') await auditRepo(env, repo);
    return done;
  } catch (e: any) {
    await auditEnd(env, row, { seq, bytes, failed: e?.code ?? 'INTERNAL' });
    throw e;
  }
}
