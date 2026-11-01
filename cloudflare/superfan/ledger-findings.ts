// Findings as problems come and go: SQL for the ledger's methods, each run inside its transaction.

/** A problem that returns this soon after resolving reopens its finding instead of a new one. */
const REOPEN_MS = 6 * 60 * 60_000;

export type NarrativeStatus =
  | 'pending'
  | 'written'
  | 'deterministic'
  | 'budget_exhausted'
  | 'model_failed';
export type Level = 'digest' | 'urgent';
export interface Observation {
  key: string;
  component: string;
  kind: 'anomaly' | 'telemetry';
  level?: Level;
  signals: unknown;
  summary: string;
}
export interface Observed {
  id: number;
  action: 'new' | 'repeat' | 'reopened';
  needsNarrative: boolean;
}

/** Records that a problem is present now; a known open problem is counted, not duplicated. */
export function observeProblem(sql: SqlStorage, o: Observation, now: number): Observed {
  const signals = JSON.stringify(o.signals);
  const level = o.level ?? 'digest';
  const open = sql
    .exec<{ id: number; narrative_status: NarrativeStatus }>(
      "SELECT id, narrative_status FROM findings WHERE dedup_key = ? AND status = 'open'",
      o.key,
    )
    .toArray()[0];
  const recent =
    open ??
    sql
      .exec<{ id: number; narrative_status: NarrativeStatus }>(
        "SELECT id, narrative_status FROM findings WHERE dedup_key = ? AND status = 'resolved' AND resolved_at >= ? ORDER BY resolved_at DESC LIMIT 1",
        o.key,
        now - REOPEN_MS,
      )
      .toArray()[0];
  if (recent) {
    // A reopened finding mails again, unless it was mailed within the same window; an urgent
    // one always, within its own limit (ledger-notice.ts).
    sql.exec(
      `UPDATE findings SET notified_at = CASE WHEN status = 'resolved' AND (? = 'urgent' OR notified_at < ?) THEN NULL ELSE notified_at END,
           status = 'open', resolved_at = NULL, occurrences = occurrences + 1, last_seen = ?, signals = ?, summary = ?, level = ? WHERE id = ?`,
      level,
      now - REOPEN_MS,
      now,
      signals,
      o.summary,
      level,
      recent.id,
    );
    return {
      id: recent.id,
      action: open ? 'repeat' : 'reopened',
      needsNarrative: !['written', 'deterministic'].includes(recent.narrative_status),
    };
  }
  const status: NarrativeStatus = o.kind === 'anomaly' ? 'pending' : 'deterministic';
  const id = sql
    .exec<{ id: number }>(
      `INSERT INTO findings (dedup_key, component, kind, level, status, signals, summary, narrative_status, first_seen, last_seen)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?) RETURNING id`,
      o.key,
      o.component,
      o.kind,
      level,
      signals,
      o.summary,
      status,
      now,
      now,
    )
    .one().id;
  return { id, action: 'new', needsNarrative: status === 'pending' };
}

/**
 * Resolves open findings that were not seen this run, but only when every rule in their
 * key (`component:ruleA+ruleB`) was evaluated; a rule whose source was down proves nothing.
 */
export function resolveAbsent(
  sql: SqlStorage,
  evaluated: string[],
  present: string[],
  now: number,
) {
  let resolved = 0;
  for (const row of sql
    .exec<{ id: number; dedup_key: string }>(
      "SELECT id, dedup_key FROM findings WHERE status = 'open'",
    )
    .toArray()) {
    const [component, rules = ''] = row.dedup_key.split(':', 2);
    const checked = rules.split('+').every((rule) => evaluated.includes(`${component}:${rule}`));
    if (checked && !present.includes(row.dedup_key)) {
      sql.exec(
        "UPDATE findings SET status = 'resolved', resolved_at = ? WHERE id = ?",
        now,
        row.id,
      );
      resolved++;
    }
  }
  return resolved;
}
