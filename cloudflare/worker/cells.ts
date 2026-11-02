// Cells: whole copies of the platform, one per region (docs/global-scale-plan.md, cells as
// built). `enam` is the stack that always was, under its own names. A repository's cell is in
// its id, so finding one reads nothing, and a region is fixed because an id never changes. All
// of this is pure and has no platform imports: the front Worker routes with it too.
import type { Env } from './types';

export const FIRST_CELL = 'enam';
/** The end of a repository id made in a cell. The ids of `enam` carry none. */
const ID_TAGS = new Map([['weur', 'eea001']]);
const ID_TAG_DIGITS = 6;
const CELL_OF_TAG = new Map([...ID_TAGS].map(([cell, tag]) => [tag, cell]));
/** The start of a personal token issued for a cell. Old tokens are random, so this only orders
 * the look-ups (repo-pat.ts): it may match one, and never decides anything. */
const TOKEN_TAGS = new Map([['weur', 'eu_']]);
const TOKEN_TAG_CHARS = 3;
const CELL_OF_TOKEN = new Map([...TOKEN_TAGS].map(([cell, tag]) => [tag, cell]));
/** Each sign-up code's cells, nearest first. Cloudflare starts `sam` objects in eastern North
 * America; the rest stay in `enam` until a cell opens nearer. */
const NEAREST = new Map([
  ['enam', ['enam']],
  ['sam', ['enam']],
  ['weur', ['weur']],
  ['afr', ['weur']],
  ['apac', ['apac', 'enam']],
  ['oc', ['apac', 'enam']],
]);

const REPO_IN_PATH =
  /^\/(?:api\/v1\/(?:(?:admin\/)?repos|favorites)|git)\/(r[0-9a-f]{20})(?:\.git)?(?:\/|$)/;

export const cellsOn = (env: Env) => env.CELLS === 'on';

/** The cell this Worker is. */
export const thisCell = (env: Env) => env.CELL ?? FIRST_CELL;

/** The binding to `cell`'s platform Worker, from a Worker that isn't it. */
export function cellFetcher(env: Env, cell: string): Fetcher | undefined {
  if (cell === FIRST_CELL) return env.CELL_ENAM ?? env.PLATFORM;
  return cell === 'weur' ? env.CELL_WEUR : undefined;
}

/** `cell`'s D1, from any Worker that has it; this Worker's own otherwise. */
export function indexOf(env: Env, cell: string): D1Database {
  if (!cellsOn(env) || cell === thisCell(env)) return env.INDEX;
  const other = cell === FIRST_CELL ? env.INDEX_ENAM : cell === 'weur' ? env.INDEX_WEUR : undefined;
  return other ?? env.INDEX;
}

const exists = (env: Env, cell: string) =>
  cell === thisCell(env) || cellFetcher(env, cell) !== undefined;

/** Every cell this Worker can reach. */
export const allCells = (env: Env) =>
  [FIRST_CELL, ...ID_TAGS.keys()].filter((cell) => exists(env, cell));

/** Whether `cell` is a cell that exists from here. */
export const isCell = (env: Env, cell: unknown): cell is string =>
  typeof cell === 'string' && allCells(env).includes(cell);

/** The cell that serves a sign-up code. */
export function cellOfRegion(env: Env, region: string | null | undefined) {
  if (!cellsOn(env) || !region) return FIRST_CELL;
  return NEAREST.get(region)?.find((cell) => exists(env, cell)) ?? FIRST_CELL;
}

/** A repository's cell, read from its id. */
export const cellOfRepo = (repo: string) =>
  CELL_OF_TAG.get(repo.slice(-ID_TAG_DIGITS)) ?? FIRST_CELL;

/** The repository a platform path names, or null: an account-wide path. */
export const repoInPath = (pathname: string) => REPO_IN_PATH.exec(pathname)?.[1] ?? null;

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A new repository id: `r` and 20 hex digits, the last 6 of them this cell's tag. An `enam` id
 * never ends in a tag, so an id only ever names the cell that made it. */
export function newRepoId(
  env: Env,
  fill: (into: Uint8Array) => void = (into) => crypto.getRandomValues(into),
) {
  const tag = ID_TAGS.get(thisCell(env));
  const bytes = new Uint8Array(tag ? (20 - ID_TAG_DIGITS) / 2 : 10);
  for (;;) {
    fill(bytes);
    const digits = hex(bytes);
    if (tag) return `r${digits}${tag}`;
    if (!CELL_OF_TAG.has(digits.slice(-ID_TAG_DIGITS))) return `r${digits}`;
  }
}

/** What a personal token for `cell` starts with, after `ypat_`; empty for `enam`. */
export const tokenPrefix = (cell: string) => TOKEN_TAGS.get(cell) ?? '';

/** Where a personal token's look-up row should be: its tag's cell, or `enam`. */
export const tokenCell = (token: string) =>
  CELL_OF_TOKEN.get(token.replace(/^ypat_/, '').slice(0, TOKEN_TAG_CHARS)) ?? FIRST_CELL;
