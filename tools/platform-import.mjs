#!/usr/bin/env node
// Imports a local directory (for example a fixture) as a new source-platform repository
// through the public API. Credentials come from the environment, never arguments:
//   YONEDA_USERNAME / YONEDA_PASSWORD  (add --signup to create the account first)
// Usage: node tools/platform-import.mjs --url http://localhost:8787 --dir fixtures/website --name website
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const SKIP = new Set(['.git', 'node_modules', 'target', 'dist', '.wrangler', '.DS_Store']);
const MAX_FILE = 32 * 1024 * 1024;

export async function collect(root) {
  const files = [];
  const skipped = [];
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      const info = await lstat(path);
      const name = relative(root, path).split(sep).join('/');
      if (info.isDirectory()) await walk(path);
      else if (!info.isFile()) skipped.push(`${name} (not a regular file)`);
      else if (info.size > MAX_FILE) skipped.push(`${name} (larger than 32 MiB)`);
      else
        files.push({
          path: name,
          content_b64: (await readFile(path)).toString('base64'),
          ...(info.mode & 0o111 ? { executable: true } : {}),
        });
    }
  }
  await walk(root);
  return { files, skipped };
}

async function session(url, signup) {
  const username = process.env.YONEDA_USERNAME;
  const password = process.env.YONEDA_PASSWORD;
  if (!username || !password) throw new Error('Set YONEDA_USERNAME and YONEDA_PASSWORD');
  const post = (path) =>
    fetch(`${url}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  if (signup) {
    const created = await post('signup');
    if (!created.ok && created.status !== 409) throw new Error(`Signup failed (${created.status})`);
  }
  const login = await post('login');
  if (!login.ok) throw new Error(`Login failed (${login.status})`);
  return (login.headers.get('set-cookie') ?? '').split(';')[0];
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      dir: { type: 'string' },
      name: { type: 'string' },
      policy: { type: 'string' },
      signup: { type: 'boolean', default: false },
    },
  });
  if (!values.url || !values.dir) throw new Error('Usage: --url <origin> --dir <directory> [--name <name>] [--policy <json>] [--signup]');
  const url = values.url.replace(/\/$/, '');
  const root = resolve(values.dir);
  const { files, skipped } = await collect(root);
  if (files.length === 0) throw new Error('No files to import');
  const cookie = await session(url, values.signup);
  const response = await fetch(`${url}/api/v1/repos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: values.name ?? basename(root),
      policy: values.policy ? JSON.parse(values.policy) : { required_checks: [], approvals: 1 },
      files,
      message: `Import ${basename(root)}`,
      author: { name: 'YonedaRepo import', email: 'import@yonedarepo.invalid' },
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${body.error?.code}: ${body.error?.message}`);
  console.log(JSON.stringify({ ...body, files: files.length, skipped, browse: `${url}/source/${body.id}` }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
