// GitHub's refusal of a call, by its status alone. Imports nothing.

export class GitHubAccessError extends Error {
  constructor(readonly status: number) {
    super(`GitHub answered ${status}`);
  }
}

/** GitHub's answer that this access is over: the installation gone, suspended, or no longer
 * given the repository. A status of its own failing (429, 5xx) may yet pass. */
export const accessGone = (e: unknown) =>
  e instanceof GitHubAccessError && [401, 403, 404, 422].includes(e.status);
