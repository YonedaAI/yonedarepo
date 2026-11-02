// Keep the operator feed and its browser-local unread watermark together.
import { useCallback, useState } from 'react';
import { useSource } from '../source-platform/useSource';
import { readSeen, type Signups, saveSeen, signupsPath } from './adminModel';

export function useSignups(identity: { is_admin?: boolean } | null | undefined) {
  const isAdmin = Boolean(identity?.is_admin);
  const [signupsSeen, setSignupsSeen] = useState(readSeen);
  const signups = useSource<Signups>(isAdmin ? signupsPath(signupsSeen) : null);
  const onSignupsSeen = useCallback((at: number) => {
    saveSeen(at);
    setSignupsSeen(at);
  }, []);
  return { isAdmin, signups, signupsSeen, onSignupsSeen };
}
