// Authorized file/directory walks may reuse the existing repository tree holder. This
// route helper never runs inside that holder and never selects a revision for a caller.
import { cellOfRepo } from './cells';
import { regionOfRequest } from './region';
import { headTrees } from './repo-head';
import type { RepoObjects } from './repo-objects';
import { timed } from './repo-timing';
import { currentScope } from './request-scope';

/** Whether this exact walk would read a tree missing from the bounded isolate memory. */
function needsTrees(objects: RepoObjects, root: string, path: string, directory: boolean) {
  let id = root;
  for (const part of path.split('/').filter(Boolean)) {
    const entries = objects.remembered(id);
    if (!entries) return true;
    const entry = entries.find((e) => e.name === part);
    // The ordinary walker preserves the missing-entry/non-directory error behavior.
    if (entry?.type !== 'tree') return false;
    id = entry.id;
  }
  return directory && !objects.remembered(id);
}

/** Only after the enclosing request authorized this path and adopted its withholding
 * snapshot. Foreign readers retain nearby copies; a fork retains its parent's guards. */
export async function warmReadTrees(
  objects: RepoObjects,
  root: string,
  path: string,
  commit?: string,
  directory = false,
) {
  const req = currentScope()?.req;
  if (
    objects.env.SHARED_READ_TREES !== 'on' ||
    !objects.knowsWithheld ||
    objects.inherited ||
    !req ||
    regionOfRequest(req) !== cellOfRepo(objects.repo) ||
    !needsTrees(objects, root, path, directory)
  )
    return;
  const paths = [directory && path ? `${path}/` : path];
  const found = await timed('read.trees', () =>
    headTrees(objects.env, objects.repo, root, paths, commit),
  );
  if (found) objects.remember(found);
}
