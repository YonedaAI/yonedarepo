// Directory grants for object reads. The authority enforces grants on its own data
// (writes, reviews, landings, log paths); reads that go through the object store are
// checked here before any object is fetched, with decisions computed in Rust so grant
// semantics live in one place. Refusals are uniform: they never reveal whether a hidden
// path exists.
import { compute } from './repo-compute';
import { ApiError, type Json, type RepoContext } from './repo-ops';

export const outside = () => new ApiError('FORBIDDEN', 'Path is outside your grant');

/** The caller's grant (`null`: whole repository). */
export async function grantOf(ctx: RepoContext): Promise<string[] | null> {
  return (await ctx.status()).grant ?? null;
}

type Decision = { paths: boolean[]; dirs: boolean[]; restricted: boolean };

export async function decide(
  ctx: RepoContext,
  paths: string[],
  dirs: string[] = [],
): Promise<Decision> {
  const grant = await grantOf(ctx);
  if (!grant)
    return { paths: paths.map(() => true), dirs: dirs.map(() => true), restricted: false };
  const decided = compute({ op: 'grant_check', grant, paths, dirs });
  return { paths: decided.paths, dirs: decided.dirs, restricted: true };
}

export async function requirePath(ctx: RepoContext, path: string) {
  if (!(await decide(ctx, [path])).paths[0]) throw outside();
}

/** Keeps items whose `key` path is inside the grant. */
export async function keepAllowed<T extends Json>(
  ctx: RepoContext,
  items: T[],
  key = 'path',
): Promise<T[]> {
  const { paths } = await decide(
    ctx,
    items.map((i) => String(i[key])),
  );
  return items.filter((_, index) => paths[index]);
}
