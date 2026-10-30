// MCP for the source platform: stateless Streamable HTTP with JSON responses. The
// per-repository server (`/api/v1/repos/:id/mcp`) and the account server (`/api/v1/mcp`,
// account-mcp.ts) share this JSON-RPC handling. Authentication is the same credential as
// the REST API, and every platform tool dispatches to the same operation table.
import tools from '../../backend/crates/yoneda-core/src/platform_tools.json';
import { RETRY_AFTER_SECONDS, transient } from './durable';
import { error, readJson, response } from './http';
import { forViewer } from './principal-privacy';
import type { Json, RepoContext } from './repo-ops';
import { operations } from './repo-tools';

const versions = ['2025-06-18', '2025-03-26'];

/** One MCP server: its identity, its tools and how a tool call is answered. */
export type McpServer = {
  name: string;
  instructions: string;
  tools: Json[];
  /** Runs a tool with object arguments; a thrown error becomes an `isError` result. */
  call: (name: string, args: Json) => Promise<Json>;
};

export async function serveMcp(req: Request, server: McpServer): Promise<Response> {
  if (req.headers.has('origin') && req.headers.get('origin') !== new URL(req.url).origin)
    return error('FORBIDDEN', 'Unexpected MCP origin', 403);
  const protocol = req.headers.get('MCP-Protocol-Version');
  if (protocol && !versions.includes(protocol))
    return error('INVALID_PROTOCOL_VERSION', 'Unsupported MCP protocol version', 400);
  // Stateless: no sessions to end and no server-initiated stream.
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  let body: Json;
  try {
    body = await readJson(req, 64 * 1024 * 1024);
  } catch (e: any) {
    return response({ jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }, 400);
  }
  const valid =
    body.jsonrpc === '2.0' &&
    (body.id === undefined || body.id === null || ['string', 'number'].includes(typeof body.id));
  if (!valid || typeof body.method !== 'string') {
    if (valid && body.id !== undefined && ('result' in body || 'error' in body))
      return new Response(null, { status: 202 });
    return response(
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC message' } },
      400,
    );
  }
  if (body.id === undefined) return new Response(null, { status: 202 });
  const reply = (result: Json) => response({ jsonrpc: '2.0', id: body.id, result });
  if (body.method === 'initialize')
    return reply({
      protocolVersion: versions.includes(body.params?.protocolVersion)
        ? body.params.protocolVersion
        : versions[0],
      capabilities: { tools: {} },
      serverInfo: { name: server.name, version: '1.0.0' },
      instructions: server.instructions,
    });
  if (body.method === 'ping') return reply({});
  if (body.method === 'tools/list') return reply({ tools: server.tools });
  if (body.method === 'tools/call') {
    const name = String(body.params?.name ?? '');
    const args = body.params?.arguments ?? {};
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('Tool arguments must be an object');
      const value = await server.call(name, args);
      return reply({
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
      });
    } catch (e: any) {
      // An overloaded authority is named, so an agent retries instead of changing its input.
      const busy = transient(e);
      const code = e?.code ? `${e.code}: ` : busy ? 'OVERLOADED: ' : '';
      const retry = busy ? ` (retry after ${RETRY_AFTER_SECONDS} s)` : '';
      const details = e?.details ? `\n${JSON.stringify(e.details)}` : '';
      return reply({
        isError: true,
        content: [{ type: 'text', text: `${code}${e?.message ?? e}${retry}${details}` }],
      });
    }
  }
  return response({
    jsonrpc: '2.0',
    id: body.id,
    error: { code: -32601, message: 'Unknown MCP method' },
  });
}

/** The platform operation named `name` (own keys only, so `constructor` is unknown). */
export function operation(name: string) {
  const found = Object.hasOwn(operations, name) ? operations[name] : undefined;
  if (!found) throw new Error(`Unknown tool ${name}`);
  return found;
}

export function repoMcp(req: Request, ctx: RepoContext): Promise<Response> {
  return serveMcp(req, {
    name: 'yonedarepo-source',
    instructions:
      'Git semantics over an API: read with git_log/git_ls_tree/git_cat_file/git_diff, write with git_commit (server-side, nothing to push), then checks, review and git_land.',
    tools,
    // A non-member sees accounts by handle, never by address (principal-privacy).
    call: async (name, args) =>
      forViewer(ctx.env, await operation(name)(ctx, args), () => ctx.status()),
  });
}
