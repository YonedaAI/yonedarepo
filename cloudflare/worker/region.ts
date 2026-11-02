// Where a request comes from, at continent level (global regions stage R1,
// docs/global-scale-plan.md): a continent or a code made from one, never an address or a city.
// REGION_SIGNALS records them, and off records nothing; cells.ts turns a code into a cell.
// `request.cf` exists on the Worker a client reached and on a request passed on whole
// (`PLATFORM.fetch(req)`, `new Request(url, req)`). A request rebuilt from its URL and an RPC call
// carry none, so a sign-up reads its region here and hands the code on as a value.
import type { Env } from './types';

/** Each continent's Cloudflare location hint: one code per continent, so the choice of which
 * cell serves which code stays open. yoneda-core's `ACCOUNT_REGIONS` lists the same codes. */
const REGIONS = new Map([
  ['AF', 'afr'],
  ['AS', 'apac'],
  ['EU', 'weur'],
  ['NA', 'enam'],
  ['OC', 'oc'],
  ['SA', 'sam'],
]);
const CODES = new Set(REGIONS.values());
/** Cloudflare's other `continent` values: Antarctica has no code, and `T1` (Tor) is no place. */
const NO_REGION = 'AN';

export type SignupRegion = { region?: string };

export const regionSignals = (env: Env) => env.REGION_SIGNALS === 'on';

/** A code an account may record. */
export const isRegion = (value: unknown): value is string =>
  typeof value === 'string' && CODES.has(value);

/** The request's continent code, or nothing where Cloudflare gave none we know. */
export function continentOf(req: Request) {
  const continent = (req.cf as { continent?: unknown } | undefined)?.continent;
  if (typeof continent !== 'string') return '';
  return REGIONS.has(continent) || continent === NO_REGION ? continent : '';
}

/** The request's sign-up code, or nothing: read where it arrives, whatever the switch. */
export const regionOfRequest = (req: Request) => REGIONS.get(continentOf(req));

/** A new account's region, as the field of a command: nothing while the switch is off or the
 * continent is unknown, and the account then reads as `enam` like every older one. */
export function signupRegion(req: Request, env: Env): SignupRegion {
  const region = regionSignals(env) ? REGIONS.get(continentOf(req)) : undefined;
  return region ? { region } : {};
}
