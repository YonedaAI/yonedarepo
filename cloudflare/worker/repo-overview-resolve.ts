// The named bootstrap reuses its resolver's fresh admission and canonical owner handle.

import { type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { overview } from './repo-overview';
import { statusWithHandle } from './repo-path-metadata';
import { forViewer } from './repo-principal-privacy';
import type { Env } from './types';

export async function resolvedOverview(
  env: Env,
  auth: Credentials | null,
  resolved: Json,
  status: Json,
  query: URLSearchParams,
): Promise<Json> {
  const { objects: _objects, ...summary } = status;
  const decorated = statusWithHandle(env, resolved.id, summary, resolved.handle);
  const ctx = new RepoContext(
    env,
    resolved.id,
    caller(env, resolved.id, auth ?? { _anonymous: true }),
  );
  const value = {
    ...resolved,
    name: summary.name,
    path: decorated.path,
    summary: { ...decorated, overview: await overview(ctx, summary, query) },
  };
  return forViewer(env, value, () => Promise.resolve(summary));
}
