// The platform's public API (`/api/v1`), the same endpoints the CLI and MCP use, reached over
// the PLATFORM service binding. Runs authenticate with the repository's scoped token; enabling
// an agent forwards the signed-in caller's own credential, so only the platform decides who
// may mint a token or register a webhook. Nothing here can land, approve or change policy.
import type { ManagedEnv } from './config';

export type Json = Record<string, any>;

export class PlatformError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Where a request's credential comes from: the agents' repository token, or a caller's own. */
export type Credential = { token: string } | { forward: Request };

const ORIGIN = 'https://platform.internal';

export class Platform {
  constructor(
    private readonly env: ManagedEnv,
    private readonly credential: Credential,
  ) {}

  async #call(method: string, path: string, body?: unknown, api = '/api/v1'): Promise<Json> {
    const headers = new Headers({ accept: 'application/json' });
    let url = `${ORIGIN}${api}${path}`;
    if ('token' in this.credential) headers.set('authorization', `Bearer ${this.credential.token}`);
    else {
      // The caller's session is checked by the platform against the origin it was issued for.
      const from = this.credential.forward;
      url = `${new URL(from.url).origin}${api}${path}`;
      for (const name of ['cookie', 'authorization', 'origin']) {
        const value = from.headers.get(name);
        if (value) headers.set(name, value);
      }
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await this.env.PLATFORM.fetch(
      new Request(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      }),
    );
    const answer = (await res.json().catch(() => null)) as Json | null;
    if (!res.ok) {
      const error = answer?.error ?? {};
      throw new PlatformError(
        String(error.code ?? `HTTP_${res.status}`),
        String(error.message ?? `Platform answered HTTP ${res.status}`).slice(0, 300),
        res.status,
      );
    }
    return answer ?? {};
  }

  /** The signed-in account: its own personal workspace, owned even before its first repository. */
  session() {
    return this.#call('GET', '/session', undefined, '/api/auth');
  }
  /** The caller's repositories (owner, role) and orgs: who owns which workspace. */
  repos() {
    return this.#call('GET', '/repos');
  }
  orgs() {
    return this.#call('GET', '/orgs');
  }
  status(repo: string) {
    return this.#call('GET', `/repos/${repo}`);
  }
  /** Whether the owner's break-glass pause stops automation (`automation.paused`), managed
   * agents included. */
  async automationPaused(repo: string) {
    return Boolean((await this.status(repo)).automation?.paused);
  }
  openChanges(repo: string) {
    return this.#call('GET', `/repos/${repo}/changes?status=open&limit=200`);
  }
  change(repo: string, number: number) {
    return this.#call('GET', `/repos/${repo}/changes/${number}?patch=1`);
  }
  /** Memories and contracts ranked for the changed paths (`yoneda context`). */
  relevant(repo: string, paths: string[], ref: string) {
    const query = new URLSearchParams({ paths: paths.join(','), ref, limit: '10' });
    return this.#call('GET', `/repos/${repo}/context/relevant?${query}`);
  }
  comment(
    repo: string,
    number: number,
    body: string,
    anchor?: { commit: string; path: string; line: number; side: 'new' | 'old' },
  ) {
    return this.#call('POST', `/repos/${repo}/changes/${number}/comments`, { body, ...anchor });
  }
  check(repo: string, commit: string, name: string, status: 'pass' | 'fail', evidence: Json) {
    return this.#call('POST', `/repos/${repo}/commits/${commit}/checks`, {
      name,
      status,
      evidence,
    });
  }
  createToken(repo: string, name: string, scopes: string[]) {
    return this.#call('POST', `/repos/${repo}/tokens`, { name, scopes });
  }
  createHook(repo: string, url: string, events: string[]) {
    return this.#call('POST', `/repos/${repo}/hooks`, { url, events });
  }
  revokeToken(repo: string, name: string) {
    return this.#call('DELETE', `/repos/${repo}/tokens/${encodeURIComponent(name)}`);
  }
  deleteHook(repo: string, id: number) {
    return this.#call('DELETE', `/repos/${repo}/hooks/${id}`);
  }
}
