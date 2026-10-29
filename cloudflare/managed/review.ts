// One run of a managed agent on one change head, as durable steps: admit (credit and
// currency), load the change through the platform API, a small fixed chain of model calls
// (summarise, review batches of files, rank) and post. Each model call is its own step: it
// holds its worst case against the account's credit, settles with the provider's usage, and
// stops instead of calling when the run was superseded, disabled or the credit is spent.
import { type AgentConfig, agentConfig, type ManagedEnv, type RunParams } from './config';
import { type CallMeta, ledgerStub } from './ledger';
import { callModel, ModelError, worstCase } from './model';
import { Platform, PlatformError } from './platform';
import { type FileDiff, rankPrompt, reviewPrompt, summarisePrompt, system } from './prompts';
import { repoStub } from './repo-agents';
import { postReport } from './report';
import {
  anchorsOf,
  dedupe,
  defuse,
  type Finding,
  looksLikeCredential,
  parseJson,
  validFindings,
} from './sanitize';

/** The durable step runner (a Workflow's `step`, or an inline runner in tests). */
export interface Steps {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export type Outcome =
  | { status: 'passed' | 'findings'; findings: number; withheld: number }
  | { status: 'paused' | 'stopped'; reason: string }
  | { status: 'failed'; error: string };

type Call = { text: string } | { stop: string } | { paused: true };

interface Loaded {
  token: string;
  title: string;
  body: string;
  branch: string;
  files: FileDiff[];
  skipped: number;
  context: string;
}

const MAX_PATCH_BYTES = 24_000;
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Cuts text to at most `max` UTF-8 bytes, at a line end where possible. */
function cut(text: string, max: number) {
  if (bytes(text) <= max) return text;
  let out = text.slice(0, max);
  while (bytes(out) > max) out = out.slice(0, -64);
  const nl = out.lastIndexOf('\n');
  return `${nl > max / 2 ? out.slice(0, nl) : out}\n… (cut)`;
}

/** Files packed into batches of at most `budget` bytes, at most `count` batches. */
function batches(files: FileDiff[], budget: number, count: number) {
  const out: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let size = 0;
  for (const file of files) {
    const n = bytes(file.patch) + file.path.length + 8;
    if (current.length && size + n > budget) {
      out.push(current);
      current = [];
      size = 0;
    }
    if (out.length === count) break;
    current.push(file);
    size += n;
  }
  if (current.length && out.length < count) out.push(current);
  return out;
}

async function load(env: ManagedEnv, p: RunParams, agent: AgentConfig): Promise<Loaded | string> {
  const connection = await repoStub(env, p.repo).connection();
  if (!connection) return 'not_connected';
  const platform = new Platform(env, { token: connection.token });
  const change = await platform.change(p.repo, p.change);
  if (change.status !== 'open') return 'change_not_open';
  if (change.head !== p.head) return 'superseded';
  const all = (change.diff?.changes ?? []) as Record<string, any>[];
  const files: FileDiff[] = all
    .filter((f) => typeof f.patch === 'string' && f.patch && !f.binary && !f.too_large)
    .slice(0, agent.caps.maxFiles)
    .map((f) => ({
      path: String(f.path),
      op: String(f.op ?? 'modify'),
      patch: cut(String(f.patch), MAX_PATCH_BYTES),
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
    }));
  // Memories and contracts for the changed paths; a failure only leaves the prompt without them.
  const relevant = await platform
    .relevant(p.repo, files.map((f) => f.path).slice(0, 100), String(change.branch))
    .catch(() => ({ items: [] }));
  const context = ((relevant.items ?? []) as Record<string, any>[])
    .map(
      (i) =>
        `- ${String(i.title ?? i.kind ?? 'note')}: ${String(i.text ?? i.body ?? i.summary ?? '')}`,
    )
    .join('\n');
  return {
    token: connection.token,
    title: String(change.title ?? ''),
    body: String(change.body ?? ''),
    branch: String(change.branch ?? ''),
    files,
    skipped: all.length - files.length,
    context: cut(context, 6_000),
  };
}

export async function runReview(env: ManagedEnv, p: RunParams, step: Steps): Promise<Outcome> {
  const repo = repoStub(env, p.repo);
  const ledger = ledgerStub(env, p.account);
  let agent: AgentConfig;
  try {
    agent = agentConfig(env, p.agent);
  } catch (e: any) {
    await repo.finish(p.run, p.attempt, 'failed', 0, 0, String(e?.message ?? e));
    return { status: 'failed', error: String(e?.message ?? e) };
  }
  const meta: CallMeta = { repo: p.repo, run: p.run, agent: p.agent, model: agent.model };
  const nonce = p.run.replace(/[^a-z0-9]/gi, '').slice(-12);
  const sys = system(p.agent, nonce);

  const admitted = await step.do('admit', async () => {
    const stop = await repo.stopReason(p.run, p.attempt);
    if (stop) return { stop };
    if ((await ledger.balance()).balance <= 0) return { paused: true as const };
    await repo.start(p.run, p.attempt);
    return {};
  });
  if ('stop' in admitted && admitted.stop) return { status: 'stopped', reason: admitted.stop };
  if ('paused' in admitted) return pause(env, p);

  let loaded: Loaded | string;
  try {
    loaded = await step.do('load', () => load(env, p, agent));
  } catch (e: any) {
    return fail(env, p, e);
  }
  if (typeof loaded === 'string') {
    await repo.finish(p.run, p.attempt, 'failed', 0, 0, `Not reviewed: ${loaded}`);
    return { status: 'stopped', reason: loaded };
  }
  const work = loaded;

  let calls = 0;
  const model = (name: string, prompt: string) =>
    step.do<Call>(name, async () => {
      const stop = await repo.stopReason(p.run, p.attempt);
      if (stop) return { stop };
      const key = `${p.run}:${p.attempt}:${name}:${crypto.randomUUID()}`;
      const hold = await ledger.hold(key, worstCase(agent, sys, prompt), meta);
      if (!hold.held) return { paused: true };
      try {
        const reply = await callModel(env, agent, p, sys, prompt);
        await ledger.settle(key, reply.usage, true, meta);
        await repo.recordCall(
          p.run,
          reply.usage.inputTokens,
          reply.usage.outputTokens,
          reply.usage.chargeMicrousd,
        );
        return { text: reply.text };
      } catch (e) {
        await ledger.settle(key, null, e instanceof ModelError ? e.sent : true, meta);
        throw e;
      }
    });
  const halted = async (call: Call): Promise<Outcome | null> => {
    if ('paused' in call) return pause(env, p);
    if ('stop' in call) return { status: 'stopped', reason: call.stop };
    return null;
  };

  try {
    const budget = agent.caps.maxPromptBytes;
    const excerpt = cut(work.files.map((f) => `### ${f.path}\n${f.patch}`).join('\n'), budget / 2);
    const first = await model(
      'summarise',
      summarisePrompt(nonce, work, work.files, work.context, excerpt),
    );
    calls++;
    const stopped = await halted(first);
    if (stopped) return stopped;
    const parsed = (parseJson((first as { text: string }).text) ?? {}) as Record<string, unknown>;
    const rawSummary = typeof parsed.summary === 'string' ? parsed.summary : '';
    const summary = looksLikeCredential(rawSummary) ? '' : defuse(rawSummary, 600);
    const focus = new Set(Array.isArray(parsed.focus) ? parsed.focus.map(String) : []);
    // Focus files first; every file still gets reviewed while the call budget lasts.
    const ordered = [...work.files].sort(
      (a, b) => Number(focus.has(b.path)) - Number(focus.has(a.path)),
    );
    const groups = batches(ordered, budget - 4_000, agent.caps.maxCalls - 2);
    const anchors = anchorsOf(work.files);
    let candidates: Finding[] = [];
    let withheld = 0;
    for (const [i, group] of groups.entries()) {
      const call = await model(`review-${i + 1}`, reviewPrompt(nonce, summary, group));
      calls++;
      const stop = await halted(call);
      if (stop) return stop;
      const found = validFindings(parseJson((call as { text: string }).text), anchors);
      candidates.push(...found.kept);
      withheld += found.withheld;
    }
    const unreviewed = work.skipped + work.files.length - groups.flat().length;
    candidates = dedupe(candidates);
    let ranked = candidates;
    if (candidates.length > 1 && calls < agent.caps.maxCalls) {
      const call = await model('rank', rankPrompt(nonce, candidates, agent.caps.maxComments));
      const stop = await halted(call);
      if (stop) return stop;
      const keep = (parseJson((call as { text: string }).text) as { keep?: unknown })?.keep;
      if (Array.isArray(keep)) {
        const picked = [...new Set(keep.map(Number))].filter(
          (n) => Number.isSafeInteger(n) && candidates[n],
        );
        ranked = picked.map((n) => candidates[n]);
      }
    }
    const findings = ranked.slice(0, agent.caps.maxComments);
    const report = await step.do('post', () =>
      postReport(env, p, agent, work.token, { summary, findings, unreviewed, withheld }),
    );
    const total = withheld + report.withheld;
    const status = report.posted > 0 ? 'findings' : 'passed';
    await repo.finish(p.run, p.attempt, status, report.posted, total, null);
    return { status, findings: report.posted, withheld: total };
  } catch (e: any) {
    return fail(env, p, e);
  }
}

async function pause(env: ManagedEnv, p: RunParams): Promise<Outcome> {
  await repoStub(env, p.repo).pause(p.run, p.attempt);
  await ledgerStub(env, p.account).pause(p.repo, p.run);
  return { status: 'paused', reason: 'no credit' };
}

async function fail(env: ManagedEnv, p: RunParams, e: any): Promise<Outcome> {
  const error =
    e instanceof PlatformError && (e.status === 401 || e.status === 403)
      ? 'The repository token was refused; disable and enable the agent to reconnect'
      : `${e?.code ?? 'ERROR'}: ${String(e?.message ?? e)}`;
  await repoStub(env, p.repo).finish(p.run, p.attempt, 'failed', 0, 0, error);
  return { status: 'failed', error };
}
