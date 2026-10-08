import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';

export function Dialog({
  title,
  children,
  onClose,
  locked = false,
  wide = false,
  initialFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  locked?: boolean;
  wide?: boolean;
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement;
    dialog?.showModal();
    if (initialFocus) dialog?.querySelector<HTMLElement>(initialFocus)?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog?.close();
      document.body.style.overflow = previous;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [initialFocus]);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog-wide' : ''}`}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
    >
      <header className="dialog-heading">
        <h2 id={heading}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          disabled={locked}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}
