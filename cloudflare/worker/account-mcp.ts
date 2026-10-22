// The account MCP (`POST /api/v1/mcp`) for cloud agents: one endpoint across the caller's
// repositories. It adds repository management (list, create, delete) and serves every
// platform tool with a required `repo` argument. Nothing here decides access: management
// goes through the same REST routes, and platform tools through the shared operation table,
// each with the caller's own credentials (session, personal access token or repository
// token), so scopes and allowlists are enforced exactly where they are for REST.
import platformTools from '../../backend/crates/yoneda-core/src/platform_tools.json';
import { operation, serveMcp } from './repo-mcp';
import { ApiError, type Credentials, caller, type Json, RepoContext } from './repo-ops';
import type { Env } from './types';

/** The REST router (`repo-api.ts`), called in-process for the management tools. */
export type Route = (req: Request, env: Env, url: URL, auth: Credentials) => Promise<Json>;

const REPO_ID = /^r[0-9a-f]{20}$/;
const repoArg = {
  type: 'string',
  description: 'Repository id (r followed by 20 hex digits) or its exact name',
};
const file = {
  type: 'object',
  properties: { path: { type: 'string' }, content_b64: { type: 'string' } },
  required: ['path', 'content_b64'],
};

const managementTools: Json[] = [
  {
    name: 'repo_list',
    description: 'Repositories this credential can use, newest first: id, name and created_at.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'repo_create',
    description:
      'Create a repository, optionally seeded with files landed as its first commit on main. policy {approvals, required_checks} defaults to one approval; {approvals:0, required_checks:[]} lands solo.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', pattern: '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$' },
        files: { type: 'array', items: file, maxItems: 10000 },
        policy: {
          type: 'object',
          properties: {
            approvals: { type: 'integer', minimum: 0 },
            required_checks: { type: 'array', items: { type: 'string' } },
          },
        },
        message: { type: 'string' },
        author: {
          type: 'object',
          properties: { name: { type: 'string' }, email: { type: 'string' } },
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'repo_delete',
    description:
      'Delete a repository permanently. confirm must equal the repository name exactly. Needs repo:admin.',
    inputSchema: {
      type: 'object',
      properties: { repo: repoArg, confirm: { type: 'string' } },
      required: ['repo', 'confirm'],
      additionalProperties: false,
    },
  },
];

/** Every platform tool with `repo` added (the shared schemas are copied, never mutated). */
const repoTools: Json[] = platformTools.map((tool: Json) => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: { repo: repoArg, ...tool.inputSchema.properties },
    required: ['repo', ...(tool.inputSchema.required ?? [])],
  },
}));

export const accountTools: Json[] = [...managementTools, ...repoTools];

export function accountMcp(req: Request, env: Env, auth: Credentials, route: Route) {
  const origin = new URL(req.url).origin;
  const rest = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: Json) => {
    const url = new URL(`/api/v1${path}`, origin);
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return route(new Request(url, init), env, url, auth);
  };
  /** A repository id, or the id of the caller's one repository with this exact name. */
  async function resolve(repo: unknown): Promise<string> {
    if (typeof repo !== 'string' || !repo) throw new ApiError('INVALID_INPUT', 'repo is required');
    if (REPO_ID.test(repo)) return repo;
    const listed = (await rest('GET', '/repos')).repos as { id: string; name: string }[];
    const named = listed.filter((r) => r.name === repo);
    if (named.length === 1) return named[0].id;
    if (named.length === 0) throw new ApiError('NOT_FOUND', `No repository named ${repo}`);
    throw new ApiError(
      'INVALID_INPUT',
      `Several repositories are named ${repo}; use an id: ${named.map((r) => r.id).join(', ')}`,
    );
  }
  return serveMcp(req, {
    name: 'yonedarepo-account',
    instructions:
      'YonedaRepo across your repositories. repo_list/repo_create/repo_delete manage them; every git_* and symbol_* tool takes repo (id or name). Write with git_commit (server-side), land with git_land: disjoint concurrent changes merge on the server, a CONFLICT returns base/ours/theirs to resolve and commit again.',
    tools: accountTools,
    call: async (name, args) => {
      if (name === 'repo_list') return rest('GET', '/repos');
      if (name === 'repo_create') return rest('POST', '/repos', args);
      if (name === 'repo_delete') {
        const id = await resolve(args.repo);
        const confirm = encodeURIComponent(String(args.confirm ?? ''));
        return rest('DELETE', `/repos/${id}?confirm=${confirm}`);
      }
      const run = operation(name);
      const { repo, ...toolArgs } = args;
      const id = await resolve(repo);
      return run(new RepoContext(env, id, caller(env, id, auth)), toolArgs);
    },
  });
}
