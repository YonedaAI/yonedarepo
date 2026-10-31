// The page's one ping: the path and the referring site's name, sent once, and silent on failure.
import { describe, expect, it, vi } from 'vitest';
import { sendPagePing } from './pagePing';

const location = { pathname: '/pricing', search: '?email=a@b.co', hash: '#x' };

async function bodyOf(data: unknown) {
  return JSON.parse(await (data as Blob).text());
}

describe('page ping', () => {
  it('sends the path and the referring host, not the query or the full address', async () => {
    const sendBeacon = vi.fn((_url: string, _data: Blob) => true);
    sendPagePing({ location, referrer: 'https://news.ycombinator.com/item?id=1', sendBeacon });
    expect(sendBeacon).toHaveBeenCalledOnce();
    const [url, data] = sendBeacon.mock.calls[0];
    expect(url).toBe('/api/e');
    expect(data.type).toBe('application/json');
    expect(await bodyOf(data)).toEqual({ path: '/pricing', referrer: 'news.ycombinator.com' });
  });

  it('sends an empty referrer for a direct visit or an unreadable one', async () => {
    for (const referrer of ['', 'not a url']) {
      const sendBeacon = vi.fn((_url: string, _data: Blob) => true);
      sendPagePing({ location, referrer, sendBeacon });
      expect(await bodyOf(sendBeacon.mock.calls[0][1])).toEqual({ path: '/pricing', referrer: '' });
    }
  });

  it('fails silently', () => {
    const sendBeacon = () => {
      throw new Error('blocked');
    };
    expect(() => sendPagePing({ location, referrer: '', sendBeacon })).not.toThrow();
  });
});
