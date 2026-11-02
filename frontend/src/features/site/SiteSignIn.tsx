// The sign-in page (`/signin`, `/signup`). Its heading follows the form: the tabs and the
// forgotten-password steps change what the page is for without changing its address.
import { useEffect, useState } from 'react';
import { type AccountMode, AccountPanel, accountTitle } from '../workspace/AccountPanel';
import { pageTitle } from './seo';

export function SiteSignIn({
  mode: opened,
  error,
  onConnected,
}: {
  mode: 'login' | 'signup';
  error?: string;
  onConnected: () => void;
}) {
  const [mode, setMode] = useState<AccountMode>(opened);
  const title = mode === 'signup' ? pageTitle({ page: 'signin', mode }) : accountTitle(mode);
  useEffect(() => {
    document.title = `${title} — YonedaRepo`;
  }, [title]);
  return (
    <section className="site-signin" aria-labelledby="signin-heading">
      <h1 id="signin-heading">{title}</h1>
      <AccountPanel
        initialMode={opened}
        initialError={error}
        onMode={setMode}
        onConnected={onConnected}
      />
    </section>
  );
}
