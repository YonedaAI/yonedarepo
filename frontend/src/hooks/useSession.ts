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
  useEffect(
    () =>
      onUnauthorized(() => {
        if (!signedIn.current) return;
        clear();
        setSessionEnded(true);
      }),
    [clear],
  );
  const discover = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const result = await api<{ authenticated: boolean } & Partial<AccountIdentity>>(
        'auth/session',
      );
      if (generation.current !== current) return;
      const next: AccountIdentity | null =
        result.authenticated && result.username
          ? {
              username: result.username,
              ...(result.handle !== undefined ? { handle: result.handle } : {}),
              ...(result.handle_suggestion !== undefined
                ? { handle_suggestion: result.handle_suggestion }
                : {}),
            }
          : null;
      if (!next && signedIn.current) setSessionEnded(true);
      else setSessionEnded(false);
      signedIn.current = !!next;
      setIdentity(next);
      setError('');
    } catch (e) {
      if (generation.current === current) setError((e as Error).message);
    } finally {
      if (generation.current === current) setLoading(false);
    }
  }, []);
  const signOut = useCallback(async () => {
    await api('auth/logout', {});
    clear();
    setSessionEnded(false);
  }, [clear]);
  useEffect(() => {
    void discover();
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
  };
}
