// Forks as the browser asks for them (git_fork, and git_change_create with `fork`): the
// requests the Fork button and a change opened against a fork's parent send.

/** Where a change from a fork lands: on the fork itself, or on its parent. */
export type ChangeTarget = 'here' | 'parent';

/** `POST /repos/:id/fork`: a blank name keeps the parent's; a blank owner is the caller. */
export function forkRequest(repo: string, name: string, owner = '') {
  const trimmed = name.trim();
  return {
    path: `/repos/${repo}/fork`,
    body: { ...(trimmed ? { name: trimmed } : {}), ...(owner ? { owner } : {}) },
  };
}

/** `POST /changes` on the target repository: on the parent, the fork and its branch. */
export function changeRequest(
  repo: string,
  parent: string | undefined,
  target: ChangeTarget,
  change: { branch: string; title: string; body: string; base?: string },
) {
  const fields = {
    branch: change.branch,
    base: change.base?.trim() || undefined,
    title: change.title.trim(),
    body: change.body.trim() || undefined,
  };
  return target === 'parent' && parent
    ? { repo: parent, path: `/repos/${parent}/changes`, body: { fork: repo, ...fields } }
    : { repo, path: `/repos/${repo}/changes`, body: fields };
}
