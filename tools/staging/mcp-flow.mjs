// External agent through remote MCP (no git_url, no clone): the owner mints a contribute
// grant, then a plain JSON-RPC client runs attempt_begin → read → commit → submit and waits
// until the submitted revision is captured as a candidate.
import assert from 'node:assert/strict';
import { b64, requestId, until } from './client.mjs';

class McpClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.id = 0;
  }
  async rpc(method, params) {
    const headers = { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.token}` };
    if (this.session) Object.assign(headers, { 'mcp-session-id': this.session, 'mcp-protocol-version': '2025-06-18' });
    const response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }) });
    const body = await response.json();
    assert.ok(response.ok && !body.error, `MCP ${method}: ${response.status} ${body.error?.message ?? ''}`);
    if (method === 'initialize') this.session = response.headers.get('mcp-session-id');
    return body.result;
  }
  async tool(name, args) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    assert.ok(!result.isError, `${name}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}

export async function externalAgent(account, project, metrics) {
  const grant = await account.post(`/api/repos/${project.id}/grants`, { label: 'staging-kit external agent', scope: 'contribute', days: 1 });
  assert.ok(grant.mcp_url && grant.token, 'Grant returned no MCP URL or key');
  const mcp = new McpClient(grant.mcp_url, grant.token);
  try {
    await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'staging-kit', version: '1' } });
    const tools = (await mcp.rpc('tools/list', {})).tools.map((t) => t.name);
    for (const name of ['attempt_begin', 'attempt_read', 'attempt_commit', 'attempt_submit'])
      assert.ok(tools.includes(name), `Missing MCP tool ${name}`);
    assert.ok(!JSON.stringify(tools).includes('git_url'), 'An agent-facing git_url is exposed');
    const begun = await mcp.tool('attempt_begin', { request_id: requestId('mcp'), intent: 'Add a NOTES.md written by an external agent' });
    const listing = await mcp.tool('attempt_read', { attempt_id: begun.attempt_id });
    metrics.read_entries = listing.entries?.length;
    const started = performance.now();
    const committed = await mcp.tool('attempt_commit', {
      attempt_id: begun.attempt_id,
      message: 'External agent note',
      changes: [{ path: 'NOTES.md', content_b64: b64('# Notes\n\nWritten through remote MCP on staging.\n') }],
    });
    metrics.commit_ms = Math.round(performance.now() - started);
    assert.match(committed.commit ?? '', /^[0-9a-f]{40}$/, 'attempt_commit returned no commit');
    const submitted = await mcp.tool('attempt_submit', { attempt_id: begun.attempt_id });
    assert.equal(submitted.status, 'capture_requested');
    const job = await until(
      async () => {
        const status = await mcp.tool('attempt_status', { attempt_id: begun.attempt_id });
        assert.notEqual(status.status, 'failed', `Capture failed: ${status.error ?? ''}`);
        return status.status === 'done' && status;
      },
      { timeoutMs: 10 * 60_000, intervalMs: 5000, what: 'external capture' },
    );
    metrics.captured = Boolean(job.result);
  } finally {
    await account.post(`/api/repos/${project.id}/grants`, { revoke: grant.token.split('.')[2] }).catch(() => {});
  }
}
