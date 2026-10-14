import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const profile = JSON.parse(
  readFileSync(resolve(root, 'fixtures/guided-task-board/profile.json'), 'utf8'),
);
export const briefs = JSON.parse(readFileSync(resolve(root, profile.briefs), 'utf8'));
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sort = (files) =>
  Object.fromEntries(
    Object.entries(files).sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  );

export function starterFiles() {
  const files = {};
  function walk(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) walk(resolve(directory, entry.name), path + '/');
      else if (entry.isFile())
        files[path] = {
          content: readFileSync(resolve(directory, entry.name), 'utf8'),
          executable: false,
        };
      else throw new Error('Starter must contain only regular files');
    }
  }
  walk(resolve(root, profile.starter));
  if (
    JSON.stringify(Object.keys(files).sort()) !== JSON.stringify([...profile.source_paths].sort())
  )
    throw new Error('Starter source allowlist differs from profile');
  return sort(files);
}

/** Immutable owner bundle; these files never become editable candidate source. */
export function protectedBundle() {
  const files = {};
  for (const path of [
    profile.briefs,
    'fixtures/guided-task-board/profile.json',
    ...['run.mjs', 'check.mjs', 'observe.mjs'].map(
      (file) => `fixtures/guided-task-board/oracle/${file}`,
    ),
  ])
    files[path] = { content: readFileSync(resolve(root, path), 'utf8'), executable: false };
  const sorted = sort(files);
  return { files: sorted, digest: digest(sorted) };
}

export function guidedPolicy() {
  return {
    version: 'task-board-v1',
    suite: 'commands-v1',
    environment: 'linux-node24-rust1.94-v1',
    required_checks: ['guided-task-board'],
    build: {
      setup: [],
      static_dir: 'public',
      checks: [
        {
          name: 'guided-task-board',
          timeout_seconds: 30,
          argv: ['node', '/opt/yoneda/test-bundle/fixtures/guided-task-board/oracle/run.mjs'],
        },
      ],
      test_bundle: {
        digest: protectedBundle().digest,
        protected_paths: ['README.md', '.yoneda-guided', 'fixtures/guided-task-board/oracle'],
      },
    },
  };
}
