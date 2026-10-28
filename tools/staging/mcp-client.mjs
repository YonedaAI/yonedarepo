// A plain JSON-RPC MCP client over HTTP, for the account MCP item (15).
import assert from 'node:assert/strict';

export class McpClient {
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
  /** A tool call's outcome without asserting: `{ status, error, isError, text }`. */
  async attempt(name, args) {
    const headers = { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.token}`, 'mcp-protocol-version': '2025-06-18' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method: 'tools/call', params: { name, arguments: args } });
    const response = await fetch(this.url, { method: 'POST', headers, body });
    const value = await response.json().catch(() => ({}));
    return { status: response.status, error: value.error?.message, isError: Boolean(value.result?.isError), text: value.result?.content?.[0]?.text ?? '' };
  }
  async tool(name, args) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    const text = result.content?.[0]?.text ?? '';
    assert.ok(!result.isError, `${name}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}
