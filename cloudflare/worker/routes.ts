import { accountRoute } from './accounts';
import { authenticate } from './auth';
import { campaignRoute } from './campaign-route';
import {
  candidateDetail,
  candidateSource,
  hydrateOwnerSnapshot,
  publishedSource,
} from './candidate-source';
import { comparisonOwnerRoute } from './comparison-owner-route';
import { evidence } from './evidence';
import { externalGit } from './external-git';
import { grantRoute } from './grants';
import { guidedRoute } from './guided-route';
import { historyDetail } from './history-archive';
import { candidateDiffPage } from './history-pages';
import { error, readJson, response, safeId } from './http';
import { failureCode, writeLog } from './logging';
import { approveOwnerRun } from './owner-run-approval';
import { projectRoute } from './projects';
import { settingsRoute } from './provider-settings';
import { remoteMcp } from './remote-mcp';
import { ownerCommandInput, repositoryOperationAllowed } from './repository-command';
import { deleteRepository } from './repository-deletion';
import { publicationReadback, recordPublicationChecks, resynchronize } from './repository-recovery';
import { reviewerGuard, reviewerRoute } from './reviewer';
import { reviewerCampaignRoute } from './reviewer-campaign';
import { ownerSession } from './session';
import { siteRoute } from './sites';
import { sourceRoute } from './source-route';
import { ledger, sha } from './storage';
import { teamTaskSource } from './team-source';
import { approveTestPolicy } from './test-policy';
import type { Env } from './types';
import { websiteAssets } from './website-metadata';
import { workspace } from './workspace';
import { workspaceAllowanceRoute } from './workspace-allowance-route';

export async function fetchRequest(
  req: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
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
  // The platform's public API is another Worker's surface; the agent layer only proxies it.
  if (url.pathname.startsWith('/api/v1/'))
    return env.PLATFORM
      ? env.PLATFORM.fetch(req)
      : error('NOT_FOUND', 'The source platform is not bound', 404);
  try {
    const authResponse = await accountRoute(req, env);
    if (authResponse) return authResponse;
    const principal = await authenticate(req, env);
    if (!principal) return error('UNAUTHORIZED', 'Sign in to your workspace', 401);
    if (principal.role === 'agent')
      return error('FORBIDDEN', 'Use the scoped MCP and Git endpoints', 403);
    const restricted = await reviewerGuard(req, env, principal);
    if (restricted) return restricted;
    const campaign = await campaignRoute(req, env, principal);
    if (campaign) return campaign;
    const campaignReviewer = await reviewerCampaignRoute(req, env, principal);
    if (campaignReviewer) return campaignReviewer;
    const reviewer = await reviewerRoute(req, env, principal);
    if (reviewer) return reviewer;
    const settings = await settingsRoute(req, env, principal);
    if (settings) return settings;
    const allowance = await workspaceAllowanceRoute(req, env, principal);
    if (allowance) return allowance;
    if (url.pathname === '/api/budget' && req.method === 'GET')
      return response(
        await workspace(env, principal.role === 'admin' ? '_budget_claude' : principal.workspace, {
          op: 'budget_status',
        }),
      );
    const project = await projectRoute(req, env, principal, ctx);
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
    await ledger(env, repo, { op: 'repository_status', _workspace: principal.workspace });
    const guided = await guidedRoute(req, env, principal, repo, action);
    if (guided) return guided;
    const sourceResponse = await sourceRoute(req, env, principal, repo);
    if (sourceResponse) return sourceResponse;
    if (action === 'resync_repository' && req.method === 'POST')
      return await resynchronize(req, env, principal, repo);
    if (action === 'publication_readback' && req.method === 'POST')
      return await publicationReadback(req, env, principal, repo);
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
    if (action === 'published_source' && req.method === 'GET')
      return await publishedSource(env, repo);
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
    if (['approve_comparison_review', 'select_comparison_candidate'].includes(action))
      return await comparisonOwnerRoute(req, env, principal, repo, action);
    let input = await ownerCommandInput(req, action);
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

    if (action === 'start_run') input = await approveOwnerRun(env, principal, repo, input);
    const command = {
      ...input,
      op: action,
      _workspace: principal.workspace,
    };
    const value = await ledger(env, repo, command);
    if (action === 'accept') await recordPublicationChecks(env, repo, value);
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
