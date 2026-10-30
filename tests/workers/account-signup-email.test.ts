// New password accounts sign up with an email address only. The address stays private: the
// account's public name is a handle made from the address's local part, and the address
// signs in to it. Accounts made before this with a plain username keep signing in by name.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { randomToken } from '../../cloudflare/worker/accounts';
import { sha } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

const bindings = env as unknown as Env;
afterEach(async () => {
  await reset();
});
const password = 'a long test password';
const post = (path: string, body: unknown, cookie?: string) =>
  bindings.SELF.fetch(`https://yoneda/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const session = (cookie: string) =>
  bindings.SELF.fetch('https://yoneda/api/auth/session', { headers: { cookie } }).then((r) =>
    r.json<any>(),
  );
const cookieOf = (response: Response) => (response.headers.get('set-cookie') ?? '').split(';')[0];

it('refuses a password sign-up without an email address', async () => {
  for (const body of [
    { username: 'plain_name', password },
    { username: 'plain_name', email: 'plain@example.com', password },
    { email: 'not-an-email', password },
    { password },
  ]) {
    const response = await post('auth/signup', body);
    expect(response.status).toBe(400);
    expect((await response.json<any>()).error.message).toMatch(/email/i);
  }
});

it('gives an email sign-up a public handle and keeps the address private', async () => {
  const response = await post('auth/signup', { email: 'Jane.Doe+dev@Example.com', password });
  expect(response.status).toBe(200);
  const body = await response.json<any>();
  expect(body.username).toBe('jane_doe_dev');
  expect(JSON.stringify(body)).not.toContain('example.com');
  const cookie = cookieOf(response);
  expect(cookie).toMatch(/^yoneda_account=jane_doe_dev\./);
  expect(await session(cookie)).toMatchObject({ authenticated: true, username: 'jane_doe_dev' });

  // The address and the handle both sign in to the same account.
  for (const identifier of ['jane.doe+dev@example.com', 'jane_doe_dev']) {
    const login = await post('auth/login', { username: identifier, password });
    expect(login.status).toBe(200);
    expect(await session(cookieOf(login))).toMatchObject({ username: 'jane_doe_dev' });
  }

  // Another address with the same local part gets the next free handle; the same address
  // cannot sign up twice.
  const second = await post('auth/signup', { email: 'jane.doe+dev@other.example', password });
  expect((await second.json<any>()).username).toBe('jane_doe_dev2');
  expect((await post('auth/signup', { email: 'jane.doe+dev@example.com', password })).status).toBe(
    400,
  );

  // Recovery works by address too.
  const recovered = await post('auth/recover', {
    username: 'jane.doe+dev@example.com',
    password: 'a new long test password',
    recovery_code: body.recovery_code,
  });
  expect(recovered.status).toBe(200);
});

it('still signs in an account made earlier with a plain username', async () => {
  // As the old sign-up made it: named by the username, with a separate contact email.
  await workspace(bindings, 'old_user', {
    op: 'signup',
    username: 'old_user',
    email: 'old@example.com',
    password,
    salt: randomToken(16),
    session_hash: await sha(randomToken()),
    recovery_hash: await sha(randomToken()),
  });
  const login = await post('auth/login', { username: 'old_user', password });
  expect(login.status).toBe(200);
  expect(await session(cookieOf(login))).toMatchObject({ username: 'old_user' });
});

it('still signs in an account named by its email address', async () => {
  await workspace(bindings, 'named@example.com', {
    op: 'signup',
    username: 'named@example.com',
    email: 'named@example.com',
    password,
    salt: randomToken(16),
    session_hash: await sha(randomToken()),
    recovery_hash: await sha(randomToken()),
  });
  const login = await post('auth/login', { username: 'named@example.com', password });
  expect(login.status).toBe(200);
  // The address is taken: a new sign-up with it is refused.
  expect((await post('auth/signup', { email: 'named@example.com', password })).status).toBe(400);
});
