// A fake GitHub for the App: its REST calls as GitHub's docs describe them. It checks the JWT with
// the public half of a key generated for the run, handed over as GitHub hands one over: PKCS#1.
import { sha } from '../../cloudflare/worker/storage';
import type { Env } from '../../cloudflare/worker/types';
import { workspace } from '../../cloudflare/worker/workspace';

const API = 'https://api.github.com';
const encoder = new TextEncoder();

type Installed = { id: number; account: { id: number; login: string; type: string }; target_type: string; suspended_at?: string | null; repositories: Repo[] };
export type Repo = { id: number; full_name: string; private: boolean };

const decode = (part: string) => atob(part.replaceAll('-', '+').replaceAll('_', '/'));

export class FakeGitHub {
  installations = new Map<number, Installed>();
  minted: { installation: number; scope: any; token: string }[] = [];
  asked: string[] = [];
  key = '';
  #public?: CryptoKey;

  /** A key pair, its private half as PKCS#1 PEM. */
  async keys() {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    this.#public = pair.publicKey;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
    const body = btoa(String.fromCharCode(...pkcs8.subarray(26))).replace(/(.{64})/g, '$1\n');
    this.key = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\n`;
    return this;
  }

  env(target: Env): Env {
    return { ...target, GITHUB_APP_ID: '5571444', GITHUB_APP_SLUG: 'test-import', GITHUB_APP_PRIVATE_KEY: this.key } as Env;
  }

  install(id: number, subject: number, login: string, repositories: Repo[] = [], type = 'User') {
    const installed = { id, account: { id: subject, login, type }, target_type: type, suspended_at: null, repositories };
    this.installations.set(id, installed);
    return installed;
  }

  async #jwt(init?: RequestInit) {
    const [head, claims, signature] = String((init?.headers as any)?.authorization).replace('Bearer ', '').split('.');
    const body = JSON.parse(decode(claims ?? 'e30='));
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      this.#public as CryptoKey,
      Uint8Array.from(decode(signature ?? ''), (c) => c.charCodeAt(0)),
      encoder.encode(`${head}.${claims}`),
    );
    const now = Date.now() / 1000;
    return valid && JSON.parse(decode(head)).alg === 'RS256' && body.iss === '5571444' && body.iat <= now - 30 && body.exp <= now + 600 && body.exp > now;
  }

  /** GitHub's answer to `url`, or null for anywhere else. */
  async handle(url: string, init?: RequestInit): Promise<Response | null> {
    if (!url.startsWith(API)) return null;
    const { pathname, searchParams } = new URL(url);
    this.asked.push(`${init?.method ?? 'GET'} ${pathname}`);
    const none = () => Response.json({ message: 'Not Found' }, { status: 404 });
    if (pathname === '/installation/repositories') {
      const token = String((init?.headers as any)?.authorization).replace('Bearer ', '');
      const grant = this.minted.find((m) => m.token === token);
      if (!grant) return Response.json({}, { status: 401 });
      const all = this.installations.get(grant.installation)?.repositories ?? [];
      const size = Number(searchParams.get('per_page'));
      const page = Number(searchParams.get('page'));
      return Response.json({ total_count: all.length, repositories: all.slice((page - 1) * size, page * size) });
    }
    if (!(await this.#jwt(init))) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    const user = /^\/users\/([^/]+)\/installation$/.exec(pathname)?.[1];
    if (user) return Response.json([...this.installations.values()].find((i) => i.account.login === user) ?? null, { status: [...this.installations.values()].some((i) => i.account.login === user) ? 200 : 404 });
    const [, id, tokens] = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(pathname) ?? [];
    const installed = this.installations.get(Number(id));
    if (!installed) return none();
    if (init?.method === 'DELETE') {
      this.installations.delete(installed.id);
      return new Response(null, { status: 204 });
    }
    if (!tokens) return Response.json(installed);
    if (installed.suspended_at) return Response.json({ message: 'This installation has been suspended' }, { status: 403 });
    const scope = JSON.parse(String(init?.body));
    const repositories = (scope.repository_ids ?? []).map((wanted: number) => installed.repositories.find((r) => r.id === wanted));
    if (repositories.includes(undefined)) return Response.json({ message: 'Validation Failed' }, { status: 422 });
    const token = `ghs_token_${this.minted.length + 1}`;
    this.minted.push({ installation: installed.id, scope, token });
    return Response.json({ token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), repositories }, { status: 201 });
  }
}

/** Links `subject` to the account behind `cookie`, as the link step leaves it. */
export async function linkGitHub(env: Env, cookie: string, subject: number, login: string) {
  const value = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  const at = value.lastIndexOf('.');
  const account = value.slice(0, at);
  await workspace(env, account, {
    op: 'identity_link',
    session_hash: await sha(value.slice(at + 1)),
    provider: 'github',
    subject: String(subject),
    login,
    email: null,
    avatar_url: null,
  });
  return account;
}
