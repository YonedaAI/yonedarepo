// Account addresses never reach a non-member of a repository. Accounts made before sign-up
// named them by handle are named by their email address, and that name is in every principal
// they leave (`user:<address>`: commits, log entries, changes, reviews, comments, sessions,
// releases, checks, the repository's owner). A repository's answers to anyone who reads it as
// neither owner nor member (anonymous included) show such an account by handle,
// `user:<handle>`, or `user:(hidden)` while it has none; members see the stored value. The
// REST router, repository MCP and account MCP each hand their answers here, once. Git
// identities (`email` fields of a commit's author and committer) are left alone: a clone
// serves them anyway.
import { handlesOf } from './repo-paths';
import type { Env, Json } from './types';

const PRINCIPAL = /^user:([^\s@:/]+@[^\s@:/]+)$/;
const ADDRESS = /^[^\s@:/]+@[^\s@:/]+\.[^\s@:/]+$/;
const HIDDEN = '(hidden)';

/** The account address `text` names (as a principal, or bare), if any. */
function address(text: string): string | null {
  const principal = PRINCIPAL.exec(text);
  if (principal) return principal[1];
  return ADDRESS.test(text) ? text : null;
}

/** Every address `value` holds, outside Git identities (`email` fields). */
function addresses(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const named = address(value);
    if (named) found.add(named);
  } else if (Array.isArray(value)) {
    for (const item of value) addresses(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) if (key !== 'email') addresses(item, found);
  }
  return found;
}

function replaced(value: unknown, handles: Map<string, string>): unknown {
  if (typeof value === 'string') {
    const named = address(value);
    if (!named) return value;
    const shown = handles.get(named) ?? HIDDEN;
    return value.startsWith('user:') ? `user:${shown}` : shown;
  }
  if (Array.isArray(value)) return value.map((item) => replaced(item, handles));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'email' ? item : replaced(item, handles),
      ]),
    );
  return value;
}

/**
 * A repository's answer as its caller may see it: unchanged when it names no address or
 * the caller is a member (`status`: the caller's view of the repository, asked only then),
 * else with each address replaced by its account's handle or `(hidden)`.
 */
export async function forViewer(env: Env, value: Json, status: () => Promise<Json>) {
  const found = addresses(value);
  if (found.size === 0) return value;
  const viewer = await status().then(
    (s) => s.viewer,
    () => null,
  );
  // An owner or member reads the stored value; anyone else (or a view that cannot be told)
  // reads handles.
  if (viewer && viewer.public !== true) return value;
  const handles = await handlesOf(env, [...found]);
  return replaced(value, handles) as Json;
}
