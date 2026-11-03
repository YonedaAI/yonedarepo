import { Bell, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { EmptyState } from '../../components/EmptyState';
import { linkTo, type Navigate } from '../shell/useRoute';
import { Failure, Loading } from '../source-platform/SourceStatus';
import { useNotifications } from './useNotifications';

export function Notifications({ enabled, navigate }: { enabled: boolean; navigate: Navigate }) {
  const [open, setOpen] = useState(false);
  const { inbox, loading, error, load, markRead, remove, clearAll } = useNotifications(enabled);
  const unread = inbox?.unread ?? 0;
  const content = useRef<HTMLDivElement>(null);
  async function dismiss(id?: string) {
    await (id ? remove(id) : clearAll());
    requestAnimationFrame(() => {
      const root = content.current;
      if (!root?.isConnected) return;
      const next =
        root.querySelector<HTMLElement>('button:not(:disabled)') ??
        root.closest('dialog')?.querySelector<HTMLElement>('.dialog-heading button');
      next?.focus();
    });
  }
  return (
    <>
      <button
        type="button"
        className="icon-button notification-bell"
        disabled={!enabled}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="notification-count" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && enabled && (
        <Dialog title="Notifications" onClose={() => setOpen(false)}>
          <div className="notification-content" ref={content}>
            {error ? (
              <Failure error={error} what="notifications" onRetry={() => void load()} />
            ) : !inbox ? (
              <Loading what="notifications" />
            ) : inbox.items.length === 0 ? (
              <EmptyState title="No notifications yet">
                Organization updates appear here.
              </EmptyState>
            ) : (
              <>
                <div className="notification-actions">
                  {unread > 0 && (
                    <button
                      type="button"
                      className="quiet"
                      disabled={loading}
                      onClick={() => void markRead()}
                    >
                      Mark all as read
                    </button>
                  )}
                  <button
                    type="button"
                    className="quiet"
                    disabled={loading}
                    onClick={() => void dismiss()}
                  >
                    Clear all
                  </button>
                </div>
                <ul className="notification-list">
                  {inbox.items.map((item) => (
                    <li key={item.id} className={item.unread ? 'unread' : ''}>
                      <div className="notification-message">
                        <a
                          {...linkTo({ view: 'org', org: item.org }, (route, options) => {
                            setOpen(false);
                            navigate(route, options);
                          })}
                        >
                          You joined <strong>{item.org}</strong>
                        </a>
                        <time dateTime={new Date(item.at).toISOString()}>
                          {new Date(item.at).toLocaleDateString()}
                        </time>
                      </div>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={loading}
                        aria-label={`Remove notification about ${item.org}`}
                        title="Remove notification"
                        onClick={() => void dismiss(item.id)}
                      >
                        <X size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
