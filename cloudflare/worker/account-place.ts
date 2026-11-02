// Where the request's account lives, learned from the checks every request already makes
// (`session`, `pat_check`, `org_access`), so it costs no read of its own. Its home is the cell
// that serves the code it signed up with; `others` are the cells that also hold its
// repositories, its memberships or its orgs'. Today's accounts have no code and no others.
import { allCells, cellOfRegion, cellsOn, FIRST_CELL, thisCell } from './cells';
import { requestNote } from './internal-accounts';
import type { Env } from './types';
import { workspace } from './workspace';

type Answer = { region?: unknown; cells?: unknown };
type Noted = { home?: string; others?: Set<string> };

const held = () =>
  requestNote() as (ReturnType<typeof requestNote> & { place?: Noted }) | undefined;
const placeOf = () => {
  const note = held();
  if (note) note.place ??= {};
  return note?.place;
};
const codes = (cells: unknown) => (Array.isArray(cells) ? (cells as string[]) : []);

/** The account's own check answered. */
export function noteHome(env: Env, answer: Answer) {
  const place = placeOf();
  if (!place || !cellsOn(env)) return;
  place.home = cellOfRegion(env, answer.region as string | undefined);
  place.others ??= new Set();
  for (const cell of codes(answer.cells)) place.others.add(cell);
}

/** One of the account's orgs answered: its home and cells are read too. */
export function noteOrg(env: Env, answer: Answer) {
  const place = placeOf();
  if (!place || !cellsOn(env)) return;
  place.others ??= new Set();
  place.others.add(cellOfRegion(env, answer.region as string | undefined));
  for (const cell of codes(answer.cells)) place.others.add(cell);
}

/** The request's account's home cell; `enam` for one with none. */
export const homeCell = () => placeOf()?.home ?? FIRST_CELL;

/** Whether the running request's account has been placed. */
export const placed = () => placeOf()?.home !== undefined;

/** The cells other than this one that the account's rows may be in. */
export function otherCells(env: Env) {
  const here = thisCell(env);
  const known = allCells(env);
  const { home, others } = placeOf() ?? {};
  const cells = new Set([...(others ?? []), ...(home ? [home] : [])]);
  return [...cells].filter((cell) => cell !== here && known.includes(cell));
}

/** A repository or a membership of `owner` landed in this cell: its authority says so with
 * every check from now on. Not for the account asking, in its own home. */
export async function noteOwnerCell(env: Env, owner: string) {
  if (!cellsOn(env)) return;
  const here = thisCell(env);
  if (held()?.account === owner && homeCell() === here) return;
  await workspace(env, owner, { op: 'account_place_note', cell: here });
}
