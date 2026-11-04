// Route known repository IDs directly. Readable names are resolved once by the API,
// whose unpinned Worker runs near the caller and forwards to the repository authority.
import { authCounterEnv } from './auth-counter';
import { hinted } from './cell-env';
import { HOME_COOKIE } from './cell-names';
import {
  cellFetcher,
  cellOfRegion,
  cellOfRepo,
  cellsOn,
  FIRST_CELL,
  isCell,
  repoInPath,
  tokenCell,
} from './cells';
import { forwardRequest } from './forward-request';
import { error, response } from './http';
import { GIT_PATH } from './readable-paths';
import { regionOfRequest } from './region';
import { regionalDispatch } from './regional-api';
import { carriedRequest } from './request-scope';
import type { Env } from './types';

const RESOLVE = /^\/api\/v1\/resolve\/([^/]+)\/([^/]+)$/;
const SIGN_IN = /^\/api\/auth\//;
const CREATE = /^\/api\/v1\/repos(?:\/import)?$/;
function cookie(req: Request, name: string) {
  for (const part of req.headers.get('cookie')?.split(';') ?? []) {
    const [key, value] = part.trim().split('=');
    if (key === name) return value;
  }
  return undefined;
}

/** The cell `req` should reach, without network reads. */
export async function cellOfRequest(req: Request, env: Env, url: URL): Promise<string> {
  const repo = repoInPath(url.pathname);
  if (repo) return cellOfRepo(repo);
  const named = GIT_PATH.exec(url.pathname) ?? RESOLVE.exec(url.pathname);
  if (named) return FIRST_CELL;
  // Creation follows this visitor, while account-wide reads still follow their home.
  if (env.AUTOMATIC_LOCALITY === 'on' && req.method === 'POST' && CREATE.test(url.pathname)) {
    const region = regionOfRequest(req);
    if (region === 'enam' || region === 'weur') return cellOfRegion(env, region);
  }
  const bearer = req.headers.get('authorization');
  if (bearer?.startsWith('Bearer ypat_')) return tokenCell(bearer.slice('Bearer '.length));
  const home = cookie(req, HOME_COOKIE);
  if (isCell(env, home)) return home;
  return SIGN_IN.test(url.pathname) ? cellOfRegion(env, regionOfRequest(req)) : FIRST_CELL;
}

/** `req` passed to the cell it belongs in. */
export async function toCell(req: Request, env: Env, url = new URL(req.url)) {
  const regional = regionalDispatch(req, env);
  if (regional) return regional;
  const cell = await cellOfRequest(req, env, url);
  const fetcher = cellFetcher(env, cell) ?? cellFetcher(env, FIRST_CELL);
  if (!fetcher) return error('NOT_FOUND', 'The source platform is not bound', 404);
  return forwardRequest(fetcher, carriedRequest(req));
}

type NewAccounts = { accountCreated(account: string, details: object): Promise<void> };

/** What the front's `PLATFORM` stands for with cells on: a request goes to its cell, a new
 * account's notice to the cell of its region, and anything else to `enam`, as it always did. */
function routedPlatform(env: Env, platform: Fetcher): Fetcher {
  return new Proxy(platform, {
    get(target, key) {
      if (key === 'fetch') return (req: Request) => toCell(req, env);
      const method = (target as unknown as Record<PropertyKey, unknown>)[key];
      if (key === 'accountCreated')
        return (account: string, details: { region?: string }) => {
          const cell = cellFetcher(env, cellOfRegion(env, details?.region)) ?? target;
          return (cell as unknown as NewAccounts).accountCreated(account, details);
        };
      return typeof method === 'function' ? method.bind(target) : method;
    },
  });
}

/** The front's bindings: as they are, with cells off. */
export function frontEnv(env: Env): Env {
  if (!cellsOn(env) || !env.PLATFORM) return authCounterEnv(env);
  const platform = env.PLATFORM;
  return { ...authCounterEnv(env), PLATFORM: routedPlatform(env, platform) };
}

/** A provider sign-in on the front: what it starts, it starts in the cell of the person's
 * region. An unpinned Worker would otherwise start a new account's objects wherever this
 * request landed. */
export function signInEnv(req: Request, env: Env): Env {
  if (!cellsOn(env)) return env;
  const origin = regionOfRequest(req);
  const hint = env.REGIONAL_API === 'on' && origin ? origin : cellOfRegion(env, origin);
  return { ...env, WORKSPACES: hinted(env.WORKSPACES, hint) };
}

/** The edge Worker: every request passed to its cell. */
export async function edgeFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/health')
    return response({
      service: 'yonedarepo-edge',
      v: 1,
      revision: env.BUILD_REVISION ?? 'development',
    });
  return toCell(req, env, url);
}
