// Account settings → the account's picture: the one shown now (an upload, the GitHub or
// Google picture from the last sign-in, or the initial), an upload (PNG, JPEG or WebP up to
// 1 MB; the platform checks the bytes too) and removing an upload.
import { useRef, useState } from 'react';
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
  upload: 'Your uploaded picture.',
  provider: 'Your GitHub or Google picture, refreshed each time you sign in with it.',
  none: 'No picture yet: your initial is shown.',
};

export function AvatarSettings({
  identity,
  onChange,
}: {
  identity: AccountIdentity;
  onChange: (picture: Picture) => void;
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
      onChange({
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
    <div className="avatar-settings">
      <Avatar
        name={identity.username}
        src={identity.avatar_url}
        size={64}
        className="avatar-large"
      />
      <div>
        <p className="source-meta">{SOURCE_TEXT[source]} PNG, JPEG or WebP, up to 1 MB.</p>
        <div className="avatar-actions">
          <label className={`avatar-upload${busy ? ' busy' : ''}`}>
            {busy ? 'Saving…' : 'Upload picture'}
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
          {source === 'upload' && (
            <button type="button" className="quiet" disabled={busy} onClick={() => send('DELETE')}>
              Remove
            </button>
          )}
        </div>
        {error && <Failure error={error} />}
      </div>
    </div>
  );
}
