// Who a request looks like, from its headers alone (Traffic page; nothing here is stored beyond
// the class). A user agent is self-reported, so this sorts requests and proves nothing: only the
// ping (site-ping.ts) confirms a browser, and only a token the platform accepted proves a client.

/** What a page request looks like; `human` is only ever set by a ping. */
export type SiteClass = 'human' | 'agent' | 'crawler' | 'bot' | 'unconfirmed';

/** AI agents reading the site, for themselves or on someone's behalf, as they name themselves. */
export const AI_AGENTS = [
  'ClaudeBot',
  'Claude-User',
  'Claude-Web',
  'Claude-SearchBot',
  'anthropic-ai',
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'PerplexityBot',
  'Perplexity-User',
  'MistralAI-User',
  'DuckAssistBot',
  'meta-externalagent',
  'cohere-ai',
];
/** Search engines and link previews: wanted, but neither people nor agents. */
export const CRAWLERS = [
  'Googlebot',
  'bingbot',
  'DuckDuckBot',
  'YandexBot',
  'Baiduspider',
  'Applebot',
  'AhrefsBot',
  'SemrushBot',
  'facebookexternalhit',
  'Twitterbot',
  'LinkedInBot',
  'Slackbot',
  'Discordbot',
];
const BOT_AGENT =
  /bot|crawl|spider|slurp|scrape|curl|wget|python|httpclient|go-http|java\/|okhttp|headless|lighthouse|preview|embedly|monitor/i;
const CHROMIUM = /Chrome\/|Chromium\/|Edg\//;

const named = (agent: string, names: string[]) => names.some((n) => agent.includes(n));
const lowered = (names: string[]) => names.map((n) => n.toLowerCase());
const AGENT_NAMES = lowered(AI_AGENTS);
const CRAWLER_NAMES = lowered(CRAWLERS);

/** The class a user agent claims; null for one that claims to be a browser. */
export function userAgentClass(agent: string): 'agent' | 'crawler' | 'bot' | null {
  const lower = agent.toLowerCase();
  if (named(lower, AGENT_NAMES)) return 'agent';
  if (named(lower, CRAWLER_NAMES)) return 'crawler';
  return !agent || BOT_AGENT.test(agent) ? 'bot' : null;
}

const agentOf = (req: Request) => req.headers.get('user-agent') ?? '';
// Chromium sends client hints on every HTTPS request; Firefox and Safari send none.
const hintsMatch = (req: Request, agent: string) =>
  !CHROMIUM.test(agent) || req.headers.has('sec-ch-ua');

/** A page request's class: a browser that navigated stays `unconfirmed` until a ping. */
export function pageClass(req: Request): SiteClass {
  const agent = agentOf(req);
  const claimed = userAgentClass(agent);
  if (claimed) return claimed;
  const navigated = req.headers.get('sec-fetch-mode') === 'navigate';
  return navigated && hintsMatch(req, agent) ? 'unconfirmed' : 'bot';
}

/** Whether a ping's headers fit a browser. A script can forge them, and a scripted browser sends
 * them for real: this keeps out the honest automation that runs JavaScript. */
export function sentByBrowser(req: Request) {
  const agent = agentOf(req);
  return userAgentClass(agent) === null && hintsMatch(req, agent);
}
