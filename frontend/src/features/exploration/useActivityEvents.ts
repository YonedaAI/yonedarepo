import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { ActivityEvent } from './activityView';

/** Read every ledger page in order. A failed page never advances the cursor. */
export function useActivityEvents(repo: string) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    let after = 0;
    let busy = false;
    setEvents([]);
    setError('');
    setLoading(true);
    async function poll() {
      if (busy) return;
      busy = true;
      try {
        while (current) {
          const result = await api<{ events: ActivityEvent[] }>(
            `repos/${repo}/events?after=${after}`,
          );
          if (!current) return;
          const page = result.events.filter((event) => event.seq > after);
          if (!page.length) break;
          setEvents((previous) => [...previous, ...page]);
          after = Math.max(...page.map((event) => event.seq));
          if (result.events.length < 200) break;
        }
        if (current) setError('');
      } catch (error) {
        if (current) setError((error as Error).message);
      } finally {
        busy = false;
        if (current) setLoading(false);
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [repo]);
  return { events, error, loading };
}
