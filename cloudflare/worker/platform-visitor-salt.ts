// The day's salt for the visitor hash (VISITORS): random, made on the day's first ask and shared
// with the front Worker over RPC, which has no D1. Only today's and yesterday's are kept, so a
// past hash can't be rebuilt from an address: that's what makes a visitor one day's visitor.
import { ApiError } from './repo-ops';
import type { Env } from './types';

const DAY_MS = 86_400_000;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The salt of `day`, which must be today's or yesterday's in UTC. */
export async function visitorSalt(env: Env, day: string, now = Date.now()) {
  const yesterday = dayOf(now - DAY_MS);
  if (env.VISITORS !== 'on' || (day !== dayOf(now) && day !== yesterday))
    throw new ApiError('NOT_FOUND', 'No such salt');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const fresh = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const [, , read] = await env.INDEX.batch([
    env.INDEX.prepare('INSERT OR IGNORE INTO platform_visitor_salts(day,salt) VALUES(?,?)').bind(
      day,
      fresh,
    ),
    env.INDEX.prepare('DELETE FROM platform_visitor_salts WHERE day<?').bind(yesterday),
    env.INDEX.prepare('SELECT salt FROM platform_visitor_salts WHERE day=?').bind(day),
  ]);
  const salt = (read.results[0] as { salt?: unknown } | undefined)?.salt;
  if (typeof salt !== 'string') throw new ApiError('INTERNAL', 'The salt was not kept');
  return salt;
}
