// The account menu at the top right: the person's picture and name, then Account,
// Organizations, Appearance (the theme picker, as a submenu), Support, Documentation and
// About (new tabs), and Log out.
import {
  ArrowUpRight,
  BookOpen,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Info,
  LifeBuoy,
  LogOut,
  Palette,
  UserRound,
} from 'lucide-react';
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { AccountIdentity } from '../../lib/types';
import { Avatar } from '../shell/Avatar';
import { ThemePicker } from '../shell/ThemePicker';
import type { Navigate } from '../shell/useRoute';

/** The menu's links outside the app; `external` ones open in a new tab. There is no
 * product changelog page yet, so the menu has no Changelog item. */
export const MENU_LINKS = [
  { label: 'Support', href: 'mailto:hello@yonedarepo.com', external: false, Icon: LifeBuoy },
  { label: 'Documentation', href: '/docs', external: true, Icon: BookOpen },
  { label: 'About', href: '/company/about', external: true, Icon: Info },
] as const;

/** The settings sections the menu opens (ids on Account settings' sections). */
const SECTIONS = [
  { id: 'account', label: 'Account', Icon: UserRound },
  { id: 'organizations', label: 'Organizations', Icon: Building2 },
] as const;

export function AccountMenu({
  identity,
  progress,
  navigate,
  onSignOut,
  onError,
}: {
  identity: AccountIdentity | null;
  /** Getting started, shown here where the top bar is too narrow for it. */
  progress?: ReactNode;
  /** Account settings; absent where the shell has none. */
  navigate?: Navigate;
  onSignOut: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // Focus follows the submenu in and out (not on the first render).
    if (first.current) {
      first.current = false;
      return;
    }
    (appearance ? back : opener).current?.focus();
  }, [appearance]);
  const close = () => {
    if (menu.current) menu.current.open = false;
  };
  const openSection = (id: string) => (event: MouseEvent) => {
    if (!navigate || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    close();
    navigate({ view: 'settings' });
    window.history.replaceState(null, '', `/settings#${id}`);
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 0);
  };
  const label = identity?.username ?? 'Signed in';
  const description = 'Personal account';
  return (
    <details
      ref={menu}
      className="account-menu"
      onToggle={() => setAppearance(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        if (appearance) return setAppearance(false);
        event.currentTarget.open = false;
        event.currentTarget.querySelector('summary')?.focus();
      }}
    >
      <summary aria-label={`Account: ${label}`} title={`Signed in as ${label}`}>
        <Avatar name={label} src={identity?.avatar_url} size={32} className="account-avatar" />
        <span className="account-label">
          <strong>{label}</strong>
          <small>{description}</small>
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <div className="account-dropdown">
        {appearance ? (
          <div className="account-submenu">
            <button
              ref={back}
              type="button"
              className="account-item"
              onClick={() => setAppearance(false)}
            >
              <ChevronLeft size={15} aria-hidden="true" />
              Appearance
            </button>
            <ThemePicker />
          </div>
        ) : (
          <>
            <div className="account-head">
              <Avatar name={label} src={identity?.avatar_url} size={36} />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </div>
            {navigate &&
              SECTIONS.map(({ id, label: item, Icon }) => (
                <a
                  key={id}
                  href={`/settings#${id}`}
                  className="account-item"
                  onClick={openSection(id)}
                >
                  <Icon size={15} aria-hidden="true" />
                  {item}
                </a>
              ))}
            <button
              ref={opener}
              type="button"
              className="account-item"
              aria-haspopup="true"
              aria-expanded={false}
              onClick={() => setAppearance(true)}
            >
              <Palette size={15} aria-hidden="true" />
              Appearance
              <ChevronRight size={14} className="account-item-end" aria-hidden="true" />
            </button>
            <hr />
            {MENU_LINKS.map(({ label: item, href, external, Icon }) =>
              external ? (
                <a key={item} href={href} target="_blank" rel="noopener" className="account-item">
                  <Icon size={15} aria-hidden="true" />
                  {item}
                  <ArrowUpRight size={14} className="account-item-end" aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : (
                <a key={item} href={href} className="account-item">
                  <Icon size={15} aria-hidden="true" />
                  {item}
                </a>
              ),
            )}
            {progress && <div className="menu-progress">{progress}</div>}
            <hr />
            <button
              type="button"
              className="account-item"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onSignOut();
                } catch (error) {
                  onError((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <LogOut size={15} aria-hidden="true" />
              {busy ? 'Logging out…' : 'Log out'}
            </button>
          </>
        )}
      </div>
    </details>
  );
}
