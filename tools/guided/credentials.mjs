import { lstat, readFile } from 'node:fs/promises';
import { client } from '../acceptance/client.mjs';

export function safeOrigin(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('HTTPS platform origin required');
  return url.origin;
}
export async function privateFile(path) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
  )
    throw new Error('An owned mode-0600 regular file is required');
  return readFile(path, 'utf8');
}
async function stdinKey() {
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk;
      if (text.length > 4096) throw new Error('Credential input exceeds bound');
    }
    return text;
  }
  return new Promise((accept, reject) => {
    let key = '';
    process.stdout.write('Reviewer key (hidden): ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (error) => {
      process.stdin.off('data', data);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      error ? reject(error) : accept(key);
    };
    function data(chunk) {
      for (const character of chunk.toString()) {
        if (character === '\u0003') return finish(new Error('Cancelled'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') key = key.slice(0, -1);
        else if (character >= ' ' && key.length < 128) key += character;
      }
    }
    process.stdin.on('data', data);
  });
}

/** Existing reviewer account only. Authentication/API cookies remain in this process. */
export async function reviewerClient(origin, { keyFile, username } = {}) {
  origin = safeOrigin(origin);
  let text = keyFile ? await privateFile(keyFile) : await stdinKey();
  if (text.length > 4096) throw new Error('Credential input exceeds bound');
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    record = null;
  }
  let password = record?.password ?? text.trim();
  const owner = record?.username ?? username;
  if (
    typeof owner !== 'string' ||
    !owner ||
    typeof password !== 'string' ||
    !password ||
    password.length > 128
  )
    throw new Error('Existing account and reviewer key are required');
  const transport = client(origin);
  try {
    await transport.api('auth/login', { username: owner, password });
  } finally {
    text = '';
    password = '';
    if (record) record.password = '';
  }
  return {
    ...transport,
    simulated: false,
    owner,
    health: async () => {
      const response = await fetch(`${origin}/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Platform health unavailable');
      return response.json();
    },
  };
}
