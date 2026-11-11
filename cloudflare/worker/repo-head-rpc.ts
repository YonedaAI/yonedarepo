// Optional head-holder RPC contract. Metadata remains separate from access decisions.
import type { OperationCarrier } from './operation-carrier';
import type { TreeEntry } from './repo-objects';
import type { Json } from './repo-ops';
import type { Env } from './types';

type Holder = {
  head(
    repo: string,
    minVersion: number,
    since?: number,
    access?: string | null,
    observation?: OperationCarrier,
  ): Promise<Json>;
  access(repo: string, observation?: OperationCarrier): Promise<Json>;
  refresh(repo: string, access?: boolean): Promise<void>;
  trees(
    repo: string,
    root: string,
    paths: string[],
    commit?: string,
    observation?: OperationCarrier,
  ): Promise<Record<string, TreeEntry[]>>;
};

export function headHolder(env: Env, repo: string): Holder | null {
  const namespace = env.LAND_COMBINERS;
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName(`${repo}#head`)) as unknown as Partial<Holder>;
  return typeof stub.head === 'function' ? (stub as Holder) : null;
}
