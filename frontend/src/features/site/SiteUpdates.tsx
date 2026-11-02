// The Flight log (`/updates`): email only, plus an unticked consent box, over the three kinds of
// email the list sends. Whether it takes sign-ups
// is the platform's answer (NEWSLETTER): until it says yes the page points to X, with no
// form, and the space is held so nothing moves when it does. After a sign-up every address reads
// the same, because the platform never says who is already on the list.
// `SiteUpdatesLink` is the page an emailed link opens. Opening it changes nothing, so a mail
// scanner that follows links can't confirm or unsubscribe anyone: only its button does.
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { subscriberEmail } from '../../../../shared/newsletter';
import { api } from '../../lib/api';
import type { Navigate } from '../shell/useRoute';
import { siteLink } from './SiteLayout';
import { SiteRadar } from './SiteRadar';

const FAILED = 'Could not sign you up. Try again in a minute.';
/** What the list sends, and only that. Nothing promises a schedule or early access: no release
 * has a set date, and nothing in the product can let a subscriber in ahead of anyone else. */
const SENT = [
  {
    label: 'Releases',
    title: 'What we shipped',
    line: 'What changed on the platform and in the CLI.',
  },
  {
    label: 'Features',
    title: 'What’s new to try',
    line: 'A note when a new feature is ready to use.',
  },
  {
    label: 'Engineering',
    title: 'How it was built',
    line: 'The numbers behind the work, like our global-scale tests.',
  },
];
type Field = 'email' | 'consent' | 'form';
type Problem = { field: Field; message: string };

function Frame({ title, line, children }: { title: string; line: string; children?: ReactNode }) {
  return (
    <section className="site-updates" aria-labelledby="updates-heading">
      <SiteRadar />
      <div className="site-updates-body">
        <h1 id="updates-heading">{title}</h1>
        <p role="status">{line}</p>
        <div className="site-updates-slot">{children}</div>
      </div>
    </section>
  );
}

/** Which of the form's rules the address and the box break, or null. */
export function formProblem(email: string, consent: boolean): Problem | null {
  if (!subscriberEmail(email)) return { field: 'email', message: 'Enter a valid email address.' };
  if (!consent) return { field: 'consent', message: 'Tick the box to get updates by email.' };
  return null;
}

export function SignUpForm({ onSent }: { onSent: () => void }) {
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const consentInput = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const wrong = formProblem(email, consent);
    setProblem(wrong);
    if (wrong) {
      (wrong.field === 'email' ? emailInput : consentInput).current?.focus();
      return;
    }
    setBusy(true);
    try {
      await api('v1/newsletter', { email, consent: true });
      onSent();
    } catch (e) {
      const rateLimited = (e as { code?: string }).code === 'RATE_LIMITED';
      setProblem({ field: 'form', message: rateLimited ? (e as Error).message : FAILED });
      setBusy(false);
    }
  };
  return (
    <form className="site-updates-form" onSubmit={submit} noValidate>
      <input
        ref={emailInput}
        type="email"
        name="email"
        autoComplete="email"
        aria-label="Email address"
        placeholder="you@example.com"
        aria-invalid={problem?.field === 'email'}
        aria-describedby={problem ? 'updates-problem' : undefined}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
      <label className="site-updates-consent">
        <input
          ref={consentInput}
          type="checkbox"
          aria-invalid={problem?.field === 'consent'}
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        <span>Email me YonedaRepo updates. I can unsubscribe at any time.</span>
      </label>
      <button type="submit" className="site-button" disabled={busy}>
        Get updates
      </button>
      {problem && (
        <p id="updates-problem" className="site-updates-problem" role="alert">
          {problem.message}
        </p>
      )}
    </form>
  );
}

export function SiteUpdates() {
  const [state, setState] = useState<'loading' | 'open' | 'closed' | 'sent'>('loading');
  useEffect(() => {
    let live = true;
    api<{ open: boolean }>('v1/newsletter')
      .then(({ open }) => live && setState(open ? 'open' : 'closed'))
      // Not knowing is the same as not open: never a form that can't work.
      .catch(() => live && setState('closed'));
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      {state === 'sent' ? (
        <Frame title="Check your inbox" line="Open the link in the email to confirm." />
      ) : (
        <Frame title="Flight log" line="Updates on what we ship, by email, when there’s news.">
          {state === 'open' && <SignUpForm onSent={() => setState('sent')} />}
          {state === 'closed' && (
            <p className="site-updates-soon">
              Follow along on <a href="https://x.com/YonedaRepo">X</a>.
            </p>
          )}
        </Frame>
      )}
      <ul className="site-cells site-tiles site-updates-sent">
        {SENT.map(({ label, title, line }) => (
          <li key={label}>
            <span className="site-updates-label">{label}</span>
            <h2>{title}</h2>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

const LINKS = {
  confirm: {
    title: 'Confirm updates',
    line: 'Press Confirm to start getting updates from YonedaRepo.',
    button: 'Confirm',
    path: 'v1/newsletter/confirm',
    doneTitle: 'You’re on the list',
    doneLine: 'Every email has an unsubscribe link.',
    invalid: 'This link is invalid, used or expired.',
  },
  unsubscribe: {
    title: 'Unsubscribe',
    line: 'Press Unsubscribe to stop getting updates from YonedaRepo.',
    button: 'Unsubscribe',
    path: 'v1/newsletter/unsubscribe',
    doneTitle: 'You’re unsubscribed',
    doneLine: 'We won’t email you again.',
    invalid: 'This link is not valid.',
  },
};

export function SiteUpdatesLink({
  action,
  token,
  navigate,
}: {
  action: 'confirm' | 'unsubscribe';
  token: string;
  navigate: Navigate;
}) {
  const copy = LINKS[action];
  const [state, setState] = useState<'ready' | 'busy' | 'done' | 'invalid' | 'failed'>(
    token ? 'ready' : 'invalid',
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState('busy');
    try {
      await api(copy.path, { token });
      setState('done');
    } catch (e) {
      setState((e as { code?: string }).code === 'INVALID_TOKEN' ? 'invalid' : 'failed');
    }
  };
  if (state === 'done') return <Frame title={copy.doneTitle} line={copy.doneLine} />;
  if (state === 'invalid')
    return (
      <Frame title={copy.title} line={copy.invalid}>
        <a className="site-more" {...siteLink({ page: 'updates' }, navigate)}>
          Go to the Flight log
        </a>
      </Frame>
    );
  return (
    <Frame title={copy.title} line={copy.line}>
      <form onSubmit={submit}>
        <button type="submit" className="site-button" disabled={state === 'busy'}>
          {copy.button}
        </button>
        {state === 'failed' && (
          <p className="site-updates-problem" role="alert">
            That didn’t go through. Try again in a minute.
          </p>
        )}
      </form>
    </Frame>
  );
}
