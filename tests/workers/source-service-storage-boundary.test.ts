import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { gitFile, sourceFixture } from '../../tools/source-benchmark/workerd-source-fixture';

afterEach(reset);

it('persists a >2MiB approved view and sealed manifest as bounded individual rows, never aggregate SQL values', async () => {
  const prefix = 'src/' + 'x'.repeat(450);
  const files = Array.from({ length: 10000 }, (_, index) => gitFile(`${prefix}-${String(index).padStart(4, '0')}.bin`, 1));
  expect(new TextEncoder().encode(JSON.stringify(files)).length).toBeGreaterThan(2 * 1024 * 1024);
  const f = await sourceFixture('bounded-storage', { files, protected_paths: [] });
  const cp = await f.rpc({ op: 'source_checkpoint', request_id: 'bounded-checkpoint', expected_workspace_version: 0 });
  const seal = await f.rpc({ op: 'source_seal', request_id: 'bounded-seal', expected_workspace_version: 0,
    checkpoint_id: cp.checkpoint_id, expected_checkpoint_digest: cp.changeset_digest });
  expect(seal.changeset).toBeUndefined();
  expect(seal.change_count).toBe(0);
  const rows = await runInDurableObject(f.stub, (_instance, state) => {
    const tables = [...state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sw_%'")];
    return tables.flatMap(table => {
      const columns = [...state.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table.name})`)];
      if (!columns.some(column => column.name === 'payload')) return [];
      return [...state.storage.sql.exec<{ max_bytes: number }>(`SELECT COALESCE(MAX(length(CAST(payload AS BLOB))),0) AS max_bytes FROM ${table.name}`)]
        .map(row => ({ table: table.name, max_bytes: row.max_bytes }));
    });
  });
  expect(rows.length).toBeGreaterThan(3);
  for (const row of rows) expect(row.max_bytes, row.table).toBeLessThan(2 * 1024 * 1024);
  const first = await f.rpc({ op: 'source_manifest', checkpoint_id: cp.checkpoint_id, section: 'view_files', limit: 200 });
  expect(first.items).toHaveLength(200);
  expect(first.has_more).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(first)).length).toBeLessThan(1024 * 1024);
  expect((await f.rpc({ op: 'source_stat', path: files[9999].path })).exists).toBe(true);
});
