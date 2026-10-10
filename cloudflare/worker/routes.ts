import { accountRoute } from './accounts';
import { authenticate } from './auth';
import { candidateDetail, candidateSource, hydrateOwnerSnapshot } from './candidate-source';
import { evidence } from './evidence';
import { externalGit } from './external-git';
import { grantRoute } from './grants';
import { historyDetail } from './history-archive';
import { candidateDiffPage } from './history-pages';
import { error, readJson, response, safeId } from './http';
import { failureCode, writeLog } from './logging';
import { projectRoute } from './projects';
import { settingsRoute } from './provider-settings';
import { remoteMcp } from './remote-mcp';
import { ownerCommandInput, repositoryOperationAllowed } from './repository-command';
import { deleteRepository } from './repository-deletion';
import { resynchronize } from './repository-recovery';
import { reviewerGuard, reviewerRoute } from './reviewer';
import { submitReviewerRepair } from './reviewer-trial';
import { checkLedger } from './runtime';
import { ownerSession } from './session';
import { siteRoute } from './sites';
import { ledger, sha } from './storage';
import { teamTaskSource } from './team-source';
import { approveTestPolicy } from './test-policy';
import type { Env, Json } from './types';
import { providerCredentials } from './vault';
import { websiteAssets } from './website-metadata';
import { workspace } from './workspace';

export async function fetchRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/health')
    return response({
      service: 'yonedarepo',
      v: 1,
      revision: env.BUILD_REVISION ?? 'development',
      models: { codex: env.CODEX_MODEL, claude: env.CLAUDE_MODEL },
    });
  if (url.pathname.startsWith('/mcp/')) return remoteMcp(req, env, url.pathname.split('/')[2]);
  if (url.pathname.startsWith('/git/'))
    return externalGit(req, env, url.pathname.split('/').filter(Boolean));
  if (!url.pathname.startsWith('/api/')) return websiteAssets(req, env);
  try {
    const authResponse = await accountRoute(req, env);
    if (authResponse) return authResponse;
    const principal = await authenticate(req, env);
    if (!principal) return error('UNAUTHORIZED', 'Sign in to your workspace', 401);
    if (principal.role === 'agent')
      return error('FORBIDDEN', 'Use the scoped MCP and Git endpoints', 403);
    const restricted = await reviewerGuard(req, env, principal);
    if (restricted) return restricted;
    const reviewer = await reviewerRoute(req, env, principal);
    if (reviewer) return reviewer;
    const settings = await settingsRoute(req, env, principal);
    if (settings) return settings;
    if (url.pathname === '/api/budget' && req.method === 'GET')
      return response(
        await workspace(env, principal.role === 'admin' ? '_budget_claude' : principal.workspace, {
          op: 'budget_status',
        }),
      );
    const project = await projectRoute(req, env, principal);
    if (project) return project;
    if (url.pathname === '/api/session' && ['POST', 'DELETE'].includes(req.method))
      return principal.role === 'admin'
        ? ownerSession(req, env)
        : error('FORBIDDEN', 'Administrator connection required', 403);
    if (url.pathname === '/api/repositories' && req.method === 'GET') {
      const identity =
        principal.role === 'user'
          ? {
              role: 'user',
              username: principal.workspace,
              ...(principal.reviewer ? { reviewer: true } : {}),
            }
          : { role: 'admin' };
      if (principal.role === 'user') {
        const value = await workspace(env, principal.workspace, { op: 'projects' });
        return response({ repositories: value.projects, identity });
      }
      const result = await env.INDEX.prepare(
        "SELECT id,payload,seq FROM repositories WHERE COALESCE(json_extract(payload,'$.workspace'),'_admin')=? AND COALESCE(json_extract(payload,'$.status'),'ready')!='deleted' ORDER BY id LIMIT 100",
      )
        .bind(principal.workspace)
        .all();
      return response({
        repositories: result.results.map((r: any) => ({ ...JSON.parse(r.payload), seq: r.seq })),
        identity,
      });
    }
    if (url.pathname === '/api/bootstrap' && req.method === 'POST') {
      if (principal.role !== 'admin')
        return error('FORBIDDEN', 'Administrator bootstrap only', 403);
      const { name, revoke_token_id } = await readJson(req);
      if (!safeId(name)) return error('INVALID_INPUT', 'Invalid repository name');
      if (typeof revoke_token_id === 'string') {
        using repo = await env.ARTIFACTS.get(name);
        return response({ revoked: await repo.revokeToken(revoke_token_id) });
      }
      try {
        const created = await env.ARTIFACTS.create(name, {
          setDefaultBranch: 'main',
          description: 'YonedaRepo demo',
        });
        using createdRepo = await env.ARTIFACTS.get(name);
        await createdRepo.revokeToken(created.token);
      } catch (e: any) {
        try {
          using existing = await env.ARTIFACTS.get(name);
          await existing.info();
        } catch {
          throw e;
        }
      }
      using repo = await env.ARTIFACTS.get(name);
      const existing = await repo.log({ ref: 'main', limit: 1 });
      if (existing.length)
        return response({ commit: existing[0].hash, remote: (await repo.info()).remote });
      const token = await repo.createToken('write', 300);
      return response({
        remote: (await repo.info()).remote,
        token: token.plaintext,
        token_id: token.id,
        expires: token.expiresAt,
      });
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const repo = parts[2];
    const requestedAction = parts[3] ?? 'snapshot';
    const action =
      req.method === 'GET' && requestedAction === 'overview'
        ? 'repository_overview'
        : req.method === 'GET' && requestedAction === 'runs'
          ? parts[4]
            ? 'run_detail'
            : 'runs_page'
          : requestedAction;
    if (parts[1] !== 'repos' || !safeId(repo)) return error('NOT_FOUND', 'Unknown API route', 404);
    if (parts.length === 4 && action === 'delete_repository' && req.method === 'POST')
      return await deleteRepository(req, env, principal, repo);
    if (action !== 'init')
      await ledger(env, repo, { op: 'repository_status', _workspace: principal.workspace });
    else if (principal.role !== 'admin')
      return error('FORBIDDEN', 'Use project creation to initialize a repository', 403);
    if (action === 'resync_repository' && req.method === 'POST')
      return await resynchronize(req, env, principal, repo);
    if (action === 'approve_test_bundle' && req.method === 'POST')
      return await approveTestPolicy(req, env, principal, repo);
    if (action === 'grants') return grantRoute(req, env, principal, repo);
    if (action === 'site' && req.method === 'GET') {
      const s = await ledger(env, repo, { op: 'repository_status' });
      return s.site?.digest && env.SITE_ORIGIN
        ? response({ url: `${env.SITE_ORIGIN}/p/${repo}/`, commit: s.site.commit })
        : error('NOT_FOUND', 'No website has been published', 404);
    }
    if (action === 'site_preview' && req.method === 'GET') return await siteRoute(env, repo, req);
    if (action === 'evidence' && req.method === 'GET')
      return await evidence(env, repo, url.searchParams.get('digest') ?? '');
    if (action === 'candidate' && req.method === 'GET')
      return await candidateDetail(env, repo, url.searchParams.get('id') ?? '');
    if (action === 'candidate_source' && req.method === 'GET')
      return await candidateSource(env, repo, url.searchParams.get('id') ?? '');
    if (action === 'candidate_diff' && req.method === 'GET')
      return response(
        await candidateDiffPage(
          env,
          repo,
          url.searchParams.get('run_id') ?? '',
          url.searchParams.get('id') ?? '',
          url.searchParams.get('cursor') ?? undefined,
          url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50,
          url.searchParams.get('watermark') ?? undefined,
        ),
      );
    if (action === 'team_source' && req.method === 'GET')
      return await teamTaskSource(
        env,
        repo,
        url.searchParams.get('run_id') ?? '',
        url.searchParams.get('task_id') ?? '',
      );
    if (action === 'live' && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      await ledger(env, repo, { op: 'repository_status' });
      return env.LIVE.get(env.LIVE.idFromName(repo)).fetch(req);
    }
    if (!repositoryOperationAllowed(req.method, action))
      return error('NOT_FOUND', 'Unknown repository operation', 404);
    const input = await ownerCommandInput(req, action);
    if (action === 'job_status') {
      if (typeof input.id !== 'string' || !input.id || input.id.length > 256)
        return error('INVALID_INPUT', 'A bounded job id is required');
    }
    if (action === 'run_detail' && requestedAction === 'runs')
      input.run_id = decodeURIComponent(parts[4]);
    if (action === 'run_detail') {
      if (typeof input.run_id !== 'string' || !input.run_id)
        return error('INVALID_INPUT', 'Missing run_id');
      return response(await historyDetail(env, repo, input.run_id));
    }

    if (action === 'init') {
      input.workspace_transport = 'git-native-v1';
      if (input.id !== repo || input.remote?.namespace !== env.ARTIFACTS_NAMESPACE)
        return error('INVALID_INPUT', 'Repository identity mismatch');
      using remote = await env.ARTIFACTS.get(input.remote.name);
      const head = (await remote.log({ ref: 'main', limit: 1 }))[0]?.hash;
      if (head !== input.commit)
        return error('HEAD_MOVED', 'Initialization must use the actual canonical HEAD', 409);
    }
    if (action === 'start_run') {
      input.workspace_transport = 'git-native-v1';
      checkLedger(await ledger(env, repo, { op: 'repository_status' }), input);
    }
    if (action === 'start_run' && principal.role === 'user') {
      const settings = await workspace(env, principal.workspace, { op: 'settings' });
      if (
        !Array.isArray(input.agents) ||
        input.agents.some(
          (agent: Json) =>
            !settings.providers.some(
              (p: Json) =>
                p.id === (agent.connection ?? agent.provider) &&
                p.provider === agent.provider &&
                p.model === agent.model,
            ),
        )
      )
        return error(
          'PROVIDER_MISSING',
          'Choose agents with the models configured in your provider settings',
          409,
        );
      for (const agent of input.agents) {
        const connection = settings.providers.find(
          (p: Json) => p.id === (agent.connection ?? agent.provider),
        );
        // Product and region come from the owner's saved connection, never browser/model claims.
        delete agent.routing;
        if (connection.routing != null) agent.routing = connection.routing;
      }
      // Check the stored key/plan before committing any paid work, including legacy connections.
      const checked = new Set<string>();
      for (const agent of input.agents) {
        const id = agent.connection ?? agent.provider;
        if (checked.has(id)) continue;
        await providerCredentials(
          env,
          principal.workspace,
          agent.provider,
          id,
          agent.model,
          agent.routing,
        );
        checked.add(id);
      }
    }
    const command = {
      ...input,
      op: action,
      _workspace: principal.workspace,
      ...(action === 'init' ? { workspace: principal.workspace } : {}),
    };
    const value =
      action === 'repair_team' && principal.reviewer
        ? await submitReviewerRepair(env, principal.workspace, repo, command)
        : await ledger(env, repo, command);
    if (action === 'cancel_run')
      for (const stop of value.stop) {
        const name = await sha(`${repo}:${stop.job_id}:${stop.epoch}`);
        await env.EXECUTIONS.get(env.EXECUTIONS.idFromName(name)).stop();
      }
    return response(action === 'snapshot' ? await hydrateOwnerSnapshot(env, value) : value);
  } catch (e: any) {
    const repo = url.pathname.split('/')[3];
    writeLog('request.rejected', {
      ...(url.pathname.startsWith('/api/repos/') && safeId(repo) ? { repo_id: repo } : {}),
      http_status: e.code === 'FORBIDDEN' ? 403 : e.code === 'REPOSITORY_DELETED' ? 410 : 409,
      error_code: failureCode(e),
    });
    return error(
      e.code ?? 'REQUEST_FAILED',
      e.message ?? 'Request failed',
      e.code === 'FORBIDDEN' ? 403 : e.code === 'REPOSITORY_DELETED' ? 410 : 409,
    );
  }
}
