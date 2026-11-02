// A stand-in for dev, for the logic of tools/staging/dev-checks*.mjs: a platform that behaves as
// the undo window and legal hold are meant to, on a clock the flows advance. `bugs` makes it
// misbehave one way at a time, because a check that cannot fail proves nothing.
const DAY = 86_400_000;
const SEND_AGAIN_MS = 6 * 3_600_000;
const refuse = (status, code) => ({ status, body: { error: { code, message: code } } });
const ok = (body = {}) => ({ status: 200, body });

export function world({ windowMs = 300_000, bugs = {}, auditLog = false } = {}) {
  let now = 1_800_000_000_000;
  let ids = 0;
  const repos = new Map();
  const orgs = new Map();
  const audit = [];
  const object = (repo) => `${repo.id}`.padEnd(64, '0');
  const repoOfObject = (id) => [...repos.values()].find((r) => object(r) === id);
  const held = (repo) => Boolean(repo.holds.owner || repo.holds.operator || orgs.get(repo.owner)?.holds.owner || orgs.get(repo.owner)?.holds.operator);
  const log = (action, target) => audit.push({ action, target, at: now });

  function purge(repo) {
    repo.purged = true;
    repo.erased = true;
    repo.r2 = bugs.leaveR2Key ? 1 : 0;
    repo.row = null;
  }
  function tick() {
    for (const repo of repos.values()) {
      if (!repo.row) continue;
      if (repo.row.purge_at <= now && repo.row.sent_at <= now - SEND_AGAIN_MS) {
        repo.row.sent_at = now;
        if (!held(repo)) purge(repo);
      }
    }
  }
  const clock = {
    now: () => now,
    async sleep(ms) {
      for (let left = ms; left > 0; left -= 60_000) {
        now += Math.min(left, 60_000);
        tick();
      }
    },
  };

  const create = (who, body) => {
    const id = `r${String(++ids).padStart(20, '0')}`;
    const tokens = (body.tokens ?? []).map((t) => `yrp_${id}_${t.name}`);
    const repo = {
      id,
      name: body.name,
      owner: body.owner ?? who,
      visibility: body.visibility,
      created_at: now,
      r2: (body.files?.length ?? 0) * 3 + 1,
      tokens: new Set(tokens),
      members: new Set(),
      holds: {},
      head: `c${id}`,
      deletedAt: null,
    };
    repos.set(id, repo);
    return ok({ id, commit: repo.head, tokens: tokens.map((token) => ({ token })) });
  };

  function repoRoute(who, method, repo, rest, body, query) {
    const owned = who === 'owner';
    const token = who.startsWith?.('yrp_');
    if (method === 'POST' && rest[0] === 'restore') {
      if (!repo.deletedAt) return ok({ already: true });
      if (!owned) return refuse(404, 'GONE');
      if (repo.purged && !bugs.restoreAfterPurge) return refuse(404, 'GONE');
      const name = body.name ?? repo.name;
      if ([...repos.values()].some((r) => r !== repo && !r.deletedAt && r.owner === repo.owner && r.name === name)) return refuse(409, 'NAME_TAKEN');
      Object.assign(repo, { name, deletedAt: null, row: null });
      if (bugs.contentChanged) repo.head = 'different';
      return ok({ id: repo.id, name, restored: true });
    }
    if (repo.deletedAt) return refuse(404, 'GONE');
    if (token && !repo.tokens.has(who)) return refuse(401, 'UNAUTHORIZED');
    if (method === 'DELETE' && !rest.length) {
      if (query.get('confirm') !== repo.name) return refuse(400, 'INVALID_INPUT');
      if (held(repo) && !bugs.deleteUnderHold) return refuse(423, 'LEGAL_HOLD');
      repo.deletedAt = now;
      if (!bugs.oldTokenSurvives) repo.tokens.clear();
      repo.row = { id: repo.id, purge_at: now + windowMs, deleted_at: now, sent_at: 0 };
      if (!windowMs || bugs.purgeInWindow) purge(repo);
      return ok({ deleted: true });
    }
    if (method === 'GET' && !rest.length) return ok({ object_store: `platform:${repo.id}` });
    if (method === 'GET' && rest[0] === 'refs') return ok({ refs: { 'refs/heads/main': repo.head } });
    if (method === 'GET' && rest[0] === 'hold') return ok({ held: held(repo) });
    if (method === 'GET') return ok({});
    if (rest[0] === 'members') return repo.members.add(body.account), ok();
    if (rest[0] === 'tokens') {
      const minted = `yrp_${repo.id}_${body.name}`;
      repo.tokens.add(minted);
      return ok({ token: minted });
    }
    if (rest[0] === 'commits' && rest.length === 1) return (repo.pending = `c${++ids}`), ok({ commit: repo.pending });
    if (rest[0] === 'land') return (repo.head = body.commit), ok();
    if (rest[0] === 'changes' && rest.length === 1) return ok({ number: 1 });
    if (rest[0] === 'quarantine' && rest.length === 1) return ok({ record: { id: 1, target: { id: 'blob' } } });
    const destroys = method === 'DELETE' || rest[0] === 'vacuum' || rest.at(-1) === 'purge';
    if (destroys && held(repo)) return refuse(423, 'LEGAL_HOLD');
    return ok();
  }

  function holdRoute(method, holds, layer, by) {
    if (method === 'POST') {
      holds[layer] ??= { by, at: now };
      return ok({ hold: holds });
    }
    if (layer === 'owner' && !holds.owner && holds.operator && !bugs.ownerLiftsOperator) return refuse(403, 'FORBIDDEN');
    if (layer === 'owner' && bugs.ownerLiftsOperator) delete holds.operator;
    const released = Boolean(holds[layer]);
    delete holds[layer];
    return ok({ released, hold: holds });
  }

  function orgRoute(who, method, parts, body) {
    const [org, resource, item, sub] = parts;
    if (method === 'POST' && !org) return orgs.set(body.name, { holds: {} }), ok({ name: body.name });
    const found = orgs.get(org);
    if (!found) return refuse(404, 'NOT_FOUND');
    if (!resource && method === 'GET') return ok(auditLog ? { audit_log: true } : {});
    if (!resource && method === 'DELETE') {
      if ([...repos.values()].some((r) => r.owner === org && !r.deletedAt)) return refuse(409, 'CONFLICT');
      return held({ owner: org, holds: {} }) ? refuse(423, 'LEGAL_HOLD') : (orgs.delete(org), ok({ deleted: true }));
    }
    if (resource === 'audit') return ok({ items: audit.filter((a) => a.action.startsWith('legal_hold.')).map((a) => ({ kind: a.action, details: { layer: a.layer } })) });
    if (resource === 'members') return ok();
    if (resource === 'hold' && method === 'GET')
      return ok({ org: found.holds, repos: Object.fromEntries([...repos.values()].filter((r) => r.holds.owner).map((r) => [r.id, r.holds])) });
    if (who !== 'owner') return refuse(403, 'FORBIDDEN');
    if (resource === 'hold') return holdRoute(method, found.holds, 'owner', 'user:kit');
    if (resource === 'repos' && sub === 'hold') return holdRoute(method, repos.get(item).holds, 'owner', 'user:kit');
    return refuse(404, 'NOT_FOUND');
  }

  function adminRoute(who, method, parts, body, query) {
    if (who !== 'operator') return refuse(403, 'FORBIDDEN');
    const [section, id, action] = parts;
    if (section === 'audit') {
      const rows = bugs.missingAudit ? [] : audit;
      const before = Number(query.get('before') ?? Infinity);
      return ok({ items: rows.filter((r) => r.at < before).toReversed().slice(0, 50), next: null });
    }
    if (section === 'erase-backfill') {
      const repo = repoOfObject(body.object);
      if (!repo) return ok({ state: 'empty' });
      if (!repo.deletedAt) return ok({ state: 'live', db_bytes: 4096 });
      if (repo.erased) return ok({ state: 'erased', db_bytes: 4096 });
      if (body.dry_run) return ok({ state: 'tombstone', repo: repo.id, db_bytes: 8192 });
      log('repo.erase_backfill', repo.id);
      if (!held(repo)) purge(repo);
      return ok({ state: 'queued', repo: repo.id });
    }
    if (section === 'orgs' && action === 'hold') {
      const answer = holdRoute(method, orgs.get(id).holds, 'operator', 'ops');
      log(method === 'POST' ? 'legal_hold.set' : 'legal_hold.release', id);
      return answer;
    }
    const repo = repos.get(id);
    if (action === 'hold') {
      const answer = holdRoute(method, repo.holds, 'operator', 'ops');
      log(method === 'POST' ? 'legal_hold.set' : 'legal_hold.release', id);
      return answer;
    }
    if (action === 'purge-orphan') return refuse(409, 'CONFLICT');
    if (action === 'purge-now') {
      if (!repo.deletedAt) return refuse(409, 'CONFLICT');
      if (held(repo) && !bugs.purgeUnderHold) return refuse(423, 'LEGAL_HOLD');
      log('repo.purge_now', id);
      purge(repo);
      return ok({ queued: true });
    }
    return refuse(404, 'NOT_FOUND');
  }

  function route(who, method, path, body = {}) {
    const url = new URL(path, 'https://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'admin') return adminRoute(who, method, parts.slice(1), body, url.searchParams);
    if (parts[0] === 'orgs') return orgRoute(who, method, parts.slice(1), body);
    if (path === '/repos' && method === 'POST') return create(who === 'owner' ? 'kit' : who, body);
    if (path === '/repos') return ok({ repos: [...repos.values()].filter((r) => !r.deletedAt && who === 'owner').map((r) => ({ id: r.id, created_at: r.created_at })) });
    if (path === '/repos/deleted') {
      const rows = [...repos.values()].filter((r) => r.row && who === 'owner').map((r) => r.row);
      return ok({ window_days: windowMs / DAY, repos: rows });
    }
    return repoRoute(who, method, repos.get(parts[1]), parts.slice(2), body, url.searchParams);
  }

  const session = (who) => {
    const raw = async (method, path, body) => {
      const answer = route(who, method, path, body);
      return { ...answer, ok: answer.status === 200, headers: new Headers({ 'cf-ray': 'abc-LHR' }) };
    };
    const call = async (method, path, body) => {
      const answer = await raw(method, path, body);
      if (!answer.ok) throw new Error(`${method} ${path}: ${answer.status} ${answer.body?.error?.code}`);
      return answer.body;
    };
    return { raw, call, get: (path) => call('GET', path), post: (path, body = {}) => call('POST', path, body) };
  };

  const cf = {
    async d1(sql, [id]) {
      const repo = repos.get(id);
      if (sql.startsWith('SELECT purge_at')) return repo?.row ? [repo.row] : [];
      const table = /FROM (\w+)/.exec(sql)[1];
      const n = { platform_repos: repo && !repo.deletedAt, platform_deleted_repos: repo?.row, platform_members: repo && !repo.deletedAt && repo.members.size }[table];
      return [{ n: n ? 1 : 0 }];
    },
    async r2(prefix) {
      const repo = repos.get(prefix.split('/')[2]);
      if (bugs.probeFails) throw new Error('R2 list: HTTP 500');
      const keys = prefix.startsWith('platform/') ? (repo?.r2 ?? 0) : repo?.purged ? 0 : 1;
      return { keys, bytes: keys * 10, kinds: keys ? { git: keys } : {}, pages: 1 };
    },
    objects: async () => new Set([...repos.values()].map(object)),
    analytics: async () => ({ r2_bucket_shared: {}, object_requests: 10, object_kills_shared: {} }),
  };

  const fingerprint = (repo) => ({ head: repo.head, tree: `t${repo.head}`, commits: 3, files: { 'a.txt': 'x' } });
  const git = {
    clone: async (repo, token) => (repos.get(repo.id).deletedAt || (token && !repos.get(repo.id).tokens.has(token)) ? { ok: false, error: 'refused' } : { ok: true }),
    work: async (repo) => repo.id,
    pushLfs: async () => {},
    pushFile: async () => ({ ok: true }),
    fingerprint: async (repo) => fingerprint(repos.get(repo.id)),
    fullClone: async (repo) => ({ ok: true, ms: 1000, head: repos.get(repo.id).head }),
    pushAt: async (_source, repo, commit) => {
      const found = repos.get(repo.id);
      found.head = commit;
      found.r2 += 3500;
      return { ok: true };
    },
  };

  return { repos, audit, clock, session, cf, git, tick };
}
