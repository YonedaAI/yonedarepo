import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function savePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export async function load(path) { return JSON.parse(await readFile(path, 'utf8')); }

export function client(origin) {
  let cookie = '';
  async function api(path, body) {
    const response = await fetch(`${origin}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(`${path}: ${value.error?.code ?? response.status}`), { code: value.error?.code });
    if (path.startsWith('auth/')) cookie = (response.headers.get('set-cookie') ?? cookie).split(';')[0];
    return value;
  }
  async function mcp(repo, token, name, args) {
    const response = await fetch(`${origin}/mcp/${repo}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
    });
    const value = await response.json();
    if (!response.ok || value.error || value.result?.isError)
      throw new Error(`Contribution ${name} rejected (${response.status}); inspect the private fixture.`);
    return JSON.parse(value.result.content[0].text);
  }
  return { api, mcp };
}

export async function until(check, description, deadline) {
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`Acceptance deadline exceeded: ${description}`);
}
