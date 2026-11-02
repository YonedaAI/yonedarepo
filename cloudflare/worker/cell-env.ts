// A cell's bindings as its code uses them. Inside a cell nothing asks where it is, so what a
// cell needs of its namespaces is decided once, here: its own object classes restricted to its
// jurisdiction, and a new account authority started near it. The account namespace is shared
// between cells, so it can only take a hint: a jurisdiction would change every account's id.
import type { Env } from './types';

/** `namespace` with every `get` asking for `hint`; a hint counts only on an object's first. */
export function hinted(namespace: DurableObjectNamespace, hint: string): DurableObjectNamespace {
  return new Proxy(namespace, {
    get(target, key) {
      if (key === 'get')
        return (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) =>
          target.get(id, { ...options, locationHint: hint as DurableObjectLocationHint });
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const OWN_CLASSES = [
  'SOURCE_REPOS',
  'COMMIT_SHARDS',
  'LAND_COMBINERS',
  'CHECK_RUNNERS',
  'IMPORT_RUNNERS',
  'PACK_BUILDERS',
] as const;

const made = new WeakMap<Env, Env>();

/** `env` as this cell's code sees it; `env` itself in `enam`, which has neither setting. */
export function cellEnv(env: Env): Env {
  const { CELL_JURISDICTION: jurisdiction, CELL_HINT: hint } = env;
  if (!jurisdiction && !hint) return env;
  const held = made.get(env);
  if (held) return held;
  const near: Env = { ...env };
  if (jurisdiction)
    for (const key of OWN_CLASSES) {
      const namespace = env[key] as DurableObjectNamespace | undefined;
      if (namespace)
        (near as unknown as Record<string, unknown>)[key] = namespace.jurisdiction(
          jurisdiction as DurableObjectJurisdiction,
        );
    }
  if (hint) near.WORKSPACES = hinted(env.WORKSPACES, hint);
  made.set(env, near);
  return near;
}
