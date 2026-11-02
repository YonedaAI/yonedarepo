// What demo-repos.mjs reads back at the end: each repository's Landings, memories, sessions,
// deliveries and releases as the API has them, and whether the parents moved.
import { AGENTS_BY_KIND, REPOS } from './demo-repos-plan.mjs';

const q = (params) => new URLSearchParams(params).toString();

async function landings(owner, r) {
  const rows = [];
  for (const status of ['landed', 'open']) {
    const { changes } = await owner.get(`/repos/${r.id}/changes?status=${status}`);
    for (const c of changes) {
      const full = await owner.get(`/repos/${r.id}/changes/${c.number}`);
      const route = await owner.get(`/repos/${r.id}/changes/${c.number}/route`);
      const said = full.clearances?.[0];
      rows.push({
        number: c.number,
        title: full.title,
        branch: full.branch,
        state: status === 'landed' ? 'landed' : (said?.decision ?? 'none'),
        reasons: said?.reasons?.map((x) => x.code) ?? [],
        plan: full.flight_plan?.goal ?? null,
        checks: Object.fromEntries((full.head_commit?.checks ?? []).map((k) => [k.name, k.status])),
        sessions: new Set(route.sessions.map((s) => s.session_id)).size,
        deliveries: route.deliveries.map((d) => d.trigger),
        memories_delivered: route.totals?.memories_delivered ?? 0,
      });
    }
  }
  return rows.sort((a, b) => a.number - b.number);
}

async function transcriptTurns(owner, r) {
  const { sessions } = await owner.get(`/repos/${r.id}/sessions?limit=50`);
  const counts = [];
  for (const s of sessions) {
    const read = await owner.raw('GET', `/repos/${r.id}/sessions/${s.id}/transcript`);
    counts.push({ session: s.session_id, turns: read.body?.document?.turns?.length ?? 0, model: s.model });
  }
  return counts;
}

async function deliveries(owner, r, sessions) {
  const kept = {};
  for (const { session } of sessions) {
    const { deliveries: rows } = await owner.get(`/repos/${r.id}/context/deliveries?${q({ session_id: session })}`);
    kept[session] = rows.map((d) => ({ trigger: d.trigger, subject: d.subject ?? null, memories: d.items.filter((i) => i.type === 'memory').length }));
  }
  return kept;
}

/** The proof on one Landing: the trap memory delivered, in the transcript's context, followed. */
async function proofOn(ctx, r, flight, text) {
  const { owner } = ctx;
  const { memories } = await owner.get(`/repos/${r.id}/memories?limit=50`);
  const memory = memories.find((m) => m.text === text);
  const route = await owner.get(`/repos/${r.id}/changes/${flight.number}/route`);
  const session = route.sessions[0];
  const { deliveries: rows } = await owner.get(`/repos/${r.id}/context/deliveries?${q({ session_id: session.session_id })}`);
  const shown = rows.find((d) => d.items.some((i) => i.type === 'memory' && i.id === memory?.id));
  const { document } = await owner.get(`/repos/${r.id}/sessions/${session.id}/transcript`);
  const replies = document.turns.filter((t) => t.kind === 'reply').map((t) => t.text);
  return {
    url: `${ctx.origin}/source/${r.id}/changes/${flight.number}`,
    session: session.session_id,
    memory: memory?.id ?? null,
    delivered_on: shown?.trigger ?? null,
    subject: shown?.subject ?? null,
    in_transcript_context: Boolean(document.context?.includes(text.slice(0, 60))),
    last_reply: replies.at(-1)?.slice(0, 400) ?? null,
    oracle: flight.proof?.outcome ?? null,
    paths: flight.proof?.paths ?? [],
  };
}

export async function readBack(ctx, r, state) {
  const { owner, account, managed } = ctx;
  const { memories } = await owner.get(`/repos/${r.id}/memories?limit=50`);
  const drafts = (await owner.get(`/repos/${r.id}/memories?limit=50&status=draft`)).memories ?? [];
  const sessions = await transcriptTurns(owner, r);
  const { releases } = await owner.get(`/repos/${r.id}/releases`);
  const { refs } = await owner.get(`/repos/${r.id}/refs`);
  const { runs } = await account.get(`${managed}/runs?repo=${r.id}&limit=50`);
  const plan = REPOS[r.key];
  const proofs = {};
  for (const [id, flight] of Object.entries(state.flights ?? {})) {
    const trap = plan.flights[id]?.proof && plan.memories.find((m) => m.trapOf === plan.flights[id].proof);
    if (trap && flight.number) proofs[id] = await proofOn(ctx, r, flight, trap.text);
  }
  const byAgent = {};
  for (const [id, flight] of Object.entries(state.flights ?? {})) {
    const kind = flight.run?.kind;
    if (!kind) continue;
    byAgent[kind] ??= { label: AGENTS_BY_KIND[kind].label, runs: 0, landings: [], input_tokens: 0, cached_tokens: 0, output_tokens: 0, usd: 0, seconds: 0 };
    const row = byAgent[kind];
    row.runs++;
    row.landings.push(`${id} #${flight.number} ${flight.outcome}`);
    row.input_tokens += flight.run.input ?? 0;
    row.cached_tokens += flight.run.cache_read ?? 0;
    row.output_tokens += flight.run.output ?? 0;
    row.usd = Number((row.usd + (flight.run.usd ?? 0)).toFixed(4));
    row.seconds += Math.round((flight.run.ms ?? 0) / 1000);
  }
  return {
    url: `${ctx.origin}/source/${r.id}`,
    feature: plan.feature,
    proofs,
    agents: byAgent,
    landings: await landings(owner, r),
    memories: memories.length,
    stale: memories.filter((m) => m.stale).map((m) => m.id),
    kinds: [...new Set(memories.map((m) => m.kind))],
    authors: [...new Set(memories.map((m) => m.author))],
    drafts: drafts.length,
    sessions,
    deliveries: await deliveries(owner, r, sessions),
    tags: Object.keys(refs).filter((n) => n.startsWith('refs/tags/')),
    releases: releases.map((x) => ({ tag: x.tag, title: x.title, assets: x.asset_count })),
    review_runs: runs.length,
    review_usd: Number(runs.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0).toFixed(6)),
  };
}
