// New-object placement follows trusted client geography, independent of API execution.
// Cell/namespace/jurisdiction selection has already happened and is never changed here.
import { FIRST_CELL } from './cells';
import { regionOfRequest } from './region';
import { automaticLocality } from './repo-locality';
import { currentScope } from './request-scope';
import type { Env } from './types';

/** Authority/store selection and physical first placement are separate. */
export function creationOrigin(env: Env, cell: string): string | null {
  const request = currentScope()?.req;
  if (
    !automaticLocality(env) ||
    !request ||
    new URL(request.url).pathname.startsWith('/internal/ssh/')
  )
    return null;
  const origin = regionOfRequest(request);
  if (!origin) return null;
  // A selected EU authority stays there, even for a traveling creator in Asia.
  if (env.CELL_JURISDICTION === 'eu' || cell === 'weur') return env.CELL_HINT ?? 'weur';
  if (cell !== FIRST_CELL || env.CELL_JURISDICTION) return null;
  return origin;
}
