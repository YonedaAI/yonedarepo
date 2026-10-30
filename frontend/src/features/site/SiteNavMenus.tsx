// The header's sections in order: Features and Company open menus, the rest are links. A menu
// opens on hover (with a mouse, at desktop width), on click, and from the keyboard; Escape,
// a click outside, leaving it with Tab or following a link closes it. At phone width the
// menus are groups inside the folded menu.
import { ArrowRight, ChevronDown } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { linkTo, type Navigate } from '../shell/useRoute';
import { BUILD_ON } from './buildOn';
import { logMock } from './buildOnMocks';
import { featurePageFor } from './featurePages';
import { EVENTS_URL, siteLink } from './siteLinks';
import { SITE_NAV } from './siteRoute';

export type MenuId = 'features' | 'company';
const MENUS: Record<string, MenuId> = { Features: 'features', Company: 'company' };

/** What a key on a menu's button does: which menu is open after it, and where focus goes. */
export function menuKey(
  open: MenuId | null,
  menu: MenuId,
  key: string,
): { open: MenuId | null; focus: 'first' | 'button' | null } {
  if (key === 'Escape') return { open: null, focus: open === menu ? 'button' : null };
  if (key === 'ArrowDown') return { open: menu, focus: 'first' };
  if (key === 'Enter' || key === ' ')
    return open === menu ? { open: null, focus: null } : { open: menu, focus: 'first' };
  return { open, focus: null };
}

function FeaturesPanel({ go }: { go: Navigate }) {
  const [lead] = BUILD_ON;
  return (
    <div className="site-menu-features">
      <div>
        <p className="site-menu-title">Features</p>
        <ul className="site-menu-list">
          {BUILD_ON.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.id}>
                <a className="site-menu-item" {...siteLink(featurePageFor(item.id), go)}>
                  <span className="site-menu-icon" aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.subtitle}</small>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
        <a className="site-menu-all" {...siteLink({ page: 'features' }, go)}>
          All features <ArrowRight size={14} aria-hidden="true" />
        </a>
      </div>
      <div className="site-menu-featured">
        <p className="site-menu-title">Featured</p>
        <a className="site-menu-card" {...siteLink(featurePageFor(lead.id), go)}>
          <span className="site-menu-card-visual">{logMock}</span>
          <strong>{lead.title}</strong>
          <small>{lead.subtitle}</small>
          <span className="site-menu-read">
            Read <ArrowRight size={14} aria-hidden="true" />
          </span>
        </a>
      </div>
    </div>
  );
}

function CompanyPanel({ go }: { go: Navigate }) {
  return (
    <ul className="site-menu-list site-menu-small">
      <li>
        <a className="site-menu-item" {...siteLink({ page: 'vision' }, go)}>
          Vision
        </a>
      </li>
      <li>
        <a className="site-menu-item" {...siteLink({ page: 'about' }, go)}>
          About
        </a>
      </li>
      <li>
        <a className="site-menu-item" href={EVENTS_URL} target="_blank" rel="noopener noreferrer">
          Events
        </a>
      </li>
      <li>
        <a className="site-menu-item" {...linkTo({ view: 'explore' }, go)}>
          Explore public repositories
        </a>
      </li>
    </ul>
  );
}

function Menu({
  id,
  label,
  current,
  open,
  setOpen,
  children,
}: {
  id: MenuId;
  label: string;
  current: boolean;
  open: MenuId | null;
  setOpen: (menu: MenuId | null) => void;
  children: ReactNode;
}) {
  const item = useRef<HTMLLIElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const isOpen = open === id;
  // A menu the pointer opened stays open when its button is then clicked.
  const byHover = useRef(false);
  const hoverable = () => window.matchMedia('(hover: hover) and (min-width: 801px)').matches;
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' && event.target !== button.current) return;
    const next = menuKey(open, id, event.key);
    if (next.open === open && !next.focus) return;
    event.preventDefault();
    setOpen(next.open);
    if (next.focus === 'button') button.current?.focus();
    if (next.focus === 'first')
      requestAnimationFrame(() =>
        item.current?.querySelector<HTMLAnchorElement>(`#site-menu-${id} a`)?.focus(),
      );
  };
  return (
    <li
      ref={item}
      className={`site-menu site-nav-menu-${id}${isOpen ? ' open' : ''}`}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse' || !hoverable() || isOpen) return;
        byHover.current = true;
        setOpen(id);
      }}
      onPointerLeave={(e) => e.pointerType === 'mouse' && hoverable() && isOpen && setOpen(null)}
      onKeyDown={onKey}
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (!isOpen || item.current?.contains(to)) return;
        // In the phone menu the groups stack, so closing this one would move the button being
        // pressed out from under the pointer: another group's button opens itself instead.
        const stacked = !window.matchMedia('(min-width: 801px)').matches;
        if (stacked && item.current?.parentElement?.contains(to)) return;
        setOpen(null);
      }}
    >
      <button
        ref={button}
        type="button"
        className={`site-nav-link site-menu-button-trigger${current ? ' current' : ''}`}
        aria-expanded={isOpen}
        aria-controls={`site-menu-${id}`}
        onClick={(e) => {
          // A keyboard press is handled in onKeyDown (detail 0); this is the mouse or touch.
          if (e.detail === 0) return;
          if (isOpen && byHover.current) byHover.current = false;
          else setOpen(isOpen ? null : id);
        }}
      >
        {label}
        <ChevronDown className="site-menu-chevron" size={14} aria-hidden="true" />
      </button>
      <div
        id={`site-menu-${id}`}
        className={`site-menu-panel site-menu-panel-${id}`}
        hidden={!isOpen}
      >
        {children}
      </div>
    </li>
  );
}

/** The header's list of sections. `go` navigates (and closes the phone menu). */
export function SiteNavMenus({ current, go }: { current: string | undefined; go: Navigate }) {
  const [open, setOpen] = useState<MenuId | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!list.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  // Following any link in a menu closes it.
  const follow: Navigate = (next, options) => {
    setOpen(null);
    go(next, options);
  };
  return (
    <ul ref={list} className="site-nav-list">
      {SITE_NAV.map((section) => {
        const menu = MENUS[section.label];
        if (!menu)
          return (
            <li key={section.label}>
              <a
                className="site-nav-link"
                {...siteLink(section.page, follow)}
                aria-current={current === section.label ? 'page' : undefined}
              >
                {section.label}
              </a>
            </li>
          );
        return (
          <Menu
            key={section.label}
            id={menu}
            label={section.label}
            current={current === section.label}
            open={open}
            setOpen={setOpen}
          >
            {menu === 'features' ? <FeaturesPanel go={follow} /> : <CompanyPanel go={follow} />}
          </Menu>
        );
      })}
    </ul>
  );
}
