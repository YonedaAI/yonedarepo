import type { OutboundHandler } from '@cloudflare/containers';
import { source } from './artifacts';
import { CANDIDATE_DIFF_LIMIT } from './evidence';
import { hostedMcp } from './hosted-mcp';
import { error, readJson, response } from './http';
import { attemptLog, failureCode } from './logging';
import { scopeFor } from './scope';
import { ledger, object, readObject } from './storage';
import { teamAttemptSource } from './team-source';
import type { Env, Json } from './types';
export const brokerHandler: OutboundHandler<Env> = async (req, env, ctx) => {
  try {
    const { scope, stub } = await scopeFor(env, ctx.containerId);
    const job = scope.job;
    const path = new URL(req.url).pathname;
    const identity = { job_id: job.id, epoch: job.epoch };
    // Authenticate supervisor endpoints before consuming an untrusted large body.
    if (path !== '/mcp' && req.headers.get('authorization') !== `Bearer ${scope.supervisor}`)
      return error('FORBIDDEN', 'Trusted supervisor capability required', 403);
    const body = await readJson(req, path === '/mcp' ? 1024 * 1024 : 32 * 1024 * 1024);
    // Await inside this boundary so ledger rejections reach the agent as typed JSON.
    if (path === '/mcp') return await hostedMcp(env, scope, body);
    if (path === '/heartbeat' || path === '/progress')
      return response(
        await ledger(env, scope.repo_id, {
          op: path === '/progress' ? 'progress' : 'heartbeat',
          progress: body.progress,
          ...identity,
        }),
      );
    if (path === '/source') {
      if (
        !['agent', 'evaluate'].includes(job.kind) &&
        !(job.kind === 'capture' && job.payload.execution?.team_task)
      )
        return error('FORBIDDEN', 'No source access', 403);
      return response(
        await source(
          env,
          job.kind === 'evaluate'
            ? job.payload.candidate.revision
            : job.kind === 'capture'
              ? job.payload.base
              : job.payload.execution.base,
          job.kind === 'evaluate' ? job.payload.candidate.tree : undefined,
        ),
      );
    }
    if (path === '/team_source') return response(await teamAttemptSource(env, job, body.index));
    if (path === '/workspace') {
      if (job.kind === 'capture')
        return response(JSON.parse(await readObject(env, job.payload.workspace)));
      if (job.kind === 'agent' && job.payload.execution.role === 'coding')
        return response(await object(env, JSON.stringify({ files: body.files }), 12 * 1024 * 1024));
      return error('FORBIDDEN', 'No workspace upload access', 403);
    }
    if (path === '/site') {
      if (job.kind !== 'evaluate' || !job.payload.policy.build?.static_dir)
        return error('FORBIDDEN', 'Only static evaluators capture assets', 403);
      const manifest = {
        repo: scope.repo_id,
        candidate: job.payload.candidate.id,
        revision: job.payload.candidate.revision,
        files: body.files,
      };
      const stored = await object(env, JSON.stringify(manifest), 12 * 1024 * 1024);
      return response(
        await ledger(env, scope.repo_id, {
          op: 'register_site',
          ...identity,
          digest: stored.digest,
          files: body.files,
        }),
      );
    }
    if (path === '/evidence') {
      const stored = await object(env, String(body.content));
      // Record before completion: a failed CLI still has owner-readable evidence.
      if (job.kind === 'agent')
        await ledger(env, scope.repo_id, {
          op: 'record_transcript',
          ...identity,
          digest: stored.digest,
        });
      return response(stored);
    }
    if (path === '/failed') {
      await attemptLog(env, scope, 'execution.failure_received', {
        error_code: failureCode({
          code:
            body.error === 'Execution deadline exceeded'
              ? 'EXECUTION_TIMEOUT'
              : typeof body.error === 'string'
                ? body.error.split(':')[0]
                : undefined,
        }),
      });
      const result = await ledger(env, scope.repo_id, {
        op: 'fail',
        ...identity,
        error: String(body.error).slice(0, 2000),
        retryable: body.retryable === true,
      });
      await stub.scheduleStop();
      return response(result);
    }
    if (path === '/complete') {
      let command: Json = { op: 'finish', ...identity, result: body };
      if (job.kind === 'evaluate') {
        const stored = await object(env, JSON.stringify(body));
        command = { op: 'verify_finish', ...identity, report: body, evidence: stored.digest };
      }
      if (job.kind === 'capture') {
        if (!scope.fork || body.revision?.repository !== scope.fork)
          return error('FORBIDDEN', 'Captured repository mismatch', 403);
        using captured = await env.ARTIFACTS.get(scope.fork.split('/')[1]);
        const commit = await captured.readCommit(body.revision.commit);
        if (
          !commit ||
          commit.treeHash !== body.tree ||
          commit.parents.length !== 1 ||
          commit.parents[0] !== job.payload.base.commit
        )
          return error('INVALID_CAPTURE', 'Captured commit identity or parent mismatch', 409);
        if (typeof body.diff !== 'string')
          return error('INVALID_CAPTURE', 'Trusted capture must supply the full diff', 409);
        // Only the container-derived capture capability can create this binding, after
        // checking the freshly pushed commit. Never accept a caller-provided R2 digest.
        const stored = await object(env, body.diff, CANDIDATE_DIFF_LIMIT);
        const { diff: _diff, diff_digest: _claimedDigest, ...metadata } = body;
        command = {
          op: 'finish',
          ...identity,
          result: { ...metadata, diff_digest: stored.digest },
        };
      }
      await attemptLog(env, scope, 'execution.completion_received');
      const result = await ledger(env, scope.repo_id, command);
      await stub.scheduleStop();
      return response(result);
    }
    return error('FORBIDDEN', 'Unknown broker operation', 403);
  } catch (e: any) {
    return error(e.code ?? 'BROKER_FAILED', e.message, 409);
  }
};
