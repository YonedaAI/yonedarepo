// The repository policy as `PUT /repos/:id/policy` takes it (and `GET /repos/:id` returns
// it). Types and catalogs come from the Rust policy (shared/contracts/policy.ts, `cargo
// xtask contracts`); the server still validates every change and its message is shown as is.
import {
  type Policy as GeneratedPolicy,
  type Runner as GeneratedRunner,
  type SecretAllow as GeneratedSecretAllow,
  policySchema,
} from '../../../../shared/contracts/policy';

/** Fields this browser does not know yet (a newer server) are kept and sent back as is:
 * the editor changes only the fields it knows. */
export type Policy = GeneratedPolicy & { [unknown: string]: unknown };
export type Runner = GeneratedRunner;
export type ModelRunner = Extract<Runner, { kind: 'model' }>;
export type CommandRunner = Exclude<Runner, ModelRunner>;
export type SecretAllow = GeneratedSecretAllow;
type AutoApprovable = NonNullable<Policy['auto_approve']>[number];

const [commandRunner, modelRunner] = policySchema.$defs.Runner.anyOf;
const LABELS: Record<AutoApprovable, string> = {
  docs: 'Documentation only',
  formatting: 'Formatting only',
  comment_only: 'Comments only',
};
/** Review classes a policy may auto-approve (platform_review::ReviewClass::AUTO_APPROVABLE). */
export const AUTO_APPROVABLE = policySchema.properties.auto_approve.items.enum.map((id) => ({
  id,
  label: LABELS[id],
}));
/** The secret-scan rules `secret_allow` may name (secret_scan::RULES). */
export const SECRET_RULES = policySchema.$defs.SecretAllow.properties.rule.enum;
/** The platform's model review catalog (platform_model_check::MODELS); the default first. */
export const REVIEW_MODELS = modelRunner.properties.model.enum;
export const DEFAULT_TIMEOUT_SECONDS = commandRunner.properties.timeout_seconds.default;
/** The check-name rule (policy::CHECK_NAME_PATTERN) for a `pattern` attribute, unanchored. */
export const CHECK_NAME = policySchema.properties.required_checks.items.pattern.slice(1, -1);

export const isModel = (runner: Runner): runner is ModelRunner => runner.kind === 'model';

/** A list typed as text: one entry per line or comma, blanks dropped, duplicates once. */
export function listFromText(text: string): string[] {
  const items = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(items)];
}

/** A command as one line: plain words joined by spaces, otherwise its JSON array. */
export function argvText(argv: string[]): string {
  return argv.every((a) => a && !/[\s"'\\[\]]/.test(a)) ? argv.join(' ') : JSON.stringify(argv);
}

/** The inverse of `argvText`: a JSON array of strings, or words split on whitespace. */
export function parseArgv(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    const value: unknown = JSON.parse(trimmed);
    if (!Array.isArray(value) || !value.every((a) => typeof a === 'string'))
      throw new Error('A command in brackets must be a JSON array of strings');
    return value;
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/** `policy` requiring exactly `checks`; posters of checks no longer required are dropped
 * (the server binds posters only to required checks). */
export function withRequiredChecks(policy: Policy, checks: string[]): Policy {
  const posters = Object.fromEntries(
    Object.entries(policy.check_posters ?? {}).filter(([name]) => checks.includes(name)),
  );
  return withOptional({ ...policy, required_checks: checks }, 'check_posters', posters);
}

/** `policy` with `name` required or not; a check that stops being required loses its
 * posters (the server binds posters only to required checks). */
export function withRequired(policy: Policy, name: string, required: boolean): Policy {
  const listed = policy.required_checks.includes(name);
  if (listed === required) return policy;
  const next = {
    ...policy,
    required_checks: required
      ? [...policy.required_checks, name]
      : policy.required_checks.filter((c) => c !== name),
  };
  return required ? next : withPosters(next, name, []);
}

/** `policy` with `name`'s runner replaced (or removed with `null`). A removed runner stays
 * required only if the owner keeps it listed by hand. */
export function withRunner(policy: Policy, name: string, runner: Runner | null): Policy {
  const runners = { ...(policy.runners ?? {}) };
  if (runner) runners[name] = runner;
  else delete runners[name];
  return withOptional(policy, 'runners', runners);
}

export function withPosters(policy: Policy, check: string, posters: string[]): Policy {
  const all = { ...(policy.check_posters ?? {}) };
  if (posters.length) all[check] = posters;
  else delete all[check];
  return withOptional(policy, 'check_posters', all);
}

/** Required checks without a runner: the ones posted by hand, which posters can bind. */
export const postedChecks = (policy: Policy) =>
  policy.required_checks.filter((name) => !policy.runners?.[name]);

/** Sets an optional field, leaving it out when empty (as the server serializes it). */
function withOptional<K extends 'runners' | 'check_posters'>(
  policy: Policy,
  key: K,
  value: NonNullable<Policy[K]>,
): Policy {
  const next = { ...policy };
  if (Object.keys(value).length) next[key] = value;
  else delete next[key];
  return next;
}
