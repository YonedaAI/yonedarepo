// A set-up agent's ⋮ menu (Pause or Resume, Run now, Configure, Create your own, Archive): a
// menu button with arrow-key movement; Escape or a click elsewhere closes it and returns focus.
import { MoreVertical } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { MenuAction, MenuItem } from './agentsModel';

export function AgentMenu({
  label,
  items,
  onPick,
  busy = false,
  align = 'start',
}: {
  label: string;
  items: MenuItem[];
  onPick: (action: MenuAction) => void;
  busy?: boolean;
  /** Which edge of the button the open menu lines up with (so it stays on screen). */
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const move = (e: React.KeyboardEvent) => {
    const entries = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ??
        []),
    ];
    const at = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      entries[(at + step + entries.length) % entries.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? entries[0] : entries.at(-1))?.focus();
    }
  };
  return (
    <div className="agent-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={busy}
        onClick={() => setOpen(!open)}
      >
        <MoreVertical size={16} aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          className={`agent-menu-list align-${align}`}
          onKeyDown={move}
        >
          {items.map((item) => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.hint}
              className={item.danger ? 'danger-text' : undefined}
              onClick={() => {
                setOpen(false);
                onPick(item.action);
              }}
            >
              {item.label}
              {item.disabled && item.hint && <span className="source-meta"> · {item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
