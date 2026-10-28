// Tests create platform repositories through the public API, whose D1 listing projection
// (and personal-token lookup) must exist like it does after the deployed migrations.
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';
import listing from '../../cloudflare/migrations/0003_platform_repos.sql?raw';
import tokens from '../../cloudflare/migrations/0004_platform_tokens.sql?raw';
import members from '../../cloudflare/migrations/0005_platform_members.sql?raw';
import visibility from '../../cloudflare/migrations/0006_platform_repo_visibility.sql?raw';

beforeEach(async () => {
  const db = (env as unknown as { INDEX: D1Database }).INDEX;
  for (const migration of [listing, tokens, members, visibility])
    for (const statement of migration.split(';').filter((s) => s.replace(/--.*$/gm, '').trim()))
      await db
        .exec(statement.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim())
        // Both setups apply the schema; an added column is there after the first.
        .catch((e) => {
          if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
        });
});
