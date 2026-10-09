// An isolated local CLI shares the already-issued, contribution-bound server session.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const { url, token, session } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let message;
  try {
    message = JSON.parse(line);
    if (message.method === 'initialize') {
      // Validate the existing server session before advertising capabilities locally.
      const ping = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }) });
      if (!ping.ok) throw new Error('session unavailable');
      const pong = await ping.json();
      if (pong.jsonrpc !== '2.0' || pong.id !== 0 || pong.error !== undefined
        || !pong.result || typeof pong.result !== 'object' || Array.isArray(pong.result))
        throw new Error('session protocol unavailable');
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'yonedarepo-bound-relay', version: '1' } } })}\n`);
      continue;
    }
    if (message.id === undefined) continue;
    const result = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': '2025-06-18', 'content-type': 'application/json' }, body: JSON.stringify(message) });
    if (!result.ok) throw new Error('scoped request failed');
    process.stdout.write(`${JSON.stringify(await result.json())}\n`);
  } catch {
    if (message?.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Scoped context session unavailable' } })}\n`);
  }
}
