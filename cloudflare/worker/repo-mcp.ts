// MCP for the source platform (`/api/v1/repos/:id/mcp`): stateless Streamable HTTP
// with JSON responses. Authentication is the same repository token or session as the
// REST API, and every tool dispatches to the same operation table.
import tools from '../../backend/crates/yoneda-core/src/platform_tools.json';
import { error, readJson, response } from './http';
import type { Json, RepoContext } from './repo-ops';
import { operations } from './repo-tools';

const versions = ['2025-06-18', '2025-03-26'];

export async function repoMcp(req: Request, ctx: RepoContext): Promise<Response> {
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
      serverInfo: { name: 'yonedarepo-source', version: '1.0.0' },
      instructions:
        'Git semantics over an API: read with git_log/git_ls_tree/git_cat_file/git_diff, write with git_commit (server-side, nothing to push), then checks, review and git_land.',
    });
  if (body.method === 'ping') return reply({});
  if (body.method === 'tools/list') return reply({ tools });
  if (body.method === 'tools/call') {
    const name = String(body.params?.name ?? '');
    const args = body.params?.arguments ?? {};
    const operation = Object.hasOwn(operations, name) ? operations[name] : undefined;
    try {
      if (!operation) throw new Error(`Unknown tool ${name}`);
      if (!args || typeof args !== 'object' || Array.isArray(args))
        throw new Error('Tool arguments must be an object');
      const value = await operation(ctx, args);
      return reply({
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
      });
    } catch (e: any) {
      const code = e?.code ? `${e.code}: ` : '';
      const details = e?.details ? `\n${JSON.stringify(e.details)}` : '';
      return reply({
        isError: true,
        content: [{ type: 'text', text: `${code}${e?.message ?? e}${details}` }],
      });
    }
  }
  return response({
    jsonrpc: '2.0',
    id: body.id,
    error: { code: -32601, message: 'Unknown MCP method' },
  });
}
