// HTTP admission and non-JSON transports. The injected JSON route also serves account MCP.
import { accountMcp } from './account-mcp';
import { forwardTo, homeElsewhere } from './cell-route';
import { error } from './http';
import { auditExport, auditExportOrg } from './platform-audit-export';
import { isOwnAvatar, ownAvatar, publicAvatarName, servePublicAvatar } from './platform-avatars';
import { deviceCode, deviceToken } from './platform-tokens';
import { bodyOf } from './repo-api-body';
import { answer, failure } from './repo-api-failure';
import { credentials } from './repo-credentials';
import { repoMcp } from './repo-mcp';
import { downloadBlob } from './repo-object-download';
import { streamObjects } from './repo-object-fetch';
import { type Credentials, caller, type Json, RepoContext } from './repo-ops';
import { pathOf, profile, resolvePath } from './repo-paths';
import {
  ANONYMOUS,
  admitAnonymous,
  anonymousRead,
  anonymousRepo,
  exploreCells,
  isExplore,
  limitAnonymous,
} from './repo-public';
import { releaseDownload } from './repo-releases';
import { timed } from './repo-timing';
import type { Env } from './types';

const BLOB = /^\/api\/v1\/repos\/(r[0-9a-f]{20})\/objects\/([0-9a-f]{40})$/;
const PAGE = /^\/api\/v1\/repos\/(r[0-9a-f]{20})\/objects$/;
const OBJECTS_BODY_LIMIT = 2 * 1024 * 1024;

export async function handle(
  req: Request,
  env: Env,
  route: (req: Request, env: Env, url: URL, auth: Credentials) => Promise<Json>,
): Promise<Response> {
  const url = new URL(req.url);
  // Device login starts and finishes without credentials (the code pair is the secret).
  if (req.method === 'POST' && url.pathname === '/api/v1/device/code')
    return answer(() => bodyOf(req).then((body) => deviceCode(req, env, body, url)));
  if (req.method === 'POST' && url.pathname === '/api/v1/device/token')
    return answer(() => bodyOf(req).then((body) => deviceToken(req, env, body)));
  // The public listing answers everyone alike, signed in or not (rate limited without
  // credentials, like every anonymous read).
  if (isExplore(url) && req.method === 'GET')
    return answer(async () => {
      if (!req.headers.has('cookie') && !req.headers.has('authorization'))
        await limitAnonymous(env, req, url.pathname);
      return exploreCells(env, url);
    });
  // Profiles are public listings, answered alike to everyone.
  const profiled = /^\/api\/v1\/profiles\/([^/]+)$/.exec(url.pathname);
  if (profiled && req.method === 'GET')
    return answer(async () => {
      if (!req.headers.has('cookie') && !req.headers.has('authorization'))
        await limitAnonymous(env, req, url.pathname);
      return profile(env, decodeURIComponent(profiled[1]), url.pathname);
    });
  // Anyone's picture, like the listing: no session check per image.
  const avatar = publicAvatarName(url);
  if (avatar !== undefined && req.method === 'GET')
    return (async () => {
      if (!req.headers.has('cookie') && !req.headers.has('authorization'))
        await limitAnonymous(env, req, url.pathname);
      return servePublicAvatar(env, avatar, req);
    })().catch(failure);
  const signed = await timed('auth', () => credentials(req, env));
  const home = homeElsewhere(env, req, url);
  if (home) return forwardTo(env, home, req);
  // A readable path, or the repository one names, for whoever asks (nobody signed in sees
  // public repositories only); one that may not be read answers as one that is not there.
  const resolving = /^\/api\/v1\/resolve\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const pathing = /^\/api\/v1\/repos\/(r[0-9a-f]{20})\/path$/.exec(url.pathname);
  if ((resolving || pathing) && req.method === 'GET') {
    if (!signed && req.headers.has('authorization'))
      return error('UNAUTHORIZED', 'Sign in or use a repository token', 401);
    return answer(async () => {
      if (!signed) await limitAnonymous(env, req, url.pathname);
      return resolving
        ? resolvePath(
            env,
            signed,
            decodeURIComponent(resolving[1]),
            decodeURIComponent(resolving[2]),
            url.searchParams,
          )
        : pathOf(env, signed, (pathing as RegExpExecArray)[1]);
    });
  }
  // Without credentials, reads go on as anonymous (public repositories only, rate limited);
  // a token that is refused (expired, revoked, malformed) never falls back to anonymous.
  if (!signed && (req.headers.has('authorization') || !anonymousRead(req, url)))
    return error('UNAUTHORIZED', 'Sign in or use a repository token', 401);
  if (!signed) {
    const repo = anonymousRepo(url);
    const refused = await limitAnonymous(env, req, url.pathname)
      .then(() => (repo ? admitAnonymous(env, repo) : undefined))
      .then(() => null, failure);
    if (refused) return refused;
  }
  const auth = signed ?? ANONYMOUS;
  const mcp = /^\/api\/v1\/repos\/(r[0-9a-f]{20})\/mcp$/.exec(url.pathname);
  // MCP is the agent surface: it never carries a human marker, so break-glass (which is not
  // an MCP tool either) stays unreachable through it.
  const machine: Credentials =
    '_session' in auth
      ? {
          _session: {
            workspace: auth._session.workspace,
            principal: auth._session.principal,
            ...(auth._session.orgs && { orgs: auth._session.orgs }),
          },
        }
      : auth;
  if (mcp) return repoMcp(req, new RepoContext(env, mcp[1], caller(env, mcp[1], machine)));
  if (url.pathname === '/api/v1/mcp') return accountMcp(req, env, machine, route);
  // The signed-in person's picture: its bytes, an upload or a removal.
  if (isOwnAvatar(url)) return ownAvatar(req, env, auth).catch(failure);
  // An audit log's export is a file, not a JSON answer.
  const audited = auditExportOrg(url);
  if (audited && req.method === 'GET')
    return auditExport(env, auth, audited, url.searchParams).catch(failure);
  // An asset download is the asset's bytes, not a JSON answer.
  const download = releaseDownload(req, env, url, auth);
  if (download) return download.catch(failure);
  // So is a large blob's (the stubs `POST /objects` serves with `large`).
  const blob = BLOB.exec(url.pathname);
  if (blob && req.method === 'GET')
    return downloadBlob(
      new RepoContext(env, blob[1], caller(env, blob[1], auth)),
      blob[2],
      url.searchParams,
      req.headers.get('range'),
    ).catch(failure);
  // A page of objects streams as it is read (repo-object-fetch.ts), as REST alone.
  const page = PAGE.exec(url.pathname);
  if (page && req.method === 'POST')
    return bodyOf(req, OBJECTS_BODY_LIMIT)
      .then((body) =>
        streamObjects(new RepoContext(env, page[1], caller(env, page[1], auth)), body),
      )
      .catch(failure);
  return answer(() => route(req, env, url, auth));
}
