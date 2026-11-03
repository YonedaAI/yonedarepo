// One authorized Overview read. Mutable admission/status stays fresh; every content
// section is selected from one tree's commit, rather than following a moving branch again.
import { failure } from './repo-api-failure';
import { listTree, readFileFromTree } from './repo-files';
import type { Json, RepoContext } from './repo-ops';
import { overviewActivity } from './repo-overview-activity';
import { timed } from './repo-timing';
import type { Env } from './types';

export const overviewRequested = (env: Env, query?: URLSearchParams) =>
  env.OVERVIEW_BOOTSTRAP === 'on' &&
  query?.get('summary') === 'true' &&
  query.get('overview') === 'true';

type Section = 'tree' | 'latest' | 'activity' | 'readme';
const readmeName = (entries: Json[]) =>
  entries.find((e) => e.type !== 'tree' && /^readme(\.(md|markdown))?$/i.test(e.name))?.name;

/** Only the fields Overview displays: histories and check evidence can be large. */
function latestView(value: Json): Json {
  return {
    commit: value.commit,
    message: String(value.message).split('\n')[0],
    principal: value.principal,
    author_name: value.author_name,
    authored_at: value.authored_at,
    landings: (value.landings as Json[]).map(({ refname, landed_at }) => ({ refname, landed_at })),
    checks: (value.checks as Json[]).map(({ name, status }) => ({ name, status })),
    ...(value.gates && {
      gates: {
        missing_checks: value.gates.missing_checks,
        failing_checks: value.gates.failing_checks,
      },
    }),
  };
}

/** `status` is this request's successful authority answer, before principal redaction. */
export async function overview(
  ctx: RepoContext,
  status: Json,
  query: URLSearchParams,
): Promise<Json> {
  ctx.retainStatus(status);
  const fresh = ctx;
  const ref = query.get('ref') || 'main';
  const minVersion = Math.max(status.version, Number(query.get('min_version') ?? 0));
  const deferActivity =
    ctx.env.OVERVIEW_DEFER_ACTIVITY === 'on' &&
    status.parent == null &&
    status.grant == null &&
    !query.has('commit') &&
    minVersion <= status.version;
  const selectedAt = query.get('at');
  const at = selectedAt === null || selectedAt === '' ? status.version : Number(selectedAt);
  const errors: Partial<Record<Section, Json>> = {};
  let empty = false;
  const part = async (name: Section, run: () => Promise<Json | null>) => {
    try {
      return await timed(`overview.${name}`, run);
    } catch (e: any) {
      if (name === 'tree' && e?.code === 'NOT_FOUND') empty = true;
      else {
        const response = failure(e);
        const { error } = await response.json<{ error: Json }>();
        // Unlike a failed standalone request, this envelope is HTTP 200. Preserve the
        // browser client's masking of unexpected server faults in its section errors.
        errors[name] =
          response.status >= 500 && response.status !== 507
            ? { ...error, message: 'Something went wrong on our side.' }
            : error;
      }
      return null;
    }
  };
  const tree = await part('tree', () =>
    listTree(fresh, {
      path: '',
      ref,
      commit: query.get('commit') ?? undefined,
      // The deferred window and core must share admission's version even if main moves.
      at: deferActivity ? at : (query.get('at') ?? undefined),
      // A freshly acknowledged landing must not be hidden behind an older cached head.
      min_version: minVersion,
    }),
  );
  let latest: Json | null = null;
  let activity: Json | null = empty ? { commits: [] } : null;
  let readme: Json | null = null;
  if (tree) {
    const name = readmeName(tree.entries);
    [latest, activity, readme] = await Promise.all([
      part('latest', () => fresh.call({ op: 'repo_commit', commit: tree.commit }).then(latestView)),
      deferActivity
        ? Promise.resolve(null)
        : part('activity', () => overviewActivity(fresh, status, ref, tree.commit, query)),
      part('readme', () => (name ? readFileFromTree(fresh, tree, name) : Promise.resolve(null))),
    ]);
  }
  return {
    ref,
    tree,
    latest,
    activity,
    readme,
    empty,
    ...(tree &&
      deferActivity && {
        activity_request: {
          ref,
          from: tree.commit,
          at,
        },
      }),
    ...(Object.keys(errors).length && { errors }),
  };
}
