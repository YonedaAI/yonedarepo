// What demo-repos.mjs reads back at the end: each repository's Landings, memories, sessions,
// deliveries and releases as the API has them, and whether the parents moved.
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

export async function readBack(ctx, r) {
  const { owner, account, managed } = ctx;
  const { memories } = await owner.get(`/repos/${r.id}/memories?limit=50`);
  const drafts = (await owner.get(`/repos/${r.id}/memories?limit=50&status=draft`)).memories ?? [];
  const sessions = await transcriptTurns(owner, r);
  const { releases } = await owner.get(`/repos/${r.id}/releases`);
  const { refs } = await owner.get(`/repos/${r.id}/refs`);
  const { runs } = await account.get(`${managed}/runs?repo=${r.id}&limit=50`);
  return {
    url: `${ctx.origin}/source/${r.id}`,
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
