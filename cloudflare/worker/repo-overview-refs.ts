// Overview's branch selector needs names, not every branch's hash and log version.
import type { Json } from './repo-ops';
import { overviewRequested } from './repo-overview';
import type { Env } from './types';

/** A browser view only. Admission and content selection retain the full fresh status. */
export function overviewRefNames(env: Env, status: Json, query: URLSearchParams): Json {
  if (
    env.OVERVIEW_REF_NAMES !== 'on' ||
    !overviewRequested(env, query) ||
    query.get('refs_view') === 'full'
  )
    return status;
  const selected = query.get('ref') || 'main';
  const name = selected.startsWith('refs/') ? selected : `refs/heads/${selected}`;
  return {
    ...status,
    refs_view: 'names',
    refs: status.refs.map((ref: Json) =>
      ref.name.startsWith('refs/heads/') && ref.name !== name && ref.name !== 'refs/heads/main'
        ? { name: ref.name }
        : ref,
    ),
  };
}
