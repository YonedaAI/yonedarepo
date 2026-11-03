// The published limits page against the code that enforces each figure, so the page never
// promises what the code doesn't do: a changed limit fails here until the page says so too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const page = read('frontend/src/content/docs/reference/limits.md');
const PACK = 'backend/crates/yoneda-platform/src/platform_git_receive.rs';
const CHANGES = 'backend/crates/yoneda-platform/src/repo_store/prepare/changes.rs';
const LFS = 'backend/crates/yoneda-platform/src/repo_store/lfs.rs';
const QUOTA = 'backend/crates/yoneda-platform/src/repo_store/lfs/quota.rs';

const ENFORCED = [
  ['the size cap', 'cloudflare/worker/durable.ts', 'SIZE_GUARD_BYTES = 10_000_000_000;', '10 GB of Git data'],
  ['path length', 'backend/crates/yoneda-core/src/lib.rs', 'path.len() > 512', 'Paths up to 512 bytes'],
  ['pack data', PACK, 'MAX_PACK_BYTES: usize = 64 * 1024 * 1024;', '64 MiB of pack data'],
  ['large files', PACK, 'SPILL_BYTES: usize = 8 * 1024 * 1024;', 'files over 8 MiB aside'],
  ['objects per push', PACK, 'max_objects: 40_000,', '40,000 objects'],
  ['bytes per push', PACK, 'max_total_bytes: 2 * 1024 * 1024 * 1024,', '2 GiB of files'],
  ['one file', PACK, 'MAX_FILE_BYTES: usize = 100 * 1024 * 1024;', '100 MiB'],
  ['the warning', 'cloudflare/worker/repo-large-files.ts', 'WARN_BYTES = 50 * 1024 * 1024;', 'warning from 50 MiB'],
  ['one LFS file', LFS, 'MAX_OBJECT_BYTES: i64 = 5_000_000_000;', '| 5 GB |'],
  ['LFS quota', QUOTA, 'DEFAULT_QUOTA_BYTES: i64 = 5 * 1024 * 1024 * 1024;', '5 GiB until the owner raises it'],
  ['LFS quota ceiling', QUOTA, 'MAX_QUOTA_BYTES: i64 = 1024 * 1024 * 1024 * 1024;', 'up to 1 TiB'],
  ['files in a Git commit', 'backend/crates/yoneda-platform/src/repo_store/pushed.rs', 'TOUCHES: usize = 100_000;', '100,000 changed files'],
  ['files in an API commit', CHANGES, 'MAX_CHANGES: usize = 10_000;', '10,000 changed files'],
  ['a file through the API', CHANGES, 'MAX_FILE_BYTES: usize = 32 * 1024 * 1024;', '32 MiB per file'],
  ['an API request', 'cloudflare/worker/repo-api-body.ts', 'COMMIT_BODY_LIMIT = 64 * 1024 * 1024;', 'a 64 MiB request'],
];

test('every enforced figure on the limits page is the one in the code', () => {
  for (const [what, file, inCode, onPage] of ENFORCED) {
    assert.ok(read(file).includes(inCode), `${what}: ${file} no longer says ${inCode}`);
    assert.ok(page.includes(onPage), `${what}: the page no longer says ${onPage}`);
  }
});

test('the page names no internal limit, figure or word', () => {
  for (const word of ['9.4', 'database', 'Durable Object', 'SQLite', 'db_bytes', 'GitHub'])
    assert.ok(!page.includes(word), `the page says ${word}`);
  assert.match(page, /High activity/);
});

test('the two refusal messages say the same thing, and it matches the page', () => {
  const rust = /REPO_FULL_MESSAGE: &str = "([\s\S]*?)";/.exec(read('backend/crates/yoneda-store/src/lib.rs'))[1];
  const said = rust.replace(/\\\n\s*/g, '');
  const worker = /REPO_FULL_MESSAGE =\s+'([^']+)'/.exec(read('cloudflare/worker/durable.ts'))[1];
  assert.equal(said, worker);
  assert.ok(page.includes('start a new repository or contact support'));
});
