// Who a browser's ping was, for one day (front Worker, VISITORS): a SHA-256 of the day's random
// salt, the address and the user agent, which are read here and stored nowhere. No cookie. The salt is deleted within two days, so the hash says "the
// same browser today" and can't follow anyone to the next day, or be worked back to an address.
// Budget: docs/load-testing.md.
import type { SignupRegion } from './region';
import type { SignupSource } from './site-events';
import { sha } from './storage';
import type { Env } from './types';

const HASH_LENGTH = 32;
const RETRY_MS = 60_000;

type Platform = { visitorSalt(day: string): Promise<string> };

export const visitorsOn = (env: Env) => env.VISITORS === 'on';

let held: { day: string; salt: string | null; at: number } | null = null;
export const forgetVisitorSalt = () => {
  held = null;
};

/** Today's salt, asked of the platform once a day per isolate. A failed ask isn't repeated for a
 * minute: pings are many, and one with no hash is still a view. */
async function saltOf(env: Env, day: string, now: number) {
  if (held?.day === day && (held.salt || now - held.at < RETRY_MS)) return held.salt;
  const salt = await (env.PLATFORM as unknown as Platform).visitorSalt(day).catch(() => null);
  held = { day, salt, at: now };
  return salt;
}

/** The ping's visitor hash, or null when there's no salt to be had. */
export async function visitorHash(req: Request, env: Env, now = Date.now()) {
  const salt = await saltOf(env, new Date(now).toISOString().slice(0, 10), now);
  if (!salt) return null;
  const address = req.headers.get('cf-connecting-ip') ?? '';
  const agent = req.headers.get('user-agent') ?? '';
  return (await sha(`${salt}|${address}|${agent}`)).slice(0, HASH_LENGTH);
}

/** The browser's family, from a user agent that isn't kept. Order matters: every Chromium browser
 * says Chrome, and Chrome says Safari. */
export function browserOf(agent: string) {
  if (/Edg\//.test(agent)) return 'Edge';
  if (/OPR\//.test(agent)) return 'Opera';
  if (/Firefox\//.test(agent)) return 'Firefox';
  if (/Chrome\/|Chromium\//.test(agent)) return 'Chrome';
  if (/Safari\//.test(agent)) return 'Safari';
  return 'Other';
}

/** What the platform is told of a new account, with where it came from when this is on. */
export const withSource = (env: Env, region: SignupRegion, source: SignupSource | null) =>
  visitorsOn(env) && source ? { ...region, source } : region;
