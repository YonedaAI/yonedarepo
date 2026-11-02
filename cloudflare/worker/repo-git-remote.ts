// What an import asks of a GitHub repository before it starts a container (repo-clone):
// protocol version 2 over smart HTTP, its head (`ls-refs`, so a large repository's pull refs
// never travel).
//
// The URL comes from a user, so this speaks to github.com and nothing else: `githubRemote`
// takes only a plain repository address and builds the URL again from its two names, every
// request refuses a redirect, no cookie is ever sent, a credential goes only with a private
// source's own request, and the caller bounds the time.

const GITHUB =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/?$/;
/** A ref name safe in a pkt-line, stricter than Git's. */
const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
/** What `ls-refs` for a head may answer: more is many branches sharing a name's start. */
const REFS_BYTES = 64 * 1024;
const RESULT = 'application/x-git-upload-pack-result';
const HEAD_LINE = /^([0-9a-f]{40}) (\S+)(.*)$/;

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;

/** The remote's canonical address, or null when `url` is not a plain GitHub repository. */
export function githubRemote(url: string) {
  const match = GITHUB.exec(url);
  if (!match) return null;
  const name = match[2].replace(/\.git$/, '');
  if (!name || name === '.' || name === '..') return null;
  return `https://github.com/${match[1]}/${name}.git`;
}

const request = (body: string, credential?: string) => ({
  method: 'POST',
  headers: {
    'user-agent': 'git/yonedarepo',
    'git-protocol': 'version=2',
    'content-type': 'application/x-git-upload-pack-request',
    accept: RESULT,
    // As Git sends it (clone_git.rs): GitHub's name for an App's token, and the token.
    ...(credential && { authorization: `Basic ${btoa(`x-access-token:${credential}`)}` }),
  },
  body,
  redirect: 'manual' as const,
});

async function asked(remote: string, body: string, signal: AbortSignal, credential?: string) {
  const answer = await fetch(`${remote}/git-upload-pack`, {
    ...request(body, credential),
    signal,
  });
  // A redirect, a sign-in or a block: none is this repository's pack.
  if (answer.status !== 200 || !answer.body)
    throw new Error(`The remote answered ${answer.status}`);
  if (answer.headers.get('content-type') !== RESULT)
    throw new Error('The remote did not answer as a Git server');
  return answer.body;
}

/** The lines of a pkt-line answer of at most REFS_BYTES. */
async function lines(body: ReadableStream<Uint8Array>) {
  let text = '';
  const decoder = new TextDecoder();
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > REFS_BYTES) throw new Error('The remote has too many refs of this name');
  }
  const out: string[] = [];
  for (let at = 0; at + 4 <= text.length; ) {
    const length = Number.parseInt(text.slice(at, at + 4), 16);
    if (Number.isNaN(length)) throw new Error('The remote answered malformed refs');
    if (length < 4) {
      at += 4;
      continue;
    }
    out.push(text.slice(at + 4, at + length).trim());
    at += length;
  }
  return out;
}

/** The commit `branch` is at, or the remote's default branch and its commit. */
export async function remoteHead(
  remote: string,
  branch: string | undefined,
  signal: AbortSignal,
  credential?: string,
) {
  if (branch !== undefined && !BRANCH.test(branch)) throw new Error('Unusual branch name');
  const prefix = branch === undefined ? 'HEAD' : `refs/heads/${branch}`;
  const body =
    `${pkt('command=ls-refs\n')}${pkt('object-format=sha1')}0001` +
    `${pkt('symrefs\n')}${pkt(`ref-prefix ${prefix}\n`)}0000`;
  for (const line of await lines(await asked(remote, body, signal, credential))) {
    const [, head, name, rest] = HEAD_LINE.exec(line) ?? [];
    if (name !== prefix) continue;
    if (branch !== undefined) return { head, branch };
    const named = /symref-target:refs\/heads\/(\S+)/.exec(rest)?.[1];
    if (named) return { head, branch: named };
  }
  throw new Error(`The remote has no ${prefix}`);
}
