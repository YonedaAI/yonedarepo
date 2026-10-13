import { api } from '../../lib/api';

export type PeerMessage = {
  id: string;
  seq: number;
  run_id: string;
  sender: string;
  recipient: string;
  kind: string;
  body: string;
  context_ids: string[];
  authority: string;
  delivery_receipts: { delivered: number; acknowledged: number; proves: string };
};
export type ConversationPage = {
  items: PeerMessage[];
  has_more: boolean;
  next_cursor: number;
  watermark: number;
};
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function validate(value: any, run: string, after: number, watermark?: number): ConversationPage {
  let previous = after;
  if (
    !value ||
    !Array.isArray(value.items) ||
    value.items.length > 25 ||
    !natural(value.watermark) ||
    (watermark !== undefined && value.watermark !== watermark) ||
    typeof value.has_more !== 'boolean' ||
    !natural(value.next_cursor) ||
    value.items.some((item: any) => {
      const valid =
        item &&
        typeof item.id === 'string' &&
        item.run_id === run &&
        natural(item.seq) &&
        item.seq > previous &&
        item.seq <= value.watermark &&
        typeof item.sender === 'string' &&
        typeof item.recipient === 'string' &&
        ['contract', 'question', 'finding', 'blocker'].includes(item.kind) &&
        typeof item.body === 'string' &&
        item.body.length <= 8192 &&
        item.authority === 'assertion' &&
        Array.isArray(item.context_ids) &&
        item.context_ids.length <= 20 &&
        item.context_ids.every((id: unknown) => typeof id === 'string') &&
        natural(item.delivery_receipts?.delivered) &&
        natural(item.delivery_receipts?.acknowledged) &&
        item.delivery_receipts.acknowledged <= item.delivery_receipts.delivered &&
        typeof item.delivery_receipts.proves === 'string';
      if (valid) previous = item.seq;
      return !valid;
    }) ||
    value.next_cursor !== previous ||
    (value.has_more && previous <= after)
  )
    throw new Error('This conversation page is inconsistent. Refresh before continuing.');
  return value;
}

/** No reads until load; subsequent pages retain the first ordered-message watermark. */
export function conversationPager(
  repo: string,
  run: string,
  read: (path: string) => Promise<unknown> = api,
) {
  let state: ConversationPage = { items: [], has_more: true, next_cursor: 0, watermark: 0 };
  let initialized = false;
  let pending: Promise<ConversationPage> | undefined;
  return {
    current: () => state,
    load: () => {
      if (pending) return pending;
      if (initialized && !state.has_more) return Promise.resolve(state);
      const query = new URLSearchParams({
        run_id: run,
        after: String(state.next_cursor),
        limit: '25',
      });
      if (initialized) query.set('watermark', String(state.watermark));
      pending = read(`repos/${encodeURIComponent(repo)}/peer_messages_page?${query}`)
        .then((value) => {
          const page = validate(
            value,
            run,
            state.next_cursor,
            initialized ? state.watermark : undefined,
          );
          state = { ...page, items: [...state.items, ...page.items] };
          initialized = true;
          return state;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
