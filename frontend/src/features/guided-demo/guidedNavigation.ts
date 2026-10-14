export interface GuideReference {
  repo_id: string;
  session_id: string;
}
export interface GuideStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const key = 'yoneda-guided-projects-v1';
/** Saved pointers are navigation only. Every session is reread through the current owner's API. */
export function guideReferences(store?: GuideStore): Record<string, string> {
  try {
    const value = JSON.parse(store?.getItem(key) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const refs: Record<string, string> = {};
    for (const [repo, session] of Object.entries(value).slice(-100)) {
      if (repo && typeof session === 'string') refs[repo] = session;
    }
    return refs;
  } catch {
    return {};
  }
}
export function saveGuideReference(reference: GuideReference, store?: GuideStore) {
  const values = guideReferences(store);
  values[reference.repo_id] = reference.session_id;
  try {
    store?.setItem(key, JSON.stringify(values));
  } catch {
    /* URL navigation still works if browser storage is unavailable. */
  }
  return values;
}
export function guideNavigationUrl(current: string, repo: string, session?: string) {
  const url = new URL(current);
  if (url.searchParams.get('repo') !== repo) url.searchParams.delete('run');
  if (repo) url.searchParams.set('repo', repo);
  else url.searchParams.delete('repo');
  if (session !== undefined) {
    url.searchParams.set('guided', 'task-board-v1');
    if (session) url.searchParams.set('session', session);
    else url.searchParams.delete('session');
  } else {
    url.searchParams.delete('guided');
    url.searchParams.delete('session');
  }
  return url;
}
