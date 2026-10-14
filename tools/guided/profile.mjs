import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
// Version 1 keeps its original profile path so its protected bundle digest never changes.
const profilePaths = {
  1: 'fixtures/guided-task-board/profile.json',
  2: 'fixtures/guided-task-board/profile-v2.json',
};
export const profileVersions = Object.keys(profilePaths).map(Number);
const read = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
function profilePath(version) {
  const path = profilePaths[version];
  if (!path) throw new Error(`Unknown guided profile version ${version}`);
  return path;
}
/** Starter, brief and bundle layout for one guided profile version. */
export function guidedProfile(version = 1) {
  const value = read(profilePath(version));
  if (value.version !== version) throw new Error('Guided profile version differs from its path');
  return value;
}
export function guidedBriefs(version = 1) {
  return read(guidedProfile(version).briefs);
}
export const profile = guidedProfile(1);
export const briefs = guidedBriefs(1);
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sort = (files) =>
  Object.fromEntries(
    Object.entries(files).sort(([left], [right]) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  );

export function starterFiles(version = 1) {
  const selected = guidedProfile(version);
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
  walk(resolve(root, selected.starter));
  if (
    JSON.stringify(Object.keys(files).sort()) !== JSON.stringify([...selected.source_paths].sort())
  )
    throw new Error('Starter source allowlist differs from profile');
  return sort(files);
}

/** Immutable owner bundle; these files never become editable candidate source.
 * Every version shares the same oracle; only its profile and briefs differ. */
export function protectedBundle(version = 1) {
  const selected = guidedProfile(version);
  const files = {};
  for (const path of [
    selected.briefs,
    profilePath(version),
    ...['run.mjs', 'check.mjs', 'observe.mjs'].map(
      (file) => `fixtures/guided-task-board/oracle/${file}`,
    ),
  ])
    files[path] = { content: readFileSync(resolve(root, path), 'utf8'), executable: false };
  const sorted = sort(files);
  return { files: sorted, digest: digest(sorted) };
}

export function guidedPolicy(version = 1) {
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
        digest: protectedBundle(version).digest,
        protected_paths: ['README.md', '.yoneda-guided', 'fixtures/guided-task-board/oracle'],
      },
    },
  };
}
