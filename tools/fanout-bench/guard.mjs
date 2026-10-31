// Load tests run on dev only (docs/load-testing.md). Every bench entry point asks here first,
// and dev's hosts come from infra/envs/dev.json, so a typed prod URL has nothing to match.
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

/** What the benches need of the dev environment, from its spec and generated config. */
export function devSpec() {
  const spec = JSON.parse(read('../../infra/envs/dev.json'));
  const d1 = read('../../cloudflare/wrangler.dev-platform.jsonc').match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1] ?? null;
  return { env: spec.env, account: spec.account_id, prefix: spec.prefix, subdomain: spec.workers_subdomain, origin: spec.vars.origin, script: `${spec.prefix}-platform`, d1 };
}

/** Whether `url` is an https host of the dev environment. */
export function isDevUrl(url, spec = devSpec()) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || spec.env !== 'dev') return false;
  const origin = new URL(spec.origin).hostname;
  const { hostname } = parsed;
  if (hostname === origin || hostname === `api.${origin}`) return true;
  const suffix = `.${spec.subdomain}.workers.dev`;
  return hostname.endsWith(suffix) && hostname.startsWith(`${spec.prefix}-`) && !hostname.slice(0, -suffix.length).includes('.');
}

/** Throws unless every url is dev; `local` also allows loopback (a stub, never a platform). */
export function requireDev(urls, { local = false, spec = devSpec() } = {}) {
  for (const url of urls.filter(Boolean)) {
    if (isDevUrl(url, spec)) continue;
    if (local && LOOPBACK.has(new URL(url).hostname)) continue;
    throw new Error(`Refusing ${url}: load tests run on dev only`);
  }
}
