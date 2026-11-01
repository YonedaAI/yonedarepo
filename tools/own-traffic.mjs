// Our own tools mark what they send, so the admin Traffic page counts other people, not us. The
// mark is the header the Workers read (cloudflare/worker/site-events.ts OWN_TRAFFIC_HEADER); it
// unlocks nothing, it only leaves the analytics. Node's fetch sends OWN_TRAFFIC, Git gets it from
// gitConfigEnv, and the `yoneda` CLI from OWN_TRAFFIC_ENV (backend/crates/yoneda-cli/src/http.rs).
// tests/runtime/live-browser-traffic.test.mjs fails a tool that talks to the platform without it.
// No Node imports: the bench Worker bundles this file.
export const OWN_TRAFFIC = { 'x-yoneda-own-traffic': '1' };
export const OWN_TRAFFIC_ENV = { YONEDA_OWN_TRAFFIC: '1' };

/**
 * Git's configuration as environment variables, so a token never reaches an argument: `config`
 * pairs, then the token and `headers` for `origin` (or every host, without one), then the mark.
 * One key for all of them: a header sent twice arrives as `1, 1`, and Git drops a broader key that
 * follows a narrower one.
 */
export function gitConfigEnv({ token, origin, headers = [], config = [] } = {}) {
  const key = origin ? `http.${origin}/.extraHeader` : 'http.extraHeader';
  const mark = Object.entries(OWN_TRAFFIC).map(([name, value]) => `${name}: ${value}`);
  const lines = [...(token ? [`Authorization: Bearer ${token}`] : []), ...headers, ...mark];
  const entries = [...config, ...lines.map((line) => [key, line])];
  return {
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(
      entries.flatMap(([name, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, name],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
  };
}
