import type { OutboundHandler } from '@cloudflare/containers';
import { source } from './artifacts';
import { error, response } from './http';
import { scopeFor } from './scope';
import { ledger, object, readObject } from './storage';
import type { Env, Json } from './types';
export const brokerHandler: OutboundHandler<Env> = async (req, env, ctx) => {
  try {
    const { scope, stub } = await scopeFor(env, ctx.containerId);
    const job = scope.job;
    const path = new URL(req.url).pathname;
    const identity = { job_id: job.id, epoch: job.epoch };
    const body = await req.json<Json>();
    if (path === '/mcp') {
      if (job.kind !== 'agent') return error('FORBIDDEN', 'This attempt has no agent tools', 403);
      const args = body.arguments ?? {};
      const name = body.name;
      if (name === 'repo_context' || name === 'execution_status')
        return response(await ledger(env, scope.repo_id, { op: 'context', ...identity }));
      if (name === 'artifact_get') {
        const artifact = await ledger(env, scope.repo_id, {
          op: 'get_artifact',
          ...identity,
          id: args.id,
        });
        return response({ ...artifact, content: await readObject(env, artifact.digest) });
      }
      if (name === 'artifact_publish') {
        if (typeof args.content !== 'string' || args.content.length > 128 * 1024)
          return error('INVALID_INPUT', 'Artifact content must be bounded text');
        const stored = await object(env, args.content);
        return response(
          await ledger(env, scope.repo_id, {
            op: 'publish_artifact',
            ...identity,
            id: `artifact:${crypto.randomUUID()}`,
            digest: stored.digest,
            label: args.label,
            kind: args.kind,
            metadata: args.metadata ?? {},
          }),
        );
      }
      if (name === 'execution_complete')
        return response(
          await ledger(env, scope.repo_id, {
            op: 'hint_complete',
            ...identity,
            summary: args.summary,
          }),
        );
      return error('FORBIDDEN', 'Unknown scoped tool', 403);
    }
    if (req.headers.get('authorization') !== `Bearer ${scope.supervisor}`)
      return error('FORBIDDEN', 'Trusted supervisor capability required', 403);
    if (path === '/heartbeat' || path === '/progress')
      return response(
        await ledger(env, scope.repo_id, {
          op: path === '/progress' ? 'progress' : 'heartbeat',
          progress: body.progress,
          ...identity,
        }),
      );
    if (path === '/source') {
      if (!['agent', 'evaluate'].includes(job.kind))
        return error('FORBIDDEN', 'No source access', 403);
      return response(
        await source(
          env,
          job.kind === 'evaluate' ? job.payload.candidate.revision : job.payload.execution.base,
        ),
      );
    }
    if (path === '/workspace') {
      if (job.kind === 'capture')
        return response(JSON.parse(await readObject(env, job.payload.workspace)));
      if (job.kind === 'agent' && job.payload.execution.role === 'coding')
        return response(await object(env, JSON.stringify({ files: body.files })));
      return error('FORBIDDEN', 'No workspace upload access', 403);
    }
    if (path === '/evidence') return response(await object(env, String(body.content)));
    if (path === '/failed') {
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
      }
      const result = await ledger(env, scope.repo_id, command);
      await stub.scheduleStop();
      return response(result);
    }
    return error('FORBIDDEN', 'Unknown broker operation', 403);
  } catch (e: any) {
    return error(e.code ?? 'BROKER_FAILED', e.message, 409);
  }
};
