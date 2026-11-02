// The sign-in form's forgotten password: one field, one answer. The Worker says the same thing
// whether or not the account exists, so this page has nothing else to say.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import {
  isValidAccountIdentifier,
  MAX_ACCOUNT_IDENTIFIER_LENGTH,
} from '../../../../shared/account';
import { api } from '../../lib/api';

export const FORGOT_ANSWER = 'If that account has a confirmed email, a reset link is on its way.';

export function ForgotPassword({ busy, onBusy }: { busy: boolean; onBusy: (on: boolean) => void }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  // The link that opened this form is gone: keep the keyboard here.
  useEffect(() => field.current?.focus(), []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const username = new FormData(event.currentTarget).get('username');
    setError('');
    if (typeof username !== 'string' || !isValidAccountIdentifier(username)) {
      setError('Enter a valid username or email address.');
      return;
    }
    onBusy(true);
    try {
      await api('auth/password/forgot', { username });
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      onBusy(false);
    }
  };
  if (sent) return <p role="status">{FORGOT_ANSWER}</p>;
  return (
    <form onSubmit={submit}>
      <label>
        Username or email
        <input
          ref={field}
          name="username"
          required
          autoComplete="username"
          maxLength={MAX_ACCOUNT_IDENTIFIER_LENGTH}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="your_name or you@example.com"
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy} type="submit">
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
    </form>
  );
}
