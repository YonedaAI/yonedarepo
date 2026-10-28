// The sidebar's repositories: every platform repository the account can use, with an agent
// project shown once, as its platform repository under the project's name. A project still
// being set up has no platform repository yet and is listed on its own.
import type { Repository } from '../../lib/types';

/** `GET /api/v1/repos`: `role` is `owner` for the account's own repositories. */
export type PlatformRepo = {
  id: string;
  name: string;
  created_at?: number;
  owner?: string;
  role?: string;
};

export type RepoRow = {
  key: string;
  name: string;
  /** The platform repository; absent while a project's setup has not bound one. */
  repo?: string;
  project?: Repository;
  /** Another account's repository this account is a member of: `owner · role`. */
  shared?: string;
};

/** The platform repository a project lands in, from its workspace record. */
export const projectRepo = (project: Repository): string | undefined =>
  project.platform?.repo ?? project.platform_repo;

export function repoRows(platform: PlatformRepo[], projects: Repository[]): RepoRow[] {
  const byRepo = new Map<string, Repository>();
  for (const project of projects) {
    const repo = projectRepo(project);
    if (repo) byRepo.set(repo, project);
  }
  const rows: RepoRow[] = platform.map((repo) => {
    const project = byRepo.get(repo.id);
    byRepo.delete(repo.id);
    return {
      key: repo.id,
      repo: repo.id,
      name: project?.name || repo.name || repo.id,
      project,
      shared: repo.role && repo.role !== 'owner' ? `${repo.owner} · ${repo.role}` : undefined,
    };
  });
  // Projects the platform listing does not (yet) show: still in setup, or read before it.
  for (const project of projects) {
    const repo = projectRepo(project);
    if (repo && !byRepo.has(repo)) continue;
    rows.push({ key: `project:${project.id}`, name: project.name, repo, project });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}
