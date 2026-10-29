// A repository's platform connection as RepoAgents stores it: the agents' token and webhook
// signing secret are sealed at rest (vault.ts) and opened only inside that Durable Object.
import type { ManagedEnv } from './config';
import { open, seal } from './vault';

export type Connection = {
  account: string;
  token_name: string;
  token: string;
  hook_id: number;
  hook_secret: string;
};

export async function readConnection(sql: SqlStorage, env: ManagedEnv): Promise<Connection | null> {
  const row = sql
    .exec<{
      repo: string;
      account: string;
      token_name: string;
      token_sealed: string;
      hook_id: number;
      hook_secret_sealed: string;
    }>(
      'SELECT repo, account, token_name, token_sealed, hook_id, hook_secret_sealed FROM connection WHERE id = 1',
    )
    .toArray()[0];
  if (!row) return null;
  return {
    account: row.account,
    token_name: row.token_name,
    token: await open(env, row.repo, 'token', row.token_sealed),
    hook_id: row.hook_id,
    hook_secret: await open(env, row.repo, 'hook_secret', row.hook_secret_sealed),
  };
}

export async function writeConnection(
  sql: SqlStorage,
  env: ManagedEnv,
  repo: string,
  c: Connection,
) {
  const token = await seal(env, repo, 'token', c.token);
  const hookSecret = await seal(env, repo, 'hook_secret', c.hook_secret);
  sql.exec(
    `INSERT INTO connection (id, repo, account, token_name, token_sealed, hook_id, hook_secret_sealed, created_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET account = excluded.account, token_name = excluded.token_name,
       token_sealed = excluded.token_sealed, hook_id = excluded.hook_id,
       hook_secret_sealed = excluded.hook_secret_sealed`,
    repo,
    c.account,
    c.token_name,
    token,
    c.hook_id,
    hookSecret,
    Date.now(),
  );
}

async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether `signature` (`sha256=<hex>`) is `secret`'s signature of `body`, in constant time. */
export async function signatureMatches(secret: string, body: string, signature: string) {
  if (!signature.startsWith('sha256=')) return false;
  const expected = new TextEncoder().encode(`sha256=${await hmacHex(secret, body)}`);
  const supplied = new TextEncoder().encode(signature);
  return expected.length === supplied.length && crypto.subtle.timingSafeEqual(expected, supplied);
}
