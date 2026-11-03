// Public API of the YonedaRepo source platform (`/api/v1`). A thin adapter: it
// authenticates, maps routes onto the shared operation table, and forwards commands to
// the repository's SourceRepository Durable Object, which owns every decision. Callers
// are workspace sessions (owners) or repository tokens (agents, CI, scripts) — all the
// same to us.

import { mergeListed, mergeSearch } from './cell-merge';
import { acrossCells, askCell, repoElsewhere } from './cell-route';
import { accountActivity, mergeActivity } from './platform-account-activity';
import { adminRoute } from './platform-admin';
import { accountContributions, mergeContributions } from './platform-contributions';
import { favoritesRoute } from './platform-favorites';
import { repoHold } from './platform-holds';
import { orgsRoute } from './platform-orgs';
import { sshKeyRoute } from './platform-ssh-keys';
import { SUPPORT_BODY_LIMIT, supportRoute } from './platform-support';
import { deviceRoute, tokenRoute } from './platform-tokens';
import { accountSearch } from './repo-account-search';
import { deleteRepository, listDeleted, listRepositories } from './repo-admin';
import { agentRecords } from './repo-agent-records';
import { bodyOf, COMMIT_BODY_LIMIT } from './repo-api-body';
import { failure } from './repo-api-failure';
import { handle } from './repo-api-http';
import { audited } from './repo-audit';
import { breakGlass } from './repo-break-glass';
import { changeLogStatus } from './repo-changelog';
import { changesRoute, setAutoLandings } from './repo-changes';
import { compactionRead, compactLog } from './repo-compaction';
import { createRepository, importRepository, tokenSecret } from './repo-create';

export { credentials } from './repo-credentials';

import { withHeadRefresh } from './repo-access-changes';
import { hooksRoute } from './repo-hooks';
import { importProgress } from './repo-import-start';
import { lfsRoute } from './repo-lfs';
import { membersRoute } from './repo-members';
import { contextRoute, memoriesRoute } from './repo-memories';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { overview, overviewRequested } from './repo-overview';
import { renameRepository, withPath } from './repo-paths';
import { forViewer } from './repo-principal-privacy';
import { capped, setVisibility } from './repo-public';
import { purgeDeleted } from './repo-purge';
import { quarantineRoute } from './repo-quarantine';
import { regionHintTest, whereRepository } from './repo-region-hint';
import { releasesRoute } from './repo-releases';
import { restoreRepository } from './repo-restore';
import { SESSION_BODY_LIMIT } from './repo-session-records';
import { timedAnswer } from './repo-span-sample';
import { batchRefs, branchesRoute, operations } from './repo-tools';
import { vacuum } from './repo-vacuum';
import { humanView } from './repo-views';
import { ensureScope } from './request-scope';
import type { Env } from './types';

/** A REST answer as its caller may see it: a repository's names no account address to a
 * non-member (principal-privacy). The account MCP's management tools come through here too. */
export async function route(req: Request, env: Env, url: URL, auth: Credentials): Promise<Json> {
  // An in-process caller (the account MCP, say) may name a repository of another cell.
  const elsewhere = repoElsewhere(env, url);
  if (elsewhere) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text();
    const { method, headers } = req;
    return askCell(env, elsewhere, `${url.pathname}${url.search}`, { method, headers, body });
  }
  const value = await routed(req, env, url, auth);
  const repo = /^\/api\/v1\/repos\/(r[0-9a-f]{20})(?:\/|$)/.exec(url.pathname)?.[1];
  const browserStatus =
    repo &&
    req.method === 'GET' &&
    url.pathname === `/api/v1/repos/${repo}` &&
    url.searchParams.get('summary') === 'true';
  return repo
    ? forViewer(env, value, () =>
        browserStatus
          ? Promise.resolve(value) // This answer already contains the freshly checked viewer.
          : caller(env, repo, auth)({ op: 'repo_status' }),
      )
    : value;
}

async function routed(req: Request, env: Env, url: URL, auth: Credentials): Promise<Json> {
  const parts = url.pathname.split('/').filter(Boolean).slice(2); // after api/v1
  if (parts[0] === 'tokens' && parts.length <= 2)
    return tokenRoute(env, auth, req.method, parts[1], () => bodyOf(req));
  if (parts[0] === 'ssh-keys' && parts.length <= 2)
    return sshKeyRoute(env, auth, req.method, parts[1], () => bodyOf(req));
  if (parts[0] === 'device' && parts.length === 2)
    return deviceRoute(env, auth, parts[1], req, url, () => bodyOf(req));
  if (parts[0] === 'activity' && parts.length === 1 && req.method === 'GET')
    return acrossCells(env, url.pathname, () => accountActivity(env, auth), mergeActivity);
  if (
    parts[0] === 'activity' &&
    parts[1] === 'contributions' &&
    parts.length === 2 &&
    req.method === 'GET'
  )
    return acrossCells(
      env,
      `${url.pathname}${url.search}`,
      () => accountContributions(env, auth, url),
      mergeContributions,
    );
  if (parts[0] === 'search' && parts.length === 1 && req.method === 'GET')
    return acrossCells(
      env,
      `${url.pathname}${url.search}`,
      () => accountSearch(env, auth, url, route),
      mergeSearch,
    );
  if (parts[0] === 'support' && parts.length === 1 && req.method === 'POST')
    return supportRoute(env, auth, () => bodyOf(req, SUPPORT_BODY_LIMIT));
  if (parts[0] === 'favorites' && parts.length <= 2)
    return favoritesRoute(env, auth, req.method, parts[1]);
  if (parts[0] === 'admin')
    return adminRoute(env, auth, req.method, parts.slice(1), () => bodyOf(req), url.searchParams);
  if (parts[0] === 'orgs')
    return orgsRoute(env, auth, req.method, parts.slice(1), () => bodyOf(req), url.searchParams);
  if (parts[0] !== 'repos') throw new ApiError('NOT_FOUND', 'Unknown API path');
  if (parts.length === 1 && req.method === 'POST')
    return createRepository(env, auth, await bodyOf(req, COMMIT_BODY_LIMIT));
  if (parts.length === 2 && parts[1] === 'import' && req.method === 'POST')
    return importRepository(env, auth, await bodyOf(req));
  if (parts.length === 1 && req.method === 'GET')
    return acrossCells(env, url.pathname, () => listRepositories(env, auth), mergeListed);
  if (parts.length === 2 && parts[1] === 'deleted' && req.method === 'GET')
    return acrossCells(env, url.pathname, () => listDeleted(env, auth), mergeListed);
  const repo = parts[1];
  if (!/^r[0-9a-f]{20}$/.test(repo ?? '')) throw new ApiError('NOT_FOUND', 'Unknown repository');
  const ctx = new RepoContext(env, repo, caller(env, repo, auth));
  const [resource, sha, sub] = parts.slice(2);
  const get = req.method === 'GET';
  const post = req.method === 'POST';
  const query = Object.fromEntries(url.searchParams);
  const run = (name: string, args: Json) => operations[name](ctx, args);
  if (!resource && req.method === 'DELETE')
    return deleteRepository(env, auth, repo, url.searchParams.get('confirm') ?? '');
  if (resource === 'restore' && !sha && post)
    return restoreRepository(env, auth, repo, (await bodyOf(req).catch(() => ({}) as Json)).name);
  if (resource === 'purge' && !sha && post) return purgeDeleted(env, auth, repo);
  if (resource === 'refs' && sha === 'batch' && !sub && post)
    return batchRefs(ctx, await bodyOf(req));
  if (!resource && get && url.searchParams.get('summary') === 'true') {
    // Browser metadata must not wait for storage diagnostics across every shard.
    const { objects: _objects, ...summary } = await ctx.status();
    const decorated = await withPath(env, repo, summary);
    return overviewRequested(env, url.searchParams)
      ? { ...decorated, overview: await overview(ctx, summary, url.searchParams) }
      : decorated;
  }
  if (!resource && get) return withPath(env, repo, await run('git_status', {}));
  if (resource === 'name' && !sha && req.method === 'PUT')
    return renameRepository(ctx, (await bodyOf(req)).name);
  if (resource === 'hold' && !sha && get) return repoHold(ctx);
  if (resource === 'quarantine')
    return quarantineRoute(ctx, req.method, sha, sub, () => bodyOf(req));
  if (get && resource === 'refs') return run('git_refs', query);
  if (get && resource === 'log') return run('git_log', query);
  if (get && resource === 'txlog') return run('git_txlog', query);
  if (get && resource === 'changelog') return changeLogStatus(ctx);
  if (get && resource === 'merge-base') return run('git_merge_base', query);
  if (get && resource === 'tree') return run('git_ls_tree', query);
  if (get && resource === 'blob') return run('git_cat_file', query);
  if (get && resource === 'search')
    return run('git_grep', { ...capped(auth, query), ignore_case: query.ignore_case === 'true' });
  if (get && resource === 'blame') return run('git_blame', capped(auth, query));
  const records = get ? agentRecords(ctx, resource, sha, sub, query) : undefined;
  if (records) return records;
  if (get && resource === 'symbols') return run('symbol_list', query);
  if (get && resource === 'symbol') return run('symbol_get', query);
  if (get && resource === 'contract') return run('symbol_contract', query);
  if (resource === 'contracts' && post) return run('symbol_contract_record', await bodyOf(req));
  if (get && resource === 'views' && sha === 'agent') return run('symbol_view', query);
  if (get && resource === 'views' && sha === 'human') return humanView(ctx, query);
  if (resource === 'symbol-edits' && post)
    return run('symbol_edit', await bodyOf(req, COMMIT_BODY_LIMIT));
  if (resource === 'codemods' && post) return run('git_codemod', await bodyOf(req));
  if (resource === 'plans' && post) return run('git_plan', await bodyOf(req));
  if (resource === 'flight-plans' && post) return run('git_flight_plan', await bodyOf(req));
  if (resource === 'bisect' && post) return run('git_bisect', await bodyOf(req));
  if (resource === 'bisect' && sha && get) return run('git_bisect', { id: sha });
  if (resource === 'commits' && sha && sub === 'pin' && post)
    return run('git_pin', { ...(await bodyOf(req)), commit: sha });
  if (resource === 'vacuum' && post) return vacuum(ctx, await bodyOf(req).catch(() => ({})));
  // Owner-run log compaction (the derive job also runs it after landings) and its bound.
  if (resource === 'compact' && post) return compactLog(env, repo, ctx.call);
  // The owner's read of the floor, tail and database size; changes nothing (the load tests'
  // sampler, tools/fanout-bench/sampler.mjs).
  if (resource === 'compaction' && get) return compactionRead(ctx, query.shards === '1');
  // Where this repository's objects run (repo-region-hint.ts); off, an unknown path.
  if (resource === 'where' && get && regionHintTest(env)) return whereRepository(ctx, auth);
  if (resource === 'retention' && req.method === 'PUT') {
    const { keep_versions, keep_days } = await bodyOf(req);
    return audited(env, repo, ctx.call({ op: 'repo_set_retention', keep_versions, keep_days }));
  }
  if (get && resource === 'diff')
    return run('git_diff', {
      ...query,
      patch: query.patch === '1' || query.patch === 'true',
      merge_base: query.merge_base === '1' || query.merge_base === 'true',
    });
  if (resource === 'commits' && sha && !sub && get) return run('git_show', { commit: sha });
  if (resource === 'commits' && !sha && post)
    return run('git_commit', await bodyOf(req, COMMIT_BODY_LIMIT));
  if (resource === 'commits' && sha && sub === 'checks' && post)
    return run('git_check', { ...(await bodyOf(req)), commit: sha });
  if (resource === 'commits' && sha && sub === 'sessions' && post)
    return run('git_session_record', { ...(await bodyOf(req, SESSION_BODY_LIMIT)), commit: sha });
  if (resource === 'commits' && sha && sub === 'sessions' && get)
    return run('git_sessions', { commit: sha });
  if (resource === 'context' && !sha && get) return run('git_context', query);
  if (resource === 'ctc' && !sha && get) return run('git_ctc_radar', query);
  if (resource === 'context' && sha && !sub)
    return contextRoute(ctx, req.method, sha, query, () => bodyOf(req));
  if (resource === 'memories')
    return memoriesRoute(ctx, req.method, sha, sub, query, () => bodyOf(req));
  if (resource === 'commits' && sha && sub === 'reviews' && post)
    return run('git_review', { ...(await bodyOf(req)), commit: sha });
  if (resource === 'commits' && sha && sub === 'revert' && post)
    return run('git_revert', { ...(await bodyOf(req).catch(() => ({}))), commit: sha });
  if (resource === 'commits' && sha && sub === 'cherry-pick' && post)
    return run('git_cherry_pick', { ...(await bodyOf(req).catch(() => ({}))), commit: sha });
  if (resource === 'commits' && sha && sub === 'check-runs' && post)
    return run('git_check_run', { ...(await bodyOf(req).catch(() => ({}))), commit: sha });
  if (resource === 'check-runs' && sha && get) {
    const detail = await ctx.call({ op: 'repo_check_run', run_id: sha });
    if (sub !== 'log') return detail;
    const key = detail.result?.log;
    // The key is ours (built per repository by the executor), but never trust stored state.
    if (typeof key !== 'string' || !key.startsWith(`platform/v1/${repo}/checks/${sha}/`))
      throw new ApiError('NOT_FOUND', 'This run has no log');
    const log = await env.OBJECTS.get(key);
    if (!log) throw new ApiError('NOT_FOUND', 'This run has no log');
    return { run_id: sha, log: await log.text() };
  }
  if (resource === 'import' && get) return importProgress(ctx);
  // Access changes republish main's head (begins and reads decide access from it).
  if (resource === 'visibility' && req.method === 'PUT')
    return setVisibility(ctx, await bodyOf(req));
  if (resource === 'policy' && req.method === 'PUT')
    return withHeadRefresh(
      env,
      repo,
      audited(env, repo, ctx.call({ op: 'repo_set_policy', policy: (await bodyOf(req)).policy })),
    );
  if (resource === 'auto-landings' && req.method === 'PUT')
    return setAutoLandings(ctx, await bodyOf(req));
  if (resource === 'objects' && post)
    return run('git_get_objects', await bodyOf(req, 2 * 1024 * 1024));
  if (resource === 'merges' && post) return run('git_merge', await bodyOf(req));
  // The landing mode is chosen per request only where the deployment allows it.
  if (resource === 'land' && post)
    return run('git_land', {
      ...(await bodyOf(req)),
      land_mode: req.headers.get('x-yoneda-land-mode'),
    });
  if (resource === 'branches' && post) return branchesRoute(ctx, parts.slice(3), () => bodyOf(req));
  if (resource === 'tags' && !sha && post) return run('git_tag', await bodyOf(req));
  if (resource === 'tags' && sha && !sub && get)
    return ctx.call({ op: 'repo_tag_show', name: decodeURIComponent(sha) });
  if (resource === 'break-glass' && post) return breakGlass(ctx, await bodyOf(req));
  if (resource === 'hooks') return hooksRoute(ctx, req.method, sha, sub, () => bodyOf(req));
  if (resource === 'members' && !sub) return membersRoute(ctx, req.method, sha, () => bodyOf(req));
  if (resource === 'changes') return changesRoute(ctx, req, sha, sub, () => bodyOf(req));
  if (resource === 'lfs' && !sha) return lfsRoute(ctx, req.method, () => bodyOf(req));
  if (resource === 'fork' && !sha && post) return run('git_fork', await bodyOf(req));
  if (resource === 'releases') return releasesRoute(ctx, req, parts.slice(3), () => bodyOf(req));
  if (resource === 'tokens' && get) return ctx.call({ op: 'repo_tokens' });
  if (resource === 'tokens' && !sha && post) {
    const body = await bodyOf(req);
    const secret = tokenSecret();
    const created = await withHeadRefresh(
      env,
      repo,
      audited(
        env,
        repo,
        ctx.call({
          op: 'repo_token_create',
          name: body.name,
          scopes: body.scopes,
          paths: body.paths ?? null,
          _secret: secret,
        }),
      ),
    );
    return { ...created, token: secret };
  }
  if (resource === 'tokens' && sha && req.method === 'DELETE')
    return withHeadRefresh(
      env,
      repo,
      audited(env, repo, ctx.call({ op: 'repo_token_revoke', name: sha })),
    );
  throw new ApiError('NOT_FOUND', 'Unknown API path');
}

export function repoApi(req: Request, env: Env): Promise<Response> {
  // Failures outside a route (authentication, MCP framing) are mapped like a route's.
  return ensureScope({ env, req }, () =>
    timedAnswer(env, req, () => handle(req, env, route).catch(failure)),
  );
}
