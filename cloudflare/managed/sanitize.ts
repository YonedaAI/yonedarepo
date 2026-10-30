// Model output is untrusted (a diff can carry instructions aimed at the model). Nothing the
// model writes is ever executed or used as a tool name: it is parsed into a fixed finding
// shape, every anchor must be a line of the change's own diff, text is capped and defused,
// and a finding whose text looks like a credential is withheld. The platform's own secret
// scanner (yoneda-platform `secret_scan`) refuses credentials in comments again on post.

/** Credential shapes, deliberately broader than the platform's rules: a false positive only
 * withholds one finding. */
const CREDENTIALS: RegExp[] = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\b[rs]k_live_[A-Za-z0-9]{16,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bt?tp-[A-Za-z0-9]{24,}/,
  /\by(?:rp|pat)_[A-Za-z0-9_-]{16,}/,
  /\bwhsec_[0-9a-f]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

export const looksLikeCredential = (text: string) => CREDENTIALS.some((re) => re.test(text));

/** `text` with every credential-shaped run replaced (transcripts kept for the run page). */
export function redact(text: string): string {
  let out = text;
  for (const re of CREDENTIALS) out = out.replace(new RegExp(re.source, 'g'), '[redacted]');
  return out;
}

/** Plain, inert text: no control characters, HTML, images or links, at most `max` chars. */
export function defuse(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : '';
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/[<>]/g, '')
      .replace(/\bhttps?:\/\/\S+/g, '[link removed]')
      .trim()
      .slice(0, max)
  );
}

export type Severity = 'high' | 'medium' | 'low';
const SEVERITIES = new Set<Severity>(['high', 'medium', 'low']);

/** A finding as the model proposes it, before validation. */
export interface Finding {
  path: string;
  line: number;
  severity: Severity;
  title: string;
  why: string;
}

/** The lines of each changed file a comment may anchor to (added or context, new side). */
export type Anchors = Map<string, Set<number>>;

export function anchorsOf(files: { path: string; patch?: string }[]): Anchors {
  const anchors: Anchors = new Map();
  for (const file of files) {
    const lines = new Set<number>();
    let next = 0;
    for (const line of (file.patch ?? '').split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) next = Number(hunk[1]);
      else if (line.startsWith('+')) lines.add(next++);
      else if (line.startsWith(' ')) next++;
    }
    anchors.set(file.path, lines);
  }
  return anchors;
}

/** The first JSON object or array in a reply; null when there is none or it does not parse. */
export function parseJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const close = text[start] === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Why a finding could not be posted on its line. */
export type WithheldReason = 'anchor' | 'credential' | 'scanner';

/** A finding that was not posted; it still counts toward the run's value (fail closed). */
export interface Withheld {
  severity: Severity;
  /** Defused title, or null when showing it could leak a credential. */
  title: string | null;
  reason: WithheldReason;
}

/** Where the checkout sits in the harness container (runner.mjs CHECKOUT). */
const CHECKOUT = '/work/repo/';

/** The diff path a finding means: as written, or without the checkout's absolute prefix, a
 * leading `./` or git's `a/` / `b/` (agents that read files through their tools write those). */
function anchorPath(path: string, anchors: Anchors): string {
  if (anchors.has(path)) return path;
  for (const prefix of [CHECKOUT, './', 'a/', 'b/'])
    if (path.startsWith(prefix) && anchors.has(path.slice(prefix.length)))
      return path.slice(prefix.length);
  return path;
}

/**
 * Valid findings from a model reply, and those that cannot be posted: no line of the diff to
 * anchor to (or malformed), or text that looks like a credential. An unknown severity counts as
 * medium, so a malformed finding never lowers the value.
 */
export function validFindings(
  raw: unknown,
  anchors: Anchors,
): { kept: Finding[]; withheld: Withheld[] } {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { findings?: unknown })?.findings)
      ? (raw as { findings: unknown[] }).findings
      : [];
  const kept: Finding[] = [];
  const withheld: Withheld[] = [];
  for (const item of list.slice(0, 100)) {
    const f = (item ?? {}) as Record<string, unknown>;
    const path = anchorPath(typeof f.path === 'string' ? f.path : '', anchors);
    const line = Number(f.line);
    const stated = String(f.severity ?? '').toLowerCase() as Severity;
    const severity: Severity = SEVERITIES.has(stated) ? stated : 'medium';
    const anchored = Number.isSafeInteger(line) && anchors.get(path)?.has(line) === true;
    const title = defuse(f.title, 120);
    const why = defuse(f.why, 600);
    if (looksLikeCredential(`${f.title ?? ''} ${f.why ?? ''}`)) {
      withheld.push({ severity, title: null, reason: 'credential' });
      continue;
    }
    if (!anchored || !SEVERITIES.has(stated) || !title) {
      withheld.push({ severity, title: title || null, reason: 'anchor' });
      continue;
    }
    kept.push({ path, line, severity, title, why });
  }
  return { kept, withheld };
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
export const bySeverity = (a: Finding, b: Finding) =>
  RANK[a.severity] - RANK[b.severity] || a.path.localeCompare(b.path) || a.line - b.line;

/** One finding per anchor (the most severe); the same line flagged twice is one comment. */
export function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return [...findings].sort(bySeverity).filter((f) => {
    const key = `${f.path}:${f.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
