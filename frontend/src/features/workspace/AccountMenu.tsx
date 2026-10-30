// The account menu at the top right: the person's picture and name, then Account,
// Organizations, Billing, Connect agents (the CLI and MCP panel), Appearance (the theme picker, as a submenu), Support (the contact
// form, a dialog beside the menu: a closed menu hides what is inside it), Documentation and About (new tabs), and Log out.
import {
  ArrowUpRight,
  BookOpen,
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Info,
  LifeBuoy,
  LogOut,
  Palette,
  PlugZap,
  UserRound,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { AccountIdentity } from '../../lib/types';
import type { AccountSection } from '../account-settings/settingsRoute';
import { Avatar } from '../shell/Avatar';
import { ThemePicker } from '../shell/ThemePicker';
import { linkTo, type Navigate } from '../shell/useRoute';
import { SupportDialog } from './SupportDialog';

/** The menu's links outside the app, opened in a new tab. There is no product changelog page
 * yet, so the menu has no Changelog item. */
export const MENU_LINKS = [
  { label: 'Documentation', href: '/docs', Icon: BookOpen },
  { label: 'About', href: '/company/about', Icon: Info },
] as const;

/** The settings pages the menu opens. */
const SECTIONS: { section: AccountSection; label: string; Icon: typeof UserRound }[] = [
  { section: 'general', label: 'Account', Icon: UserRound },
  { section: 'organizations', label: 'Organizations', Icon: Building2 },
  { section: 'billing', label: 'Billing', Icon: CreditCard },
];

export function AccountMenu({
  identity,
  progress,
  navigate,
  onConnect,
  onSignOut,
  onError,
}: {
  identity: AccountIdentity | null;
  /** Getting started, shown here where the top bar is too narrow for it. */
  progress?: ReactNode;
  /** Account settings; absent where the shell has none. */
  navigate?: Navigate;
  /** Opens the CLI and MCP panel (the only way to it once Getting started is done). */
  onConnect?: () => void;
  onSignOut: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [support, setSupport] = useState(false);
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
  const label = identity?.username ?? 'Signed in';
  const description = 'Personal account';
  const openSupport = () => {
    // The dialog gives focus back to what held it, which must not be inside the closed menu.
    close();
    menu.current?.querySelector('summary')?.focus();
    setSupport(true);
  };
  return (
    <>
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
                SECTIONS.map(({ section, label: item, Icon }) => {
                  const { href, onClick } = linkTo({ view: 'settings', section }, navigate);
                  return (
                    <a
                      key={section}
                      href={href}
                      className="account-item"
                      onClick={(event) => {
                        onClick(event);
                        if (event.defaultPrevented) close();
                      }}
                    >
                      <Icon size={15} aria-hidden="true" />
                      {item}
                    </a>
                  );
                })}
              {onConnect && (
                <button
                  type="button"
                  className="account-item"
                  onClick={() => {
                    close();
                    onConnect();
                  }}
                >
                  <PlugZap size={15} aria-hidden="true" />
                  Connect agents (CLI, MCP)
                </button>
              )}
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
              <button
                type="button"
                className="account-item"
                aria-haspopup="dialog"
                onClick={openSupport}
              >
                <LifeBuoy size={15} aria-hidden="true" />
                Support
              </button>
              {MENU_LINKS.map(({ label: item, href, Icon }) => (
                <a key={item} href={href} target="_blank" rel="noopener" className="account-item">
                  <Icon size={15} aria-hidden="true" />
                  {item}
                  <ArrowUpRight size={14} className="account-item-end" aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ))}
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
      {support && <SupportDialog onClose={() => setSupport(false)} />}
    </>
  );
}
