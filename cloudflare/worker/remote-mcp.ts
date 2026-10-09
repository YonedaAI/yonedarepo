import tools from '../../backend/crates/yoneda-core/src/mcp_remote_tools.json';
import { grantPrincipal } from './grants';
import { error, readJson, response, safeId } from './http';
import { remoteTool } from './remote-tools';
import { ledger } from './storage';
import type { Env, Json } from './types';

const versions = ['2025-06-18', '2025-03-26'];
const sessionHeader = 'Mcp-Session-Id';

/** JSON Streamable HTTP with optional legacy stateless requests; sessions never replace grants. */
export async function remoteMcp(req: Request, env: Env, repo: string): Promise<Response> {
  if (!safeId(repo)) return error('NOT_FOUND', 'Unknown repository', 404);
  const principal = await grantPrincipal(req, env);
  if (!principal) return error('UNAUTHORIZED', 'Repository agent key required', 401);
  if (req.headers.has('origin') && req.headers.get('origin') !== new URL(req.url).origin)
    return error('FORBIDDEN', 'Unexpected MCP origin', 403);
  if (principal.grant?.repo !== repo)
    return error('FORBIDDEN', 'Key belongs to another repository', 403);
  const identity = { _workspace: principal.workspace, _grant: principal.grant.id };
  const command = (input: Json) => ledger(env, repo, { ...input, ...identity });
  const sessionId = req.headers.get(sessionHeader);
  const protocol = req.headers.get('MCP-Protocol-Version');
  if (protocol && !versions.includes(protocol))
    return error('INVALID_PROTOCOL_VERSION', 'Unsupported MCP protocol version', 400);
  try {
    if (sessionId !== null) {
      if (!/^[a-f0-9-]{36}$/.test(sessionId))
        return error('SESSION_NOT_FOUND', 'MCP session is no longer available', 404);
      const session = await command({ op: 'context_session_get', session_id: sessionId });
      if (protocol && session.protocol_version && protocol !== session.protocol_version)
        return error(
          'INVALID_PROTOCOL_VERSION',
          'MCP protocol version differs from this session',
          400,
        );
    }
    if (req.method === 'DELETE') {
      if (!sessionId) return error('SESSION_REQUIRED', 'MCP session header required', 400);
      await command({ op: 'context_session_end', session_id: sessionId });
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }
    // This endpoint does not offer a server-initiated SSE stream.
    if (req.method !== 'POST')
      return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
    const body = await readJson(req, 256 * 1024);
    if (
      body.jsonrpc !== '2.0' ||
      (body.id !== undefined && body.id !== null && !['string', 'number'].includes(typeof body.id))
    )
      throw new Error('Invalid JSON-RPC message');
    if (typeof body.method !== 'string') {
      if (body.id !== undefined && ('result' in body || 'error' in body))
        return new Response(null, { status: 202 });
      throw new Error('Invalid JSON-RPC message');
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: Json;
    let issuedSession: string | undefined;
    if (body.method === 'initialize') {
      if (sessionId)
        return error('INVALID_REQUEST', 'Initialize a new session without a session header', 400);
      const protocolVersion = versions.includes(body.params?.protocolVersion)
        ? body.params.protocolVersion
        : versions[0];
      issuedSession = crypto.randomUUID();
      const expires = principal.grant.expires;
      if (!Number.isSafeInteger(expires) || (expires ?? 0) <= Date.now())
        return error('UNAUTHORIZED', 'Repository agent key has expired', 401);
      await command({
        op: 'context_session_begin',
        session_id: issuedSession,
        expires_at: Math.min(expires as number, Date.now() + 24 * 60 * 60 * 1000),
        protocol_version: protocolVersion,
      });
      result = {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'yonedarepo', version: '0.3.0' },
      };
    } else if (body.method === 'ping') result = {};
    else if (body.method === 'tools/list') result = { tools };
    else if (body.method === 'tools/call') {
      try {
        const args = body.params?.arguments ?? {};
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw new Error('Tool arguments must be an object');
        const value = await remoteTool(
          env,
          principal,
          repo,
          body.params?.name,
          args,
          new URL(req.url).origin,
          sessionId ?? undefined,
        );
        result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (e: any) {
        if (e.code === 'SESSION_NOT_FOUND') throw e;
        result = { isError: true, content: [{ type: 'text', text: e.message }] };
      }
    } else
      return response({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'Unknown MCP method' },
      });
    const reply = response({ jsonrpc: '2.0', id: body.id, result });
    if (issuedSession) reply.headers.set(sessionHeader, issuedSession);
    return reply;
  } catch (e: any) {
    if (e.code === 'SESSION_NOT_FOUND')
      return error('SESSION_NOT_FOUND', 'MCP session is no longer available', 404);
    return response({ jsonrpc: '2.0', id: null, error: { code: -32600, message: e.message } }, 400);
  }
}
