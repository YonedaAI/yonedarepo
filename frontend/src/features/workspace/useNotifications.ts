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
  const load = useCallback(
    async (through?: number) => {
      if (!enabled) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError('');
      try {
        const value = await api<Inbox>(
          'auth/notifications',
          through === undefined ? undefined : { through },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setInbox(value);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (request.current === controller) request.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [enabled],
  );
  useEffect(() => {
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
    markRead: () => load(Math.max(0, ...(inbox?.items.map((item) => item.at) ?? []))),
  };
}
