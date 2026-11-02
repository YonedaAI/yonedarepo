// The first hop: which cell a request should reach, decided where it arrives (the front Worker
// and the edge Worker, neither pinned). Nothing here can be wrong in a way anyone sees: a cell
// forwards what isn't its own (cell-route.ts), so this only saves the ocean. The one thing it
// ever asks about is a readable name, of the authorities that hold them, and on any doubt it
// says `enam`, which holds every older repository and forwards the rest.
import { normalizeHandle } from '../../shared/account';
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
import { error, response } from './http';
import { GIT_PATH } from './readable-paths';
import { regionOfRequest } from './region';
import { carriedRequest } from './request-scope';
import type { Env } from './types';
import { workspace } from './workspace';

const RESOLVE = /^\/api\/v1\/resolve\/([^/]+)\/([^/]+)$/;
const SIGN_IN = /^\/api\/auth\//;
const NAME_MS = 60_000;
const NAMES_KEPT = 10_000;

const names = new Map<string, { cell: string; at: number }>();

/** The cell of `/<handle>/<name>`, kept for a minute in this isolate: a Git client asks three
 * times in a row. A name moved meanwhile is forwarded by the cell it reached. */
async function cellOfName(env: Env, handle: string, repository: string, now = Date.now()) {
  const key = `${handle}\n${repository}`.toLowerCase();
  const kept = names.get(key);
  if (kept && now - kept.at < NAME_MS) return kept.cell;
  const cell = await lookUp(env, handle, repository).catch(() => FIRST_CELL);
  if (names.size >= NAMES_KEPT) names.clear();
  names.set(key, { cell, at: now });
  return cell;
}

async function lookUp(env: Env, handle: string, repository: string) {
  const name = normalizeHandle(handle);
  if (!name) return FIRST_CELL;
  // Asked from anywhere: a name nobody holds must not start an object out here.
  const near: Env = { ...env, WORKSPACES: hinted(env.WORKSPACES, FIRST_CELL) };
  const { account } = await workspace(near, name, { op: 'handle_lookup' });
  const held = await workspace(near, String(account), {
    op: 'owned_repo_resolve',
    name: repository.replace(/\.git$/, ''),
  });
  return cellOfRepo(String(held.repo));
}

function cookie(req: Request, name: string) {
  for (const part of req.headers.get('cookie')?.split(';') ?? []) {
    const [key, value] = part.trim().split('=');
    if (key === name) return value;
  }
  return undefined;
}

/** The cell `req` should reach. Reads nothing, unless its path is a readable name. */
export async function cellOfRequest(req: Request, env: Env, url: URL): Promise<string> {
  const repo = repoInPath(url.pathname);
  if (repo) return cellOfRepo(repo);
  const named = GIT_PATH.exec(url.pathname) ?? RESOLVE.exec(url.pathname);
  if (named) return cellOfName(env, decodeURIComponent(named[1]), decodeURIComponent(named[2]));
  const bearer = req.headers.get('authorization');
  if (bearer?.startsWith('Bearer ypat_')) return tokenCell(bearer.slice('Bearer '.length));
  const home = cookie(req, HOME_COOKIE);
  if (isCell(env, home)) return home;
  return SIGN_IN.test(url.pathname) ? cellOfRegion(env, regionOfRequest(req)) : FIRST_CELL;
}

/** `req` passed to the cell it belongs in. */
export async function toCell(req: Request, env: Env, url = new URL(req.url)) {
  const cell = await cellOfRequest(req, env, url);
  const fetcher = cellFetcher(env, cell) ?? cellFetcher(env, FIRST_CELL);
  if (!fetcher) return error('NOT_FOUND', 'The source platform is not bound', 404);
  return fetcher.fetch(carriedRequest(req));
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
  if (!cellsOn(env) || !env.PLATFORM) return env;
  return { ...env, PLATFORM: routedPlatform(env, env.PLATFORM) };
}

/** A provider sign-in on the front: what it starts, it starts in the cell of the person's
 * region. An unpinned Worker would otherwise start a new account's objects wherever this
 * request landed. */
export function signInEnv(req: Request, env: Env): Env {
  if (!cellsOn(env)) return env;
  const hint = cellOfRegion(env, regionOfRequest(req));
  return { ...env, WORKSPACES: hinted(env.WORKSPACES, hint) };
}

/** The edge Worker: every request passed to its cell. */
export function edgeFetch(req: Request, env: Env): Promise<Response> | Response {
  const url = new URL(req.url);
  if (url.pathname === '/health')
    return response({
      service: 'yonedarepo-edge',
      v: 1,
      revision: env.BUILD_REVISION ?? 'development',
    });
  return toCell(req, env, url);
}
