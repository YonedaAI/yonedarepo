// The "Public" badge beside a repository's name: anyone, signed in or not, can read it.
// Private is the default and carries no badge.
import { Globe } from 'lucide-react';

export const PUBLIC_TITLE = 'Public: anyone can read this repository; only members change it';

export function PublicBadge() {
  return (
    <span className="visibility-badge" title={PUBLIC_TITLE}>
      <Globe size={12} aria-hidden="true" />
      Public
    </span>
  );
}
