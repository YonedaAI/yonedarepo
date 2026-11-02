// GitHub, as the platform's GitHub App speaks to it: a JWT signed with the App's key, and
// installation tokens that last an hour. A token lives in the call that minted it: nothing here
// logs, keeps or returns one to a browser. GitHub hands out the key as PKCS#1, which WebCrypto
// cannot read, so `pkcs8Of` wraps it first.

import { GitHubAccessError } from './platform-github-refused';
import type { Env, Json } from './types';

const API = 'https://api.github.com';
const WAIT_MS = 10_000;
/** GitHub takes a JWT for 10 minutes at most, and asks for an `iat` a minute back for drift. */
const JWT_SECONDS = 9 * 60;
const DRIFT_SECONDS = 60;
/** A page of repositories, GitHub's largest, and how many a picker shows. */
const PER_PAGE = 100;
const MOST_PAGES = 10;
/** Repositories asked about at once for one person, and in all for one answer. */
const AT_ONCE = 10;
const MOST_CHECKS = 300;

const encoder = new TextEncoder();

export const githubAppOn = (env: Env) =>
  Boolean(env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_SLUG?.trim() && env.GITHUB_APP_PRIVATE_KEY);

/** An ASN.1 length. */
function derLength(n: number) {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let left = n; left > 0; left = Math.floor(left / 256)) bytes.unshift(left % 256);
  return [0x80 | bytes.length, ...bytes];
}

/** PrivateKeyInfo's version and its algorithm, rsaEncryption with no parameters. */
const RSA_INFO = [
  0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
];

/** The DER of a PEM key as WebCrypto reads it: a PKCS#1 key inside a PrivateKeyInfo, and a key
 * in that form already as it is. A secret store may hold the line ends as `\n`. */
export function pkcs8Of(pem: string) {
  const text = pem.replaceAll('\\n', '\n');
  const body = text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  if (!text.includes('BEGIN RSA PRIVATE KEY')) return key;
  const octets = [0x04, ...derLength(key.length)];
  const head = [...RSA_INFO, ...octets];
  const whole = new Uint8Array([0x30, ...derLength(head.length + key.length), ...head, ...key]);
  return whole;
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const part = (value: Json) => base64url(encoder.encode(JSON.stringify(value)));

/** The App's own credential, for the calls about its installations. */
async function appJwt(env: Env) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Of(env.GITHUB_APP_PRIVATE_KEY as string),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iat: now - DRIFT_SECONDS,
    exp: now + JWT_SECONDS,
    iss: (env.GITHUB_APP_ID as string).trim(),
  };
  const signed = `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signed));
  return `${signed}.${base64url(new Uint8Array(signature))}`;
}

/** One call. A refusal says only its status: a token or a body has no place in an error. */
async function github(
  path: string,
  bearer: string,
  body?: Json,
  method = body ? 'POST' : 'GET',
): Promise<Json> {
  const answer = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${bearer}`,
      'user-agent': 'yonedarepo',
      ...(body && { 'content-type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(WAIT_MS),
  });
  if (!answer.ok) {
    await answer.body?.cancel();
    throw new GitHubAccessError(answer.status);
  }
  return answer.status === 204 ? {} : answer.json<Json>();
}

/** An installation as GitHub says it is. */
export type Installation = {
  id: number;
  target_type?: string;
  suspended_at?: string | null;
  /** An enterprise's has no `type`. */
  account?: { id: number; login: string; type?: string };
};

export const installationById = async (env: Env, id: number) =>
  (await github(`/app/installations/${id}`, await appJwt(env))) as Installation;

/** The App's installation on a GitHub user, or null. */
export async function installationOfUser(env: Env, login: string) {
  return github(`/users/${encodeURIComponent(login)}/installation`, await appJwt(env)).then(
    (found) => found as Installation,
    (e) => {
      if (e instanceof GitHubAccessError && e.status === 404) return null;
      throw e;
    },
  );
}

/** Takes the App off the account it was installed on. */
export const uninstall = async (env: Env, installation: number) =>
  github(`/app/installations/${installation}`, await appJwt(env), undefined, 'DELETE');

const mint = async (env: Env, installation: number, scope: Json) =>
  github(`/app/installations/${installation}/access_tokens`, await appJwt(env), scope);

export type GitHubRepository = {
  id: number;
  full_name: string;
  private: boolean;
};

/** A token for one repository, to read its contents, and that repository as GitHub names it. */
export async function repositoryAccess(env: Env, installation: number, repository: number) {
  const scope = { repository_ids: [repository], permissions: { contents: 'read' } };
  const minted = await mint(env, installation, scope);
  const named = (minted.repositories as GitHubRepository[] | undefined)?.[0];
  if (typeof minted.token !== 'string' || named?.id !== repository)
    throw new GitHubAccessError(422);
  return { token: minted.token, repository: named };
}

/** Every installation of the App, as far as one page goes. */
export const appInstallations = async (env: Env) =>
  (await github(
    `/app/installations?per_page=${PER_PAGE}`,
    await appJwt(env),
  )) as unknown as Installation[];

/** Whether GitHub counts `person` on a repository: its owners, teams, members by default access
 * and outside collaborators all count. Needs only the metadata every installation token has, and
 * no organization's OAuth app restrictions apply to a GitHub App. */
async function collaborates(token: string, fullName: string, person: string) {
  const path = `/repos/${fullName}/collaborators/${encodeURIComponent(person)}`;
  return github(path, token).then(
    () => true,
    (e) => {
      if (e instanceof GitHubAccessError && e.status === 404) return false;
      throw e;
    },
  );
}

const metadataToken = async (env: Env, installation: number) =>
  (await mint(env, installation, { permissions: { metadata: 'read' } })).token as string;

async function everyRepository(token: string) {
  const repositories: GitHubRepository[] = [];
  for (let page = 1; ; page++) {
    const seen = await github(
      `/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
      token,
    );
    for (const r of seen.repositories as GitHubRepository[])
      repositories.push({ id: r.id, full_name: r.full_name, private: r.private });
    const more = repositories.length < seen.total_count;
    if (!more || page === MOST_PAGES || seen.repositories.length === 0)
      return { repositories, more };
  }
}

/** The ids of those of `repositories` that `person` can reach, stopping at the first if `first`. */
async function reachedBy(
  token: string,
  repositories: GitHubRepository[],
  person: string,
  first = false,
) {
  const reached = new Set<number>();
  const asked = repositories.slice(0, MOST_CHECKS);
  for (let at = 0; at < asked.length; at += AT_ONCE) {
    const batch = asked.slice(at, at + AT_ONCE);
    const answers = await Promise.all(batch.map((r) => collaborates(token, r.full_name, person)));
    for (const [i, r] of batch.entries()) if (answers[i]) reached.add(r.id);
    if (first && reached.size) break;
  }
  return reached;
}

/** The repositories `installation` was given, up to what a picker shows. `more`: there are others.
 * With `person`, only those they can reach: a public one is anyone's, a private one is asked, and
 * past what one answer can ask it is left out rather than shown. */
export async function installationRepositories(env: Env, installation: number, person?: string) {
  const token = await metadataToken(env, installation);
  const listed = await everyRepository(token);
  if (!person) return listed;
  const hidden = listed.repositories.filter((r) => r.private);
  const reached = await reachedBy(token, hidden, person);
  return {
    repositories: listed.repositories.filter((r) => !r.private || reached.has(r.id)),
    more: listed.more || hidden.length > MOST_CHECKS,
  };
}

/** GitHub's id for `person`, if they can reach any repository of `installation`; else null. */
export async function personOnInstallation(env: Env, installation: number, person: string) {
  const token = await metadataToken(env, installation);
  const { repositories } = await everyRepository(token);
  if (!(await reachedBy(token, repositories, person, true)).size) return null;
  const found = await github(`/users/${encodeURIComponent(person)}`, token);
  return Number.isSafeInteger(found.id) ? String(found.id) : null;
}

/** Whether `person` can reach one repository of `installation`. */
export async function reachesRepository(
  env: Env,
  installation: number,
  repository: GitHubRepository,
  person: string,
) {
  const scope = { repository_ids: [repository.id], permissions: { metadata: 'read' } };
  const { token } = await mint(env, installation, scope);
  return collaborates(token as string, repository.full_name, person);
}
