// Remember only public canonical pages that this isolate actually served. A cache miss
// loses a visit ping; it must never resolve a repository just to count a visit.
const pages = new Map<string, number>();
const KEEP_MS = 5 * 60_000;
const LIMIT = 4096;
export function rememberPublicPage(path: string, origin: string, now = Date.now()) {
  if (!path.startsWith('/') || path.length > 2048) return;
  if (pages.size >= LIMIT) pages.delete(pages.keys().next().value as string);
  pages.set(`${origin}${path}`, now);
}
export function publicPageEvidence(path: string, origin: string, now = Date.now()): string | null {
  const parts = path.split('/').filter(Boolean);
  for (const candidate of [path, `/${parts.slice(0, 2).join('/')}`]) {
    const at = pages.get(`${origin}${candidate}`);
    if (at !== undefined && now - at <= KEEP_MS) return candidate;
    if (at !== undefined) pages.delete(`${origin}${candidate}`);
  }
  return null;
}
