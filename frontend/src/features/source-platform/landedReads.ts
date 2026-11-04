// Reads of main now are answered from a published copy that can predate a landing by a moment,
// so a file just landed could read as missing. The platform lets a reader name the version it
// needs (`min_version`) and waits for it, so the browser names the newest landing it knows of
// on those reads. Other reads go to the repository's authority and need nothing. Kept per
// repository for the life of the page.
const REPO = 'r[0-9a-f]{20}';
const LAND = new RegExp(`^/repos/(${REPO})/land(?:\\?|$)`);
const CHANGE = new RegExp(`^/repos/(${REPO})/changes/\\d+(?:\\?|$)`);
const PUBLISHED_READ = new RegExp(`^/repos/(${REPO})/(?:tree|blob|refs)(?:\\?|$)`);
const OVERVIEW_READ = new RegExp(`^/repos/(${REPO})$`);

const landed = new Map<string, number>();

function note(repo: string | undefined, version: unknown) {
  if (repo && typeof version === 'number' && version > (landed.get(repo) ?? 0))
    landed.set(repo, version);
}

/** Notes the landing a successful answer tells of: this browser's own, or a Landing the
 * platform landed by itself. */
export function noteLanding(path: string, method: string, answer: { [key: string]: unknown }) {
  if (method === 'POST') note(LAND.exec(path)?.[1], answer.version);
  if (method === 'GET') note(CHANGE.exec(path)?.[1], answer.landed_version);
}

/** `path`, naming the newest landing here when it reads main as it is now. */
export function atLatestLanding(path: string) {
  const [bare, query = ''] = path.split('?');
  const direct = PUBLISHED_READ.exec(path)?.[1];
  const repo = direct ?? OVERVIEW_READ.exec(bare)?.[1];
  const version = repo && landed.get(repo);
  if (!version) return path;
  const params = new URLSearchParams(query);
  if (!direct && params.get('overview') !== 'true') return path;
  const ref = params.get('ref') ?? 'main';
  if (params.has('min_version') || params.has('at') || params.has('commit') || ref !== 'main')
    return path;
  return `${bare}?${query ? `${query}&` : ''}min_version=${version}`;
}
