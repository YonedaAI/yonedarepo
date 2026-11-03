// A new repository follows the current visitor's location before an org/account home.
// A selected internal destination wins across forwarding. The id fixes its authority.

import { homeCell } from './account-place';
import { allCells, cellOfRegion, cellsOn, isCell, thisCell } from './cells';
import { localityRegion } from './repo-locality';
import { ApiError, type Json } from './repo-ops';
import type { Env } from './types';
import { workspace } from './workspace';

/** The cell a create belongs in; this Worker's with cells off. */
export async function cellForNew(env: Env, body: Json): Promise<string> {
  if (!cellsOn(env)) return thisCell(env);
  if (body.region !== undefined) {
    if (isCell(env, body.region)) return body.region;
    throw new ApiError('INVALID_INPUT', `region must be one of ${allCells(env).join(', ')}`);
  }
  const region = localityRegion(env);
  // Only the EU authority has a distinct storage jurisdiction. Other physical
  // origins retain the default authority's names and use their own first-get hint.
  if (region) return cellOfRegion(env, region === 'weur' ? 'weur' : 'enam');
  if (typeof body.owner === 'string' && body.owner) {
    const place = await workspace(env, body.owner, { op: 'account_place' });
    return cellOfRegion(env, place.region);
  }
  return homeCell();
}
