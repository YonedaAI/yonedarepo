import { safeId } from './http';
import type { Env, Json } from './types';

const numericCodes: Record<number, string> = {
  10200: 'NOT_FOUND',
  10201: 'ALREADY_EXISTS',
  10302: 'IMPORT_IN_PROGRESS',
  10303: 'FORK_IN_PROGRESS',
  10104: 'INVALID_URL',
  10106: 'REMOTE_AUTH_REQUIRED',
  10401: 'UPSTREAM_UNAVAILABLE',
  10402: 'MEMORY_LIMIT',
};
export function setupCode(error: any): string {
  if (error?.name === 'TimeoutError') return 'UPSTREAM_UNAVAILABLE';
  if (typeof error?.code === 'string') return error.code;
  return numericCodes[error?.numericCode ?? error?.code] ?? 'SETUP_FAILED';
}
export function pendingSetup(error: unknown) {
  return ['IMPORT_IN_PROGRESS', 'FORK_IN_PROGRESS', 'CREATE_IN_PROGRESS'].includes(
    setupCode(error),
  );
}
export function setupError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

// Resolve Git's advertised HEAD rather than assuming that an import uses "main".
// Only validated public host URLs enter this adapter; redirects stay on the same host.
export async function sourceBranch(source: string): Promise<string> {
  let url = new URL(source);
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\.git$/, '')}.git/info/refs`;
  url.searchParams.set('service', 'git-upload-pack');
  for (let redirects = 0; redirects < 4; redirects++) {
    const result = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'user-agent': 'YonedaRepo',
        accept: 'application/x-git-upload-pack-advertisement',
      },
    });
    if ([301, 302, 307, 308].includes(result.status)) {
      await result.body?.cancel();
      const next = new URL(result.headers.get('location') ?? '', url);
      if (next.protocol !== 'https:' || next.host !== url.host || next.username || next.password)
        throw setupError(
          'INVALID_URL',
          'The Git URL redirects outside its public host. Use the repository URL.',
        );
      url = next;
      continue;
    }
    if (!result.ok) {
      await result.body?.cancel();
      throw setupError(
        'REMOTE_AUTH_REQUIRED',
        'The repository could not be read publicly. Use a public Git repository URL.',
      );
    }
    const reader = result.body?.getReader();
    if (!reader)
      throw setupError(
        'EMPTY_REPOSITORY',
        'The repository has no readable Git HEAD. Push an initial commit, then retry setup.',
      );
    let text = '';
    const decoder = new TextDecoder();
    try {
      while (text.length < 65_536) {
        const part = await reader.read();
        if (part.done) break;
        text += decoder.decode(part.value, { stream: true });
        const branch = advertisedBranch(text);
        if (branch) return branch;
        if (text.endsWith('0000') && text.includes('\0')) break;
      }
      throw setupError(
        'EMPTY_REPOSITORY',
        'No default-branch commit was advertised. Push an initial commit to the public repository, then retry setup.',
      );
    } finally {
      await reader.cancel();
    }
  }
  throw setupError('INVALID_URL', 'Too many Git URL redirects. Use the repository URL directly.');
}
export function advertisedBranch(text: string): string | null {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  let branch: string | undefined;
  for (let offset = 0; offset + 4 <= bytes.length; ) {
    const header = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[a-f0-9]{4}$/i.test(header)) break;
    const size = Number.parseInt(header, 16);
    if (size === 0) {
      offset += 4;
      continue;
    }
    if (size < 4 || offset + size > bytes.length) break;
    const packet = decoder.decode(bytes.subarray(offset + 4, offset + size));
    if (/^[a-f0-9]{40} HEAD\0/.test(packet)) {
      branch = /(?:\0| )symref=HEAD:refs\/heads\/([^\s\0]+)(?:\s|\0)/.exec(packet)?.[1];
      break;
    }
    offset += size;
  }
  if (!branch) return null;
  if (
    branch.length > 255 ||
    [...branch].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    /[~^:?*[\\]/.test(branch) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  )
    throw setupError('INVALID_URL', 'The repository advertised an invalid default branch.');
  return branch;
}

export function setupMessage(error: any): string {
  const code = setupCode(error);
  const known: Record<string, string> = {
    NOT_FOUND:
      'The repository or starter could not be found. Check the public Git URL or ask the administrator to check the starter repository.',
    EMPTY_REPOSITORY:
      'No default-branch commit could be found. Push an initial commit to the public repository, then retry setup.',
    REMOTE_AUTH_REQUIRED:
      'The repository could not be read publicly. Use a public Git repository URL.',
    UPSTREAM_UNAVAILABLE: 'The Git service did not respond. Retry setup in a moment.',
    MEMORY_LIMIT: 'The repository exceeds the import service limit. Try a smaller repository.',
    INVALID_URL: 'Use the public Git repository URL with a valid default branch.',
    SETUP_TIMEOUT: 'Repository setup took too long. Retry setup; existing source is preserved.',
  };
  if (known[code]) return known[code];
  // These adapter errors contain only fixed text. SDK error messages may contain capabilities.
  const sourceErrors = [
    'Source nesting exceeds limit',
    'Source tree missing',
    'Unsafe source path',
    'Only regular files are supported; symlinks and Git submodules need conversion',
    'Source blob missing',
    'Source exceeds MVP limit',
    'Captured commit is missing',
  ];
  if (sourceErrors.includes(error?.message)) return error.message;
  return 'Repository setup failed. Retry setup, or ask the administrator to check its setup logs.';
}

export async function prepareRemote(env: Env, project: Json) {
  if (!safeId(project.id)) throw setupError('INVALID_INPUT', 'Invalid project identity');
  try {
    using existing = await env.ARTIFACTS.get(project.id);
    await existing.info();
    return;
  } catch (error) {
    if (pendingSetup(error)) throw error;
    // Do not mask transient reads as new creation attempts.
    if (setupCode(error) !== 'NOT_FOUND') throw error;
  }
  try {
    const created = project.source
      ? await env.ARTIFACTS.import({
          source: { url: project.source, branch: await sourceBranch(project.source) },
          target: { name: project.id, opts: { description: 'YonedaRepo project' } },
        })
      : await (async () => {
          using starter = await env.ARTIFACTS.get(env.STARTER_REPO ?? 'yoneda-website-starter');
          return starter.fork(project.id, { defaultBranchOnly: true });
        })();
    using remote = await env.ARTIFACTS.get(project.id);
    await remote.revokeToken(created.token);
  } catch (error) {
    if (pendingSetup(error)) throw error;
    // Lost creation acknowledgments are recoverable only after a read proves existence.
    try {
      using existing = await env.ARTIFACTS.get(project.id);
      await existing.info();
    } catch {
      throw error;
    }
  }
}
