import { env } from 'cloudflare:workers';
import { expect, vi } from 'vitest';
import { fetchRequest } from '../../cloudflare/worker/routes';
import { reviewerPolicy } from '../../cloudflare/worker/reviewer-policy';
import { ledger } from '../../cloudflare/worker/storage';
import type { Env, Json, Scope } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

export const bindings = env as unknown as Env;
export const expires = Date.UTC(2026, 9, 23);
export const testKeys = ['synthetic-codex-key', 'synthetic-claude-key'];
export function api(scoped: Env, path: string, cookie = '', body?: Json, admin = false) {
  return fetchRequest(new Request(`https://yoneda${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, ...(admin ? { authorization: 'Bearer local-test-owner' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), scoped);
}
export async function signup(owner: string) {
  const response = await api(bindings, '/api/auth/signup', '', { username: owner, password: 'long integration test password' });
  if (response.status !== 200) {
    const failure = await response.json<Json>();
    throw new Error(`Fixture signup failed: ${failure.error?.code}: ${failure.error?.message}`);
  }
  return (response.headers.get('set-cookie') ?? '').split(';')[0];
}
export async function reviewerFixture(owner = 'review_alice') {
  const cookie = await signup(owner);
  // External Secrets Store and Queue are fake. Signup, vault sealing and both
  // authoritative ledgers execute in workerd against real Rust/Wasm DO SQLite.
  const send = vi.fn(async () => {});
  const scoped = { ...bindings, OPENAI_KEY: { get: async () => testKeys[0] },
    ANTHROPIC_KEY: { get: async () => testKeys[1] }, AGENT_QUEUE: { send } } as unknown as Env;
  const response = await api(scoped, '/api/admin/reviewer/provision', '', { username: owner }, true);
  expect(response.status).toBe(200);
  const provisioned = await response.json<Json>();
  return { owner, cookie, scoped, send, provisioned, repo: provisioned.repo_id as string };
}
export async function readyReviewer(owner = 'review_alice') {
  const fixture = await reviewerFixture(owner);
  const { repo } = fixture;
  // Setup completion is synthetic: no external repository/container is launched.
  await ledger(bindings, repo, { op: 'init', id: repo, name: 'Reviewer sandbox', workspace: owner,
    remote: { namespace: 'yoneda-test', name: repo }, commit: 'a'.repeat(40), policy: reviewerPolicy });
  await workspace(bindings, owner, { op: 'project_update', id: repo, status: 'ready' });
  return fixture;
}
export function containerBindings(scoped: Env, scope: Scope) {
  // Fake Container RPC supplies only the trusted attempt identity. scopeFor
  // still checks that identity and epoch against the actual repository DO.
  const stop = vi.fn(async () => {});
  const result = { ...scoped, EXECUTIONS: { idFromString: (id: string) => id,
    get: () => ({ scope: async () => scope, scheduleStop: stop }) } } as unknown as Env;
  return { scoped: result, stop };
}
