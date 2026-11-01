// Settings → Profile: the account's handle, which is its address on the site. An account named
// by its handle shows it read-only (the server answers HANDLE_FIXED); an email-named one picks
// or changes it in the same dialog sign-in asks with.
import { useState } from 'react';
import { SettingsRow } from '../../components/SettingsSection';
import type { AccountIdentity } from '../../lib/types';
import { linkTo, type Navigate } from '../shell/useRoute';
import { HandlePicker } from '../workspace/HandlePicker';

export function HandleRow({
  identity,
  navigate,
  onChange,
}: {
  identity: Pick<AccountIdentity, 'username' | 'handle'>;
  navigate?: Navigate;
  /** The handle is set: the caller reads the session again. */
  onChange: (handle: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const { handle } = identity;
  // A server without handles says nothing.
  if (handle === undefined) return null;
  const fixed = !identity.username.includes('@');
  const address =
    handle &&
    (navigate ? (
      <a {...linkTo({ view: 'profile', handle }, navigate)}>/{handle}</a>
    ) : (
      <a href={`/${handle}`}>/{handle}</a>
    ));
  return (
    <>
      <SettingsRow
        title="Handle"
        detail={
          !address ? (
            'Pick one to give your profile and repositories readable addresses.'
          ) : fixed ? (
            <>{address} is your address. It’s your account name, so it can’t change.</>
          ) : (
            <>{address} is your address.</>
          )
        }
        action={
          !fixed && (
            <button type="button" className="quiet" onClick={() => setEditing(true)}>
              {handle ? 'Change' : 'Choose'}
            </button>
          )
        }
      />
      {editing && (
        <HandlePicker
          current={handle}
          cancel="Cancel"
          onLater={() => setEditing(false)}
          onDone={(chosen) => {
            setEditing(false);
            onChange(chosen);
          }}
        />
      )}
    </>
  );
}
