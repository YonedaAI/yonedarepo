import { useCallback, useEffect, useState } from 'react';
import { guideNavigationUrl, guideReferences, saveGuideReference } from './guidedNavigation';
export function useGuidedNavigation(repo: string, authenticated: boolean) {
  const [references, setReferences] = useState(() => {
    if (typeof window === 'undefined') return {} as Record<string, string>;
    const refs = guideReferences(window.sessionStorage),
      query = new URLSearchParams(window.location.search);
    const repo = query.get('repo');
    if (query.get('guided') === 'task-board-v1' && repo) refs[repo] = query.get('session') ?? '';
    return refs;
  });
  const remember = useCallback((repoId: string, sessionId = '') => {
    const refs = saveGuideReference(
      { repo_id: repoId, session_id: sessionId },
      typeof window === 'undefined' ? undefined : window.sessionStorage,
    );
    setReferences(refs);
  }, []);
  const session = Object.hasOwn(references, repo) ? references[repo] : undefined;
  useEffect(() => {
    if (authenticated && typeof window !== 'undefined')
      window.history.replaceState(
        null,
        '',
        guideNavigationUrl(window.location.href, repo, session),
      );
  }, [repo, session, authenticated]);
  return { session, remember };
}
