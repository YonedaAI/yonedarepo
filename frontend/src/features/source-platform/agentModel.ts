// What agents record on a repository, as the agent pages read it: session records (which
// coding session produced which commit), authored symbol contracts, pins and bisects.

export type SessionRecord = {
  id: number;
  commit: string;
  cli: string;
  model: string | null;
  /** Null while the record is quarantined (or after its purge). */
  summary: string | null;
  prompt_digest: string | null;
  transcript_ref: string | null;
  read_set_digest: string | null;
  /** The coding session's own id (`opencode:<id>`, `claude-code:<id>`); null on older records. */
  session_id: string | null;
  recorded_by: string;
  at: number;
  /** The commit message's first line. */
  subject: string;
  /** How many reads the commit declared. */
  reads: number;
  /** The transcript the platform stores for this record; null when none was uploaded. */
  transcript: TranscriptMeta | null;
  /** The repository's owner withholds this record's text (quarantine). */
  quarantined?: boolean;
};

/** A record's summary as the pages show it: a marker in place of quarantined text. */
export const summaryText = (s: Pick<SessionRecord, 'summary' | 'quarantined'>) =>
  s.quarantined ? 'Withheld by the repository owner (quarantined).' : (s.summary ?? '');

/** What a record keeps about its stored transcript. */
export type TranscriptMeta = {
  sha256: string;
  bytes: number;
  /** Prompts, replies and tool calls kept (not counting left-out turns). */
  turns: number;
  /** Credentials replaced by `[REDACTED:<rule>]` before storing. */
  redactions: number;
  /** Texts cut or turns left out to fit 1 MiB. */
  truncated: boolean;
  /** Whether the context packet given at session start was recorded. */
  context: boolean;
};

export type TranscriptTurn =
  | { kind: 'prompt'; text: string }
  | { kind: 'reply'; text: string }
  | {
      kind: 'tool';
      name: string;
      subject?: string;
      input?: string;
      output?: string;
      error?: boolean;
    }
  | { kind: 'omitted'; turns: number };

/** `GET sessions/:id/transcript`. */
export type StoredTranscript = {
  session: number;
  transcript: TranscriptMeta;
  document: {
    format: string;
    context: string | null;
    turns: TranscriptTurn[];
    redactions: Record<string, number>;
    truncated: boolean;
  };
};

export const transcriptPath = (repo: string, id: number) =>
  `/repos/${repo}/sessions/${id}/transcript`;

/** A tool call named by its tool and what it acted on. */
export function toolLabel(turn: Extract<TranscriptTurn, { kind: 'tool' }>) {
  return turn.subject ? `${turn.name} · ${turn.subject}` : turn.name;
}

/** Where a record's transcript is, for a listing: stored (with its size in turns), the
 * reference the agent gave, or null. */
export function transcriptLabel(s: Pick<SessionRecord, 'transcript' | 'transcript_ref'>) {
  if (s.transcript) return `transcript stored · ${s.transcript.turns} turns`;
  return s.transcript_ref;
}

/** What was changed in a transcript before it was stored, in words. */
export function transcriptNotes(meta: TranscriptMeta): string[] {
  const notes: string[] = [];
  if (meta.redactions > 0)
    notes.push(
      `${meta.redactions} credential${meta.redactions === 1 ? '' : 's'} redacted before storing.`,
    );
  if (meta.truncated)
    notes.push(
      'Cut to fit 1 MiB: long texts keep their start and end, and turns left out are counted.',
    );
  return notes;
}

export type SessionList = {
  sessions: SessionRecord[];
  next: number | null;
  clis: string[];
  models: string[];
  ref: string | null;
  branch_scan_truncated: boolean;
};

export type SessionDetail = {
  session: SessionRecord;
  commit: { id: string; message: string; principal: string; parents: string[] };
  reads: string[];
  reads_truncated: boolean;
  /** Other records of the same session (same transcript or prompt digest). */
  related: SessionRecord[];
};

export type SessionFilters = { cli: string; model: string; ref: string };
export const NO_FILTERS: SessionFilters = { cli: '', model: '', ref: '' };

export type ContractRecord = {
  seq: number;
  path: string;
  symbol_path: string;
  commit: string;
  node_digest: string;
  contract: Record<string, unknown> & { summary?: string };
  recorded_by: string;
  recorded_at: number;
  recorded_version: number;
};

export type Pin = {
  commit: string;
  reason: string;
  pinned_by: string;
  pinned_at: number;
  subject: string;
};

export type Bisect = {
  id: string;
  ref: string;
  check: string;
  status: 'running' | 'found' | 'failed';
  result: { first_bad?: string; tested_range?: number } | null;
  requested_by: string;
  created_at: number;
  candidates: number;
  bad: string | null;
  testing: string | null;
  remaining: number;
};

export const AGENT_SECTIONS = ['sessions', 'memories', 'contracts', 'pins', 'bisects'] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number];

/** The sessions read for these filters, from the page after `before` when given. */
export function sessionsPath(repo: string, filters: SessionFilters, before?: number | null) {
  const query = new URLSearchParams();
  for (const key of ['cli', 'model', 'ref'] as const)
    if (filters[key].trim()) query.set(key, filters[key].trim());
  if (before) query.set('before', String(before));
  return query.size ? `/repos/${repo}/sessions?${query}` : `/repos/${repo}/sessions`;
}

/** A transcript reference is a URL (linked) or an opaque id (shown as text); a stored
 * transcript's own reference (`transcript:sha256:…`) is shown by the transcript itself. */
export function transcriptUrl(ref: string | null): string | null {
  if (!ref) return null;
  try {
    const url = new URL(ref);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** `token:agent` → `agent (token)`, `user:ws` → `ws`: who recorded, as people read it. */
export function recorder(principal: string) {
  if (principal.startsWith('user:')) return principal.slice('user:'.length);
  if (principal.startsWith('token:')) return `${principal.slice('token:'.length)} (token)`;
  return principal;
}

/** The records of one symbol, newest first. */
export type ContractGroup = { path: string; symbol: string; records: ContractRecord[] };

/** Groups contract records by symbol, most recently recorded symbol first. */
export function groupContracts(records: ContractRecord[]): ContractGroup[] {
  const groups = new Map<string, ContractGroup>();
  for (const record of [...records].sort((a, b) => b.seq - a.seq)) {
    const key = `${record.path}\u0000${record.symbol_path}`;
    const group = groups.get(key) ?? { path: record.path, symbol: record.symbol_path, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Adds a next page to what is shown, dropping any row already there. */
export function appendPage<T>(shown: T[], page: T[], key: (row: T) => string | number): T[] {
  const seen = new Set(shown.map(key));
  return [...shown, ...page.filter((row) => !seen.has(key(row)))];
}

export const shortRef = (ref: string) => ref.replace(/^refs\/(heads|tags)\//, '');

/** One coding session as listed: its records (one per commit it produced), newest first. */
export type SessionGroup = { key: string; latest: SessionRecord; records: SessionRecord[] };

/** Groups records by session: its session id, else (older records) its transcript
 * reference; a record with neither is a session of its own. Keeps the newest-first order of
 * `records`. */
export function groupSessions(records: SessionRecord[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const record of records) {
    const key = record.session_id ?? record.transcript_ref ?? `#${record.id}`;
    const group = groups.get(key);
    if (group) group.records.push(record);
    else groups.set(key, { key, latest: record, records: [record] });
  }
  return [...groups.values()];
}

/** The sessions behind the commits a change introduces: those `head` reaches and its merge
 * base with main does not (no base: unrelated histories, so all of head's). */
export function changeSessionsPath(repo: string, head: string, base: string | null) {
  const query = new URLSearchParams({ head, limit: '200' });
  if (base) query.set('base', base);
  return `/repos/${repo}/sessions?${query}`;
}

/** One commit and the sessions recorded for it, newest first. */
export type CommitSessionGroup = { commit: string; subject: string; records: SessionRecord[] };

/** Groups records by commit, the commit with the newest record first. Keeps the newest-first
 * order of `records` within each commit. */
export function groupByCommit(records: SessionRecord[]): CommitSessionGroup[] {
  const groups = new Map<string, CommitSessionGroup>();
  for (const record of records) {
    const group = groups.get(record.commit);
    if (group) group.records.push(record);
    else
      groups.set(record.commit, {
        commit: record.commit,
        subject: record.subject,
        records: [record],
      });
  }
  return [...groups.values()];
}
