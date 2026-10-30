// A person's picture: their own (an upload, or their GitHub / Google picture) from the
// platform, or the first letter of their name while it loads and when there is none. Pictures
// are addressed by handle; an account address never is one, so it never reaches a URL.
import { type CSSProperties, useState } from 'react';
import { normalizeHandle } from '../../../../shared/account';

/** The picture URL of a handle (an account's public name), or null: an address is no handle. */
export function accountAvatar(name: string): string | null {
  return name && normalizeHandle(name) === name ? `/api/v1/avatars/${name}` : null;
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
      // A size a page's own class can still override (the profile's is smaller on a phone).
      style={{ '--avatar-size': `${size}px` } as CSSProperties}
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
