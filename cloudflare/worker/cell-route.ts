// Reaching another cell. Every platform Worker forwards a request that belongs elsewhere, so a
// wrong first hop costs an ocean and never a wrong answer (docs/global-scale-plan.md, cells as
// built). What crosses is the caller's own request: their credentials, checked again there.
import { homeCell, otherCells, placed } from './account-place';
import { cellFetcher, cellOfRepo, cellsOn, repoInPath, thisCell } from './cells';
import { log } from './log';
import { ApiError, type Json } from './repo-ops';
import { currentScope } from './request-scope';
import type { Env } from './types';

/** On a sub-request: answer for this cell alone. It only narrows what the caller sees. */
export const HERE_HEADER = 'x-yoneda-cell';
const HERE = 'here';
/** The caller's, carried to a request made here for it. */
const CARRIED = ['authorization', 'cookie', 'origin', 'cf-connecting-ip', 'user-agent'];
const CELL_MS = 8_000;

export const askedHere = (req: Request) => req.headers.get(HERE_HEADER) === HERE;

/** The other cell a request's repository is in, or null. */
export function repoElsewhere(env: Env, url: URL) {
  if (!cellsOn(env)) return null;
  const repo = repoInPath(url.pathname);
  if (!repo) return null;
  const cell = cellOfRepo(repo);
  return cell === thisCell(env) ? null : cell;
}

/** Paths that read an account's own rows: served where those rows are. */
const ACCOUNT_WIDE =
  /^\/api\/v1\/(tokens|ssh-keys|activity|search|favorites|orgs|repos|mcp|account)(\/|$)/;
/** A create chooses its own cell, which may not be home (repo-create.ts). */
const CREATE = /^\/api\/v1\/repos(\/import)?$/;

/** The account's home cell, when an account-wide request reached another. */
export function homeElsewhere(env: Env, req: Request, url: URL) {
  if (!cellsOn(env) || askedHere(req) || !placed()) return null;
  if (!ACCOUNT_WIDE.test(url.pathname) || repoInPath(url.pathname)) return null;
  if (req.method === 'POST' && CREATE.test(url.pathname)) return null;
  const home = homeCell();
  return home === thisCell(env) ? null : home;
}

const fetcherOf = (env: Env, cell: string) => {
  const fetcher = cellFetcher(env, cell);
  if (!fetcher) throw new ApiError('CELL_UNAVAILABLE', `The ${cell} region is not reachable here`);
  return fetcher;
};

/** `req`, whole, answered by `cell`. */
export const forwardTo = (env: Env, cell: string, req: Request) => fetcherOf(env, cell).fetch(req);

/** A request made here for the caller, answered by `cell`. */
function cellRequest(env: Env, cell: string, path: string, init: RequestInit, here: boolean) {
  const from = currentScope()?.req;
  if (!from) throw new ApiError('CELL_UNAVAILABLE', 'Nothing to answer for');
  const headers = new Headers(init.headers);
  for (const name of CARRIED) {
    const value = from.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (here) headers.set(HERE_HEADER, HERE);
  return fetcherOf(env, cell).fetch(new Request(new URL(path, from.url), { ...init, headers }));
}

/** `cell`'s JSON answer to the caller's request, or its refusal. */
export async function askCell(
  env: Env,
  cell: string,
  path: string,
  init: RequestInit = {},
  here = false,
): Promise<Json> {
  const answer = await cellRequest(env, cell, path, init, here);
  const value = await answer.json<Json>();
  if (!answer.ok)
    throw new ApiError(value.error?.code ?? 'REQUEST_FAILED', value.error?.message ?? 'Failed');
  return value;
}

/** A failed cell costs its part of the answer, never the rest: `partial` says so. */
async function part(env: Env, cell: string, path: string) {
  let timer = 0;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('cell timed out')), CELL_MS);
  });
  try {
    return await Promise.race([askCell(env, cell, path, {}, true), late]);
  } catch (e) {
    log.warn('cell.read_failed', { kind: cell, error: e });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An account-wide read over `cells`: `local` here, the same request in each of them for what it
 * holds, and `merge` of all that answered. With no cells it is `local` alone, as for every
 * account that keeps to one cell. A cell's own part, asked with `askedHere`, stops here.
 */
export async function acrossCells<T extends Json>(
  env: Env,
  path: string,
  local: () => Promise<T>,
  merge: (parts: T[]) => T,
  cells = otherCells(env),
): Promise<T> {
  const scope = currentScope()?.req;
  if (!cellsOn(env) || cells.length === 0 || (scope && askedHere(scope))) return local();
  const [own, ...rest] = await Promise.all([local(), ...cells.map((c) => part(env, c, path))]);
  const answered = rest.filter((p): p is Json => p !== null) as T[];
  const merged = merge([own, ...answered]);
  return answered.length === rest.length ? merged : { ...merged, partial: true };
}
