// A person's picture: their own (an upload, or their GitHub / Google picture) from the
// platform, or the first letter of their name while it loads and when there is none. Only
// a public account name has a picture URL: an email-named account's would carry the address.
import { useState } from 'react';
import { isCanonicalAccountIdentifier } from '../../../../shared/account';

/** The picture URL of an account name, or null when it has none to show. */
export function accountAvatar(name: string): string | null {
  if (!name || name.includes('@') || !isCanonicalAccountIdentifier(name)) return null;
  return `/api/v1/avatars/${name}`;
}

/** The picture URL of a principal: a person (`user:<name>`) only, never a token or agent. */
export const avatarOf = (principal: string) =>
  principal.startsWith('user:') ? accountAvatar(principal.slice(5)) : null;

/** The letter shown in place of a picture. */
export const initialOf = (name: string) =>
  (name.replace(/[^a-z0-9]/gi, '')[0] ?? '?').toUpperCase();

export function Avatar({
  name,
  src,
  size = 20,
  className = '',
}: {
  name: string;
  src: string | null | undefined;
  size?: number;
  className?: string;
}) {
  // The URL that failed to load (a new URL tries again).
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      className={`avatar ${className}`.trim()}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {initialOf(name)}
      {src && src !== failed && (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          // A provider's picture is a redirect to GitHub or Google: send them no page URL.
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
        />
      )}
    </span>
  );
}
