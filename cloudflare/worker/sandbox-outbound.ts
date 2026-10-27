// Every HTTP and HTTPS request from a sandbox comes here (Cloudflare's "Build a coding agent
// runner" pattern: the container starts with Internet access off and its traffic intercepted).
// Two destinations are open, both over HTTPS, and the Worker adds each credential, so no key
// or token ever enters the sandbox:
// - the model endpoint the run's connection resolves to (AI Gateway or the provider), with
//   the provider key from the saved connection;
// - this project's own platform repository, with the project's agent token, limited to reads,
//   object/commit upload and moving the attempt's own branch `attempts/<run>/<n>`, never
//   another agent's branch of the same run.
// Everything else gets a 403, so the agent cannot install packages or reach other services.
// A check sandbox (role `check`) gets less: GET requests to the project repository only, so it
// can clone the candidate but never push, upload or move a ref, and it has no model endpoint.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { providerDefinition } from '../../shared/providers';
import { projectToken } from './agents-platform';
import type { Env, Json } from './types';
import { providerCredentials } from './vault';

type PlatformAccess = {
  project: string;
  owner: string;
  platformRepo: string;
  /** The origin the sandbox clones from (`yoneda::<origin>/<repo>`). */
  platformOrigin: string;
};
/** An agent sandbox (no role: attempts started before roles existed are agents). */
export type AgentEgress = PlatformAccess & {
  role?: 'agent';
  /** `refs/heads/attempts/<run>/<n>`: the only ref the sandbox may create or move. */
  ref: string;
  provider: string;
  connection?: string;
  model: string;
  routing?: Json | null;
  /** `https://host/path` the CLI uses as ANTHROPIC_BASE_URL. */
  modelBase: string;
};
/** A check sandbox: reads its project repository, nothing else. */
export type CheckEgress = PlatformAccess & { role: 'check' };
export type OutboundProps = AgentEgress | CheckEgress;

export type OutboundDecision =
  | { route: 'model' }
  | { route: 'platform'; refs: boolean }
  | { deny: string };

const PLATFORM_POSTS = new Set(['/objects', '/commits', '/branches', '/refs/batch']);

/** Where one request may go; pure, so the policy is tested without a sandbox. */
export function outboundDecision(url: URL, method: string, props: OutboundProps): OutboundDecision {
  if (url.protocol !== 'https:') return { deny: `${url.hostname} is reachable only over HTTPS` };
  if (props.role !== 'check') {
    const model = new URL(props.modelBase);
    const modelPath = model.pathname.replace(/\/$/, '');
    if (
      url.host === model.host &&
      (url.pathname === modelPath || url.pathname.startsWith(`${modelPath}/`))
    )
      return method === 'POST' ? { route: 'model' } : { deny: 'Model requests are POSTs' };
  }
  if (url.origin === new URL(props.platformOrigin).origin) {
    const root = `/api/v1/repos/${props.platformRepo}`;
    if (url.pathname !== root && !url.pathname.startsWith(`${root}/`))
      return { deny: 'Only this project repository is reachable' };
    const rest = url.pathname.slice(root.length) || '/';
    if (method === 'GET') return { route: 'platform', refs: false };
    // `POST /objects` is the platform's batch object read; git fetch through yoneda:: needs it.
    if (method === 'POST' && rest === '/objects') return { route: 'platform', refs: false };
    if (props.role === 'check')
      return { deny: `Checks read the repository only (${method} ${rest})` };
    if (method === 'POST' && PLATFORM_POSTS.has(rest))
      return { route: 'platform', refs: rest === '/branches' || rest === '/refs/batch' };
    return { deny: `${method} ${rest} is not available to agents` };
  }
  return { deny: `${url.hostname} is not reachable from this sandbox` };
}

/** Every ref a push names must be the attempt's own branch exactly (short or full form). */
export function refsAllowed(body: unknown, branch: string): boolean {
  const value = (body ?? {}) as Json;
  const updates: Json[] = Array.isArray(value.updates) ? value.updates : [value];
  const short = branch.replace(/^refs\/heads\//, '');
  return (
    updates.length > 0 && updates.every((update) => update?.ref === branch || update?.ref === short)
  );
}

const forbidden = (message: string) => new Response(`${message}\n`, { status: 403 });

export class SandboxOutbound extends WorkerEntrypoint<Env, OutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const url = new URL(request.url);
    const decision = outboundDecision(url, request.method, props);
    if ('deny' in decision) return forbidden(decision.deny);
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('x-api-key');
    headers.delete('cookie');
    if (props.role === 'check') {
      // Defense in depth: outboundDecision already gives a check sandbox platform reads only.
      const read =
        request.method === 'GET' ||
        (request.method === 'POST' && url.pathname.endsWith('/objects'));
      if (decision.route !== 'platform' || !read)
        return forbidden('Checks read the repository only');
    } else if (decision.route === 'model') {
      const definition = providerDefinition(props.provider);
      const { key } = await providerCredentials(
        this.env,
        props.owner,
        props.provider,
        props.connection,
        props.model,
        props.routing,
      );
      headers.set(definition.auth_header, `${definition.auth_prefix}${key}`);
      return fetch(new Request(request, { headers }));
    } else if (decision.refs) {
      const body = await request
        .clone()
        .json()
        .catch(() => null);
      if (!refsAllowed(body, props.ref)) return forbidden(`Agents push only to ${props.ref}`);
    }
    const { token } = await projectToken(this.env, props.owner, props.project);
    headers.set('authorization', `Bearer ${token}`);
    const target = this.env.PLATFORM ?? this.env.SELF;
    return target.fetch(
      new Request(`https://platform${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === 'GET' ? undefined : request.body,
      }),
    );
  }
}
