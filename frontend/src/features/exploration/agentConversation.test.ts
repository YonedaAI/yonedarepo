import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../lib/types';
import { ConversationRecords } from './ConversationRecords';
import { conversationPager } from './conversationPager';

const message = {
  id: 'message',
  seq: 7,
  run_id: 'run',
  sender: 'execution-hash',
  recipient: 'task-hash',
  kind: 'contract',
  body: 'Keep calendarEvents IDs stable. I will preserve anonymous access.',
  context_ids: ['constraint'],
  authority: 'assertion',
  delivery_receipts: {
    delivered: 2,
    acknowledged: 1,
    proves: 'delivery and acknowledgement, not understanding',
  },
};
const page = { items: [message], has_more: true, next_cursor: 7, watermark: 19 };
const snapshot = {
  repository: { id: 'repo' },
  executions: [{ id: 'execution-hash', run_id: 'run', strategy: 'API maintenance' }],
  team_tasks: [{ task_id: 'task-hash', run_id: 'run', title: 'Calendar behavior' }],
  nodes: [{ id: 'constraint', label: 'Preserve access' }],
} as unknown as Snapshot;
describe('readable agent conversation', () => {
  it('shows actual contracts, named participants and receipts without claiming understanding', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationRecords, {
        items: [message],
        snapshot,
        run: { id: 'run' },
        onContext: () => {},
      }),
    );
    expect(html).toContain(message.body);
    expect(html).toContain('API maintenance');
    expect(html).toContain('Calendar behavior');
    expect(html).toContain('Preserve access');
    expect(html).toContain('Agent assertion');
    expect(html).toContain('2 deliveries');
    expect(html).toContain('1 acknowledgement');
    expect(html).toContain('do not prove understanding or agreement');
    expect(html).not.toContain('execution-hash');
    expect(html).not.toContain('task-hash');
  });
  it('does not fetch until inspected and pins load-more to the first watermark', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({
        items: [
          {
            ...message,
            id: 'next',
            seq: 12,
            kind: 'finding',
            body: 'The accented-name regression passes.',
          },
        ],
        has_more: false,
        next_cursor: 12,
        watermark: 19,
      });
    const pager = conversationPager('repo', 'run', read);
    expect(read).not.toHaveBeenCalled();
    expect((await pager.load()).items).toHaveLength(1);
    expect(read).toHaveBeenNthCalledWith(
      1,
      'repos/repo/peer_messages_page?run_id=run&after=0&limit=25',
    );
    const next = await pager.load();
    expect(read).toHaveBeenNthCalledWith(
      2,
      'repos/repo/peer_messages_page?run_id=run&after=7&limit=25&watermark=19',
    );
    expect(next.items.map((item) => item.seq)).toEqual([7, 12]);
    expect(next.has_more).toBe(false);
    await pager.load();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('rejects cross-run bodies and changed watermarks without replacing readable prior messages', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({
        ...page,
        items: [{ ...message, seq: 12, run_id: 'other-run' }],
        next_cursor: 12,
      })
      .mockResolvedValueOnce({
        ...page,
        watermark: 20,
        items: [{ ...message, seq: 12 }],
        next_cursor: 12,
      });
    const pager = conversationPager('repo', 'run', read);
    await pager.load();
    await expect(pager.load()).rejects.toThrow('conversation page');
    expect(pager.current().items).toEqual([message]);
    await expect(pager.load()).rejects.toThrow('conversation page');
    expect(pager.current().items).toEqual([message]);
  });
  it('deduplicates simultaneous load-more and escapes untrusted message bodies', async () => {
    let finish: (value: unknown) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pager = conversationPager('repo', 'run', read);
    const first = pager.load();
    const second = pager.load();
    expect(read).toHaveBeenCalledTimes(1);
    finish({ ...page, items: [{ ...message, body: '<script>invented()</script>' }] });
    await Promise.all([first, second]);
    const html = renderToStaticMarkup(
      createElement(ConversationRecords, {
        items: pager.current().items,
        snapshot,
        run: { id: 'run' },
        onContext: () => {},
      }),
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
