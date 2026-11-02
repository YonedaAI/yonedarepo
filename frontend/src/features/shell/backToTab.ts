// Noticing the person came back to this tab from one they opened: what they did there can't tell
// this page anything, so the page asks again. A new tab returns through `visibilitychange`, a
// separate window through `focus`, and a return can fire both.
import { useCallback, useEffect, useRef } from 'react';

/** Two events within this are one return. */
const ONE_RETURN_MS = 1000;

/** Calls `onBack` on each return to a visible page, until the answer is called. */
export function watchReturn(
  target: EventTarget,
  visible: () => boolean,
  onBack: () => void,
  now: () => number = Date.now,
) {
  let last = Number.NEGATIVE_INFINITY;
  const seen = () => {
    if (!visible() || now() - last < ONE_RETURN_MS) return;
    last = now();
    onBack();
  };
  target.addEventListener('focus', seen);
  target.addEventListener('visibilitychange', seen);
  return () => {
    target.removeEventListener('focus', seen);
    target.removeEventListener('visibilitychange', seen);
  };
}

/** `onBack` on every return once the answer has been called: the person may look back here and
 * go on working on the other tab. */
export function useBackToTab(onBack: () => void) {
  const armed = useRef(false);
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(
    () =>
      // `visibilitychange` bubbles from the document, so the window hears both.
      watchReturn(
        window,
        () => document.visibilityState === 'visible',
        () => {
          if (armed.current) latest.current();
        },
      ),
    [],
  );
  return useCallback(() => {
    armed.current = true;
  }, []);
}
