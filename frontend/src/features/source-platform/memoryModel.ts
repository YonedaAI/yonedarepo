// Repository memories as the platform returns them (git_memory_* in platform_tools.json),
// the context delivered to a coding session (context/deliveries), and the small pure
// helpers the Memories page and the session page use.

export const MEMORY_KINDS = ['decision', 'constraint', 'gotcha', 'howto'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_STATUSES = [
  'current',
  'active',
  'stale',
  'draft',
  'retired',
  'superseded',
  'all',
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];
/** The platform's limit on a memory's text, in UTF-8 bytes. */
export const MAX_MEMORY_BYTES = 2048;

export type MemoryAnchor = {
  path: string;
  symbol_path: string | null;
  blob: string | null;
  node_digest: string | null;
  /** Whether the anchored code changed on main since (null: unknown, e.g. a directory). */
  stale: boolean | null;
};

export type Memory = {
  id: number;
  kind: MemoryKind;
  /** Null while quarantine withholds it (`quarantined`). */
  text: string | null;
  quarantined?: true;
  commit: string;
  author: string;
  session_id: string | null;
  supersedes: number | null;
  superseded_by: number | null;
  status: 'active' | 'draft' | 'retired' | 'superseded';
  stale: boolean | null;
  retired: { reason: string | null; by: string; at: number } | null;
  recorded_at: number;
  recorded_version: number;
  anchors: MemoryAnchor[];
};

export type MemoryPage = { memories: Memory[]; next: number | null; version: number };

export type MemoryFilters = { path: string; kind: '' | MemoryKind; status: MemoryStatus };
export const NO_MEMORY_FILTERS: MemoryFilters = { path: '', kind: '', status: 'current' };

export const STATUS_LABELS: Record<MemoryStatus, string> = {
  current: 'Current (active and drafts)',
  active: 'Active',
  stale: 'Stale (code changed since)',
  draft: 'Drafts',
  retired: 'Retired',
  superseded: 'Superseded',
  all: 'All',
};

export type DeliveredItem = {
  type: 'memory' | 'contract' | 'session' | 'change';
  id: number;
  label: string | null;
};
export type Delivery = {
  seq: number;
  trigger: 'start' | 'read' | 'prompt';
  subject: string | null;
  bytes: number;
  principal: string;
  at: number;
  items: DeliveredItem[];
};
export type Deliveries = { deliveries: Delivery[]; bytes: number; truncated: boolean };

/** The memories read for these filters, from the page after `before` when given. */
export function memoriesPath(repo: string, filters: MemoryFilters, before?: number | null) {
  const query = new URLSearchParams();
  if (filters.path.trim()) query.set('path', filters.path.trim());
  if (filters.kind) query.set('kind', filters.kind);
  if (filters.status !== 'current') query.set('status', filters.status);
  if (before) query.set('before', String(before));
  return query.size ? `/repos/${repo}/memories?${query}` : `/repos/${repo}/memories`;
}

/** `path`, `path#symbol` or `dir/` for an anchor. */
export function anchorText(anchor: Pick<MemoryAnchor, 'path' | 'symbol_path'>) {
  return anchor.symbol_path ? `${anchor.path}#${anchor.symbol_path}` : anchor.path;
}

/** Anchors typed as a comma- or newline-separated list of `path`, `path#symbol` or `dir/`. */
export function parseAnchors(text: string): { path: string; symbol_path?: string }[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((spec) => {
      const at = spec.indexOf('#');
      return at < 0 ? { path: spec } : { path: spec.slice(0, at), symbol_path: spec.slice(at + 1) };
    });
}

/** UTF-8 bytes of `text` (the platform's limit is in bytes, not characters). */
export const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** The body a new memory is posted with. */
export function memoryBody(draft: {
  kind: MemoryKind;
  text: string;
  anchors: string;
  supersedes: number | null;
}) {
  return {
    kind: draft.kind,
    text: draft.text.trim(),
    anchors: parseAnchors(draft.anchors),
    ...(draft.supersedes ? { supersedes: draft.supersedes } : {}),
  };
}

/** What a delivery was prompted by, in words. */
export function deliveryCause(d: Pick<Delivery, 'trigger' | 'subject'>) {
  if (d.trigger === 'start') return 'Session start';
  if (d.trigger === 'read') return `Read ${d.subject ?? 'a file'}`;
  return 'New prompt';
}
