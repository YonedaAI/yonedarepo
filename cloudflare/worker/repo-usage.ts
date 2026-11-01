// What a request did to a repository, noted as it happens and read once, when its Analytics Engine
// point is written after the answer (platform-client-events.ts). Off unless REPO_ANALYTICS is `on`,
// and with TRAFFIC_EVENTS and TRAFFIC_REPORT on too. Budget: docs/load-testing.md. A note holds what
// a point may: the repository's id, who in kinds and not names, bytes, and a landing's outcome with
// a reason from a short list. Never a path, branch, commit, message or token.
//
// Repositories are noted only once they admitted the request, and a point drops the note when the
// answer was a refusal of the caller, so nobody can put figures on a repository by asking for it.
// With AGENT_REPORT on as well, an agent's every request notes the repository that answered it.
import { type CredentialKind, requestNote } from './internal-accounts';
import type { Command, Outcome } from './repo-git-moves';
import type { PackStats } from './repo-pack-stream';
import type { Env } from './types';

export type Usage = {
  repo?: string;
  /** clone, fetch; base, branch (where a push went); landed, already, refused, failed;
   * check:pass, check:fail. Unset, the request counts in no repository figure. */
  detail?: string;
  /** Why a landing or push was refused, from `refusalReason`. */
  reason?: string;
  bytes?: number;
  queueMs?: number;
  retries?: number;
  /** A pack this request streams: its point waits for the last byte. */
  pack?: PackStats;
  /** A landing ran in this request, as an MCP tool or a browser's click would hide. */
  landing?: boolean;
};

export const repoAnalytics = (env: Env) =>
  env.REPO_ANALYTICS === 'on' &&
  env.TRAFFIC_EVENTS === 'on' &&
  env.TRAFFIC_REPORT === 'on' &&
  Boolean(env.SITE_EVENTS);

/** Needs REPO_ANALYTICS: a report on agents is made of what these notes hold. */
export const agentReport = (env: Env) => env.AGENT_REPORT === 'on' && repoAnalytics(env);

/** The agent credential behind the running request, or null with AGENT_REPORT off. */
export const requestAgent = (env: Env) =>
  agentReport(env) ? (requestNote()?.agent ?? null) : null;

/** The running request's usage, or null with the switch off or outside a request (a job). */
function noting(env: Env): Usage | null {
  if (!repoAnalytics(env)) return null;
  const note = requestNote();
  if (!note) return null;
  note.usage ??= {};
  return note.usage as Usage;
}

/** What the running request noted, to write its point. */
export const requestUsage = (env: Env) =>
  repoAnalytics(env) ? ((requestNote()?.usage as Usage | undefined) ?? null) : null;

export const requestActor = (): CredentialKind | '' => requestNote()?.actor ?? '';

/** The repository admitted this request. */
export function noteRepo(env: Env, repo: string) {
  const usage = noting(env);
  if (usage) usage.repo = repo;
}

/** The repository let this request in: an agent has reached it, whatever the request was. Never
 * for the platform's own reads, which say nothing of the caller. */
export function noteReached(env: Env, repo: string) {
  if (!requestAgent(env)) return;
  const usage = noting(env);
  if (usage) usage.repo ??= repo;
}

/** The pack this request is about to send, if it sends one. */
export function notePack(env: Env, pack: PackStats) {
  const usage = noting(env);
  if (usage) usage.pack = pack;
}

/** A pack's figures once it went: bytes, and a clone from a fetch. */
export function packDetail(usage: Usage) {
  const { pack } = usage;
  if (!pack?.ended) return;
  usage.detail = pack.fresh ? 'clone' : 'fetch';
  usage.bytes = pack.sentBytes;
}

export function noteLanded(env: Env, repo: string, already: boolean) {
  const usage = noting(env);
  if (!usage) return;
  Object.assign(usage, { repo, landing: true, detail: already ? 'already' : 'landed' });
}

export function noteRefused(env: Env, repo: string, e: unknown) {
  const usage = noting(env);
  if (!usage) return;
  Object.assign(usage, { repo, landing: true, detail: 'refused', reason: refusalReason(e) });
}

export function noteQueued(env: Env, ms: number) {
  const usage = noting(env);
  if (usage) usage.queueMs = (usage.queueMs ?? 0) + ms;
}

/** The platform went round a landing again: a commit on unlanded parents, a slow combiner. */
export function noteRetry(env: Env) {
  const usage = noting(env);
  if (usage) usage.retries = (usage.retries ?? 0) + 1;
}

/** A push's report: where it went, its bytes, and a refusal not from landing. A landing inside
 * it stays the push's: direct pushes are counted apart from landings. */
export function notePush(env: Env, commands: Command[], outcomes: Outcome, bytes: number) {
  const usage = noting(env);
  if (!usage) return;
  usage.landing = false;
  usage.detail = commands.some((c) => c.protected) ? 'base' : 'branch';
  usage.bytes = bytes;
  if ([...outcomes.values()].some(Boolean)) usage.reason ??= 'refused';
  else delete usage.reason;
}

/** A check posted over the API. */
export function noteCheck(env: Env, repo: string, status: unknown) {
  const usage = noting(env);
  if (!usage || (status !== 'pass' && status !== 'fail')) return;
  Object.assign(usage, { repo, detail: `check:${status}` });
}

const GATE = 'Commit cannot land yet: ';

/** The gate that held a commit back, first of those that did. */
function gateReason(message: string) {
  if (!message.startsWith(GATE)) return 'not_ready';
  try {
    const gate = JSON.parse(message.slice(GATE.length));
    if (gate.rejected) return 'rejected';
    if (gate.failing_checks?.length) return 'checks_failed';
    if (gate.open_findings > 0) return 'open_findings';
    if (gate.missing_checks?.length) return 'checks_missing';
    if (gate.approvals < gate.approvals_required) return 'needs_approval';
  } catch {
    // A gate that can't be read is still a refusal.
  }
  return 'not_ready';
}

/** Why a landing was refused: the gate, or the error's code in lower case. */
export function refusalReason(e: unknown) {
  const { code, message } = (e ?? {}) as { code?: unknown; message?: unknown };
  if (code === 'NOT_READY') return gateReason(String(message ?? ''));
  const named = String(code ?? '').toLowerCase();
  return /^[a-z][a-z0-9_]{0,39}$/.test(named) ? named : 'unknown';
}
