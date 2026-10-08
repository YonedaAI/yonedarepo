import tools from '../crates/yoneda-core/src/mcp_remote_tools.json';
import { contribution } from './contributions';
import { grantPrincipal } from './grants';
import { error, readJson, response, safeId } from './http';
import { ledger, readObject } from './storage';
import type { Env, Json, Principal } from './types';
export async function remoteMcp(req: Request, env: Env, repo: string): Promise<Response> {
  if (!safeId(repo)) return error('NOT_FOUND', 'Unknown repository', 404);
  const principal = await grantPrincipal(req, env);
  if (!principal) return error('UNAUTHORIZED', 'Repository agent key required', 401);
  if (req.headers.has('origin') && req.headers.get('origin') !== new URL(req.url).origin)
    return error('FORBIDDEN', 'Unexpected MCP origin', 403);
  if (principal.grant?.repo !== repo)
    return error('FORBIDDEN', 'Key belongs to another repository', 403);
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  try {
    const body = await readJson(req, 256 * 1024);
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string')
      throw new Error('Invalid JSON-RPC message');
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: Json;
    if (body.method === 'initialize')
      result = {
        protocolVersion: ['2025-06-18', '2025-03-26'].includes(body.params?.protocolVersion)
          ? body.params.protocolVersion
          : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'yonedarepo', version: '0.2.0' },
      };
    else if (body.method === 'ping') result = {};
    else if (body.method === 'tools/list') result = { tools };
    else if (body.method === 'tools/call') {
      try {
        const args = body.params?.arguments ?? {};
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw new Error('Tool arguments must be an object');
        const value = await callTool(
          env,
          principal,
          repo,
          body.params?.name,
          args,
          new URL(req.url).origin,
        );
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (e) {
        result = { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
      }
    } else
      return response({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'Unknown MCP method' },
      });
    return response({ jsonrpc: '2.0', id: body.id, result });
  } catch (e) {
    return response(
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: (e as Error).message } },
      400,
    );
  }
}
async function callTool(
  env: Env,
  principal: Principal,
  repo: string,
  name: string,
  args: Json,
  origin: string,
): Promise<Json> {
  const command = (input: Json) =>
    ledger(env, repo, { ...input, _workspace: principal.workspace, _grant: principal.grant?.id });
  if (name === 'repo_context') {
    const s = await command({ op: 'snapshot' });
    return {
      repository: s.repository,
      runs: s.runs.slice(-10),
      decisions: s.decisions.slice(-10),
      context: s.nodes
        .filter((n: Json) =>
          [
            'intent',
            'requirement',
            'constraint',
            'assumption',
            'finding',
            'alternative',
            'proposed_decision',
            'question',
          ].includes(n.kind),
        )
        .slice(-50),
      git_url: `${origin}/git/${repo}/source`,
    };
  }
  if (['context_search', 'context_get', 'graph', 'why', 'decision'].includes(name))
    return command({
      op: name,
      id: args.id,
      query: args.query,
      kind: args.kind,
      limit: args.limit,
      cursor: args.cursor,
      depth: args.depth,
      commit: args.commit,
      path: args.path,
    });
  if (['attempt_begin', 'attempt_status', 'attempt_submit'].includes(name))
    return contribution(env, principal, repo, name, args, origin);
  if (name === 'context_publish') {
    if (principal.grant?.scope !== 'contribute')
      throw new Error('A contribution grant is required');
    const job = await command({ op: 'external_check', attempt_id: args.attempt_id });
    return command({
      op: 'context_publish',
      job_id: job.id,
      epoch: job.epoch,
      record: {
        id: `context:${crypto.randomUUID()}`,
        kind: args.kind,
        statement: args.statement,
        purpose: args.purpose,
        intent_id: args.intent_id,
        links: args.links ?? [],
      },
    });
  }
  if (name === 'artifact_get') {
    const s = await command({ op: 'snapshot' });
    const a =
      s.artifacts.find((a: Json) => a.id === args.id) ??
      s.evaluations.find((e: Json) => e.id === args.id);
    if (!a) throw new Error('Artifact or evaluation is not attached to this repository');
    const digest = a.digest ?? a.evidence;
    return { ...a, content: await readObject(env, digest) };
  }
  throw new Error('Tool is unavailable; agents cannot select or publish canonical source');
}
