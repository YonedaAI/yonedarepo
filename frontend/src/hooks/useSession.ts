// The browser's account session: who is signed in (GET /api/auth/session), sign-out, and the
// moment the server stops accepting a session that was valid (another sign-in evicted it).
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onUnauthorized } from '../lib/api';
import type { AccountIdentity } from '../lib/types';

export type Session = ReturnType<typeof useSession>;

export function useSession() {
  const [identity, setIdentity] = useState<AccountIdentity | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const signedIn = useRef(false);
  const generation = useRef(0);
  const clear = useCallback(() => {
    generation.current++;
    signedIn.current = false;
    setIdentity(null);
    setError('');
    setLoading(false);
  }, []);
  useEffect(() => {
    return onUnauthorized(() => {
      if (!signedIn.current) return;
      clear();
      setSessionEnded(true);
    });
  }, [clear]);
  const discover = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await api<{ authenticated: boolean } & Partial<AccountIdentity>>(
        'auth/session?summary=true',
      );
      if (generation.current !== current) return;
      const next: AccountIdentity | null =
        result.authenticated && result.username
          ? {
              username: result.username,
              ...(result.handle !== undefined ? { handle: result.handle } : {}),
              display_name: result.display_name ?? null,
              ...(result.handle_suggestion !== undefined
                ? { handle_suggestion: result.handle_suggestion }
                : {}),
              avatar_url: result.avatar_url ?? null,
              avatar_source: result.avatar_source ?? null,
              ...(result.is_admin ? { is_admin: true } : {}),
            }
          : null;
      if (!next && signedIn.current) setSessionEnded(true);
      else setSessionEnded(false);
      signedIn.current = !!next;
      setIdentity(next);
      setError('');
      // Profile decoration is independent of admission to the workspace.
      if (next)
        void api<{ authenticated: boolean } & AccountIdentity>('auth/session')
          .then((details) => {
            if (generation.current !== current) return;
            if (!details.authenticated) {
              clear();
              setSessionEnded(true);
            } else if (details.username === next.username) {
              setIdentity(details);
            }
          })
          .catch(() => {
            /* Initials remain usable when optional details cannot load. */
          });
    } catch (e) {
      if (generation.current === current) setError((e as Error).message);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, [clear]);
  const signOut = useCallback(async () => {
    await api('auth/logout', {});
    clear();
    setSessionEnded(false);
  }, [clear]);
  /** A new picture or name, without reading the session again. */
  const patchIdentity = useCallback((change: Partial<AccountIdentity>) => {
    generation.current++; // A delayed profile must not overwrite an explicit edit.
    setIdentity((current) => current && { ...current, ...change });
  }, []);
  useEffect(() => {
    void discover();
    return () => {
      generation.current++;
    };
  }, [discover]);
  return {
    authenticated: identity !== null,
    identity,
    sessionEnded,
    loading,
    error,
    setError,
    discover,
    signOut,
    patchIdentity,
  };
}
