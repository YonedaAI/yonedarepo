// The line of good news or bad above a page, and how long it stays.
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

/** How long a notice stays before it clears itself. */
const NOTICE_MS = 6000;

/** Good news goes by itself, so "Repository deleted." never outlasts the moment; `sticky`, a
 * refused sign-in, stays until it is read. */
export function useNotice(initial: string, sticky: string) {
  const [notice, setNotice] = useState(initial);
  useEffect(() => {
    if (!notice || notice === sticky) return;
    const timer = setTimeout(() => setNotice(''), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice, sticky]);
  return [notice, setNotice] as const;
}

export function Notice({ notice, onDismiss }: { notice: string; onDismiss: () => void }) {
  if (!notice) return null;
  return (
    <div role="status" className="workspace-notice">
      <span>{notice}</span>
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <X size={17} />
      </button>
    </div>
  );
}
