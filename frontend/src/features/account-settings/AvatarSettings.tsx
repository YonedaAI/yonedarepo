// Account settings → Profile: the account's picture and name. The picture is the one shown now
// (an upload, the GitHub or Google picture from the last sign-in, or the initial), an upload
// (PNG, JPEG or WebP up to 1 MB; the platform checks the bytes too) and removing an upload.
import { useRef, useState } from 'react';
import { SettingsRow } from '../../components/SettingsSection';
import type { AccountIdentity } from '../../lib/types';
import { Avatar } from '../shell/Avatar';
import { Failure } from '../source-platform/SourceStatus';

export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const MAX_PICTURE_BYTES = 1024 * 1024;

/** Why a chosen file cannot be a picture, or '' when it can be sent. */
export function pictureProblem(file: Pick<File, 'type' | 'size'>): string {
  if (!PICTURE_TYPES.includes(file.type)) return 'Use a PNG, JPEG or WebP picture.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_PICTURE_BYTES) return 'Use a picture of at most 1 MB.';
  return '';
}

type Picture = Pick<AccountIdentity, 'avatar_url' | 'avatar_source'>;

const SOURCE_TEXT = {
  upload: 'Uploaded picture.',
  provider: 'Picture from your GitHub or Google sign-in.',
  none: 'No picture yet.',
};

export function AvatarSettings({
  identity,
  onChange,
}: {
  identity: AccountIdentity;
  /** Saves a new picture; without it, the row only shows the account. */
  onChange?: (picture: Picture) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  async function send(method: 'PUT' | 'DELETE', file?: File) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/v1/account/avatar', {
        method,
        body: file,
        headers: file ? { 'content-type': file.type } : undefined,
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value?.error?.message ?? 'The picture was not saved.');
      onChange?.({
        avatar_url: value.avatar_url ?? null,
        avatar_source: value.avatar_source ?? null,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  const source = identity.avatar_source ?? 'none';
  return (
    <>
      <SettingsRow
        media={<Avatar name={identity.username} src={identity.avatar_url} size={44} />}
        title={identity.username}
        detail={`${SOURCE_TEXT[source]} PNG, JPEG or WebP, up to 1 MB.`}
        action={
          onChange && (
            <>
              {source === 'upload' && (
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => send('DELETE')}
                >
                  Remove
                </button>
              )}
              <label className={`avatar-upload${busy ? ' busy' : ''}`}>
                {busy ? 'Saving…' : 'Change picture'}
                <input
                  ref={input}
                  type="file"
                  accept={PICTURE_TYPES.join(',')}
                  className="sr-only"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (!file) return;
                    const problem = pictureProblem(file);
                    if (problem) {
                      setError(problem);
                      event.currentTarget.value = '';
                    } else void send('PUT', file);
                  }}
                />
              </label>
            </>
          )
        }
      />
      {error && (
        <div className="settings-block">
          <Failure error={error} />
        </div>
      )}
    </>
  );
}
