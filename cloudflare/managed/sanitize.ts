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

/** Valid findings from a model reply, plus how many were dropped (bad anchor or credential). */
export function validFindings(
  raw: unknown,
  anchors: Anchors,
): { kept: Finding[]; withheld: number } {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { findings?: unknown })?.findings)
      ? (raw as { findings: unknown[] }).findings
      : [];
  const kept: Finding[] = [];
  let withheld = 0;
  for (const item of list.slice(0, 100)) {
    const f = (item ?? {}) as Record<string, unknown>;
    const path = typeof f.path === 'string' ? f.path : '';
    const line = Number(f.line);
    const severity = String(f.severity ?? '').toLowerCase() as Severity;
    const anchored = Number.isSafeInteger(line) && anchors.get(path)?.has(line) === true;
    const title = defuse(f.title, 120);
    const why = defuse(f.why, 600);
    if (!anchored || !SEVERITIES.has(severity) || !title) {
      withheld++;
      continue;
    }
    if (looksLikeCredential(`${f.title ?? ''} ${f.why ?? ''}`)) {
      withheld++;
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
