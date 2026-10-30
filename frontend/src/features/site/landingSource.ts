// Where this tab's visitor first landed from (the referring site's host and the link's
// campaign tags), kept in sessionStorage, never a cookie, and sent only with a sign-up so the
// Worker can count sign-ups by source (cloudflare/worker/site-events.ts, privacy policy
// "Site analytics"). The Worker validates it again; this only collects it.

export type LandingSource = Partial<
  Record<'ref' | 'utm_source' | 'utm_medium' | 'utm_campaign', string>
>;

const KEY = 'yoneda.landing';
const TAGS = ['utm_source', 'utm_medium', 'utm_campaign'] as const;

/** Records the first page of the tab; later pages never overwrite it. */
export function rememberLanding(storage: Storage | null, href: string, referrer: string) {
  try {
    if (!storage || storage.getItem(KEY) !== null) return;
    const page = new URL(href);
    const source: LandingSource = {};
    const ref = hostOf(referrer);
    if (ref && ref !== page.hostname) source.ref = ref;
    for (const tag of TAGS) {
      const value = page.searchParams.get(tag)?.trim().slice(0, 64);
      if (value) source[tag] = value;
    }
    storage.setItem(KEY, JSON.stringify(source));
  } catch {
    // Storage can be unavailable or full; sign-up works the same without a source.
  }
}

/** The recorded source, or nothing. */
export function landingSource(storage: Storage | null): LandingSource {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const source: LandingSource = {};
    for (const key of ['ref', ...TAGS] as const) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) source[key] = value;
    }
    return source;
  } catch {
    return {};
  }
}

/** This tab's sessionStorage, when the browser allows it. */
export function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
