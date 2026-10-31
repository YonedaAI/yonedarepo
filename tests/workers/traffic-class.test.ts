// Who a request looks like, from its headers: named AI agents, search and preview crawlers, other
// automation, and a browser's navigation headers. A user agent is self-reported: this sorts, it
// proves nothing, and only the ping (site-ping.ts) confirms a browser.
import { describe, expect, it } from 'vitest';
import {
  AI_AGENTS,
  CRAWLERS,
  pageClass,
  sentByBrowser,
  userAgentClass,
} from '../../cloudflare/worker/traffic-class';

const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0';
const request = (headers: Record<string, string>) => new Request('https://x.test/', { headers });

describe('the user agent tables', () => {
  it.each([
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0',
    'Claude-Web/1.0',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Perplexity-User/1.0',
  ])('names an AI agent: %s', (agent) => {
    expect(userAgentClass(agent)).toBe('agent');
  });

  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
    'facebookexternalhit/1.1',
  ])('keeps a search or preview crawler out of the agents: %s', (agent) => {
    expect(userAgentClass(agent)).toBe('crawler');
  });

  it('holds each name once, and no name in both tables', () => {
    const all = [...AI_AGENTS, ...CRAWLERS].map((name) => name.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
  });

  it.each(['', 'curl/8.7.1', 'python-requests/2.32', 'Go-http-client/2.0', 'HeadlessChrome/141'])(
    'calls other automation a bot: %j',
    (agent) => {
      expect(userAgentClass(agent)).toBe('bot');
    },
  );

  it('says nothing about a browser', () => {
    for (const agent of [SAFARI, CHROME, FIREFOX]) expect(userAgentClass(agent)).toBe(null);
  });
});

describe('a page request by its headers', () => {
  it('leaves a browser that navigated unconfirmed: only the ping confirms it', () => {
    const navigate = { 'sec-fetch-mode': 'navigate' };
    expect(pageClass(request({ 'user-agent': SAFARI, ...navigate }))).toBe('unconfirmed');
    expect(pageClass(request({ 'user-agent': FIREFOX, ...navigate }))).toBe('unconfirmed');
    expect(
      pageClass(request({ 'user-agent': CHROME, 'sec-ch-ua': '"Chromium";v="141"', ...navigate })),
    ).toBe('unconfirmed');
  });

  it('marks a browser user agent without the headers a browser sends as a bot', () => {
    expect(pageClass(request({ 'user-agent': SAFARI }))).toBe('bot');
    expect(pageClass(request({ 'user-agent': SAFARI, 'sec-fetch-mode': 'cors' }))).toBe('bot');
    // Chromium sends client hints on every HTTPS navigation; other engines do not.
    expect(pageClass(request({ 'user-agent': CHROME, 'sec-fetch-mode': 'navigate' }))).toBe('bot');
  });

  it('lets the named tables win over the headers', () => {
    const navigate = { 'sec-fetch-mode': 'navigate' };
    expect(pageClass(request({ 'user-agent': 'ChatGPT-User/1.0', ...navigate }))).toBe('agent');
    expect(pageClass(request({ 'user-agent': 'Googlebot/2.1', ...navigate }))).toBe('crawler');
  });
});

describe('a ping by its headers', () => {
  it('accepts only what claims to be a browser, and says so consistently', () => {
    expect(sentByBrowser(request({ 'user-agent': SAFARI }))).toBe(true);
    expect(sentByBrowser(request({ 'user-agent': CHROME, 'sec-ch-ua': '"Chromium";v="141"' }))).toBe(true);
    expect(sentByBrowser(request({ 'user-agent': CHROME }))).toBe(false);
    expect(sentByBrowser(request({ 'user-agent': 'Claude-User/1.0' }))).toBe(false);
    expect(sentByBrowser(request({ 'user-agent': 'Googlebot/2.1' }))).toBe(false);
    expect(sentByBrowser(request({}))).toBe(false);
  });
});
