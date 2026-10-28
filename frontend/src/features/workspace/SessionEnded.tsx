import { LogIn } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { AccountPanel } from './AccountPanel';

/** Replaces the whole workspace once the server rejects a previously valid session. */
export function SessionEnded({ onConnected }: { onConnected: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="session-ended" aria-labelledby="session-ended-title">
      <div className="intent-symbol" aria-hidden="true">
        <LogIn size={26} />
      </div>
      <h1 id="session-ended-title" ref={heading} tabIndex={-1}>
        Your session ended
      </h1>
      <p>
        Sign in again to return to your workspace. Work already recorded in your repositories is
        unchanged.
      </p>
      <AccountPanel initialMode="login" onConnected={onConnected} />
    </section>
  );
}
