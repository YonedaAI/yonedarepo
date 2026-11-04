import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
export type Inbox = {
  items: { id: string; org: string; role: string; at: number; unread: boolean }[];
  unread: number;
};

export function useNotifications(enabled: boolean) {
  const [inbox, setInbox] = useState<Inbox>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const scope = useRef(0);
  const active = useRef(false);
  const write = useRef<{ controller: AbortController; done: Promise<void> } | null>(null);
  const refreshRequested = useRef(false);
  const reload = useRef<(() => Promise<void>) | null>(null);
  const load = useCallback(
    async (through?: number, dismissal?: string): Promise<void> => {
      if (!enabled) return;
      const generation = scope.current;
      const mutation = through !== undefined || dismissal !== undefined;
      while (write.current) {
        if (!mutation) {
          refreshRequested.current = true;
          return;
        }
        await write.current.done;
        if (!active.current || scope.current !== generation) return;
      }
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      let settled: (() => void) | undefined;
      if (mutation) {
        const done = new Promise<void>((resolve) => {
          settled = resolve;
        });
        write.current = { controller, done };
      }
      setLoading(true);
      setError('');
      try {
        const value = await api<Inbox>(
          `auth/notifications${dismissal ? `/${encodeURIComponent(dismissal)}` : ''}`,
          through === undefined ? undefined : { through },
          { signal: controller.signal, method: dismissal === undefined ? undefined : 'DELETE' },
        );
        if (!controller.signal.aborted && scope.current === generation) setInbox(value);
      } catch (e) {
        if (!controller.signal.aborted && scope.current === generation)
          setError((e as Error).message);
      } finally {
        if (request.current === controller) request.current = null;
        if (!controller.signal.aborted && scope.current === generation) setLoading(false);
        if (write.current?.controller === controller) {
          write.current = null;
          settled?.();
          const refresh = refreshRequested.current || controller.signal.aborted;
          refreshRequested.current = false;
          if (refresh && active.current) void reload.current?.();
        }
      }
    },
    [enabled],
  );
  reload.current = enabled ? () => load() : null;
  useEffect(() => {
    active.current = enabled;
    if (!enabled) {
      setInbox(undefined);
      return;
    }
    let stopped = false;
    const startupUntil = Date.now() + 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: number | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      idle = undefined;
      if (stopped || document.visibilityState === 'hidden' || request.current) return;
      // Give core reads a bounded startup grace; a stuck section cannot starve the inbox.
      if (
        Date.now() < startupUntil &&
        document.querySelector(
          '#workspace .source-empty[aria-busy="true"], #workspace .latest-commit[aria-busy="true"]',
        )
      ) {
        timer = setTimeout(schedule, 500);
        return;
      }
      if (window.requestIdleCallback)
        idle = window.requestIdleCallback(
          () => {
            idle = undefined;
            if (!stopped && document.visibilityState !== 'hidden') void load();
          },
          { timeout: 5000 },
        );
      else void load();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    timer = setTimeout(schedule, 1000);
    const poll = setInterval(schedule, 60_000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      active.current = false;
      scope.current++;
      clearTimeout(timer);
      clearInterval(poll);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      document.removeEventListener('visibilitychange', visible);
      request.current?.abort();
    };
  }, [enabled, load]);
  return {
    inbox: enabled ? inbox : undefined,
    loading,
    error: enabled ? error : '',
    load,
    remove: (id: string) => load(undefined, id),
    clearAll: () => load(undefined, ''),
    markRead: () => load(Math.max(0, ...(inbox?.items.map((item) => item.at) ?? []))),
  };
}
