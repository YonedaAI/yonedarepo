// Which cell a new repository goes to: the one the request names; failing that, an org's home,
// where a token was issued (an agent's token is issued where the agent runs), or the account's
// home. A region is fixed from here on: it is in the repository's id.
import { homeCell } from './account-place';
import { allCells, cellOfRegion, cellsOn, FIRST_CELL, isCell, thisCell, tokenCell } from './cells';
import { ApiError, type Json } from './repo-ops';
import { currentScope } from './request-scope';
import type { Env } from './types';
import { workspace } from './workspace';

const tokenOfRequest = () => {
  const bearer = currentScope()?.req?.headers.get('authorization');
  return bearer?.startsWith('Bearer ypat_') ? bearer.slice('Bearer '.length) : null;
};

/** The cell a create belongs in; this Worker's with cells off. */
export async function cellForNew(env: Env, body: Json): Promise<string> {
  if (!cellsOn(env)) return thisCell(env);
  if (body.region !== undefined) {
    if (isCell(env, body.region)) return body.region;
    throw new ApiError('INVALID_INPUT', `region must be one of ${allCells(env).join(', ')}`);
  }
  if (typeof body.owner === 'string' && body.owner) {
    const place = await workspace(env, body.owner, { op: 'account_place' });
    return cellOfRegion(env, place.region);
  }
  const token = tokenOfRequest();
  const issued = token ? tokenCell(token) : FIRST_CELL;
  return issued === FIRST_CELL ? homeCell() : issued;
}
