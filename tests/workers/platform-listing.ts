// Agent-layer flows create platform repositories through the public API, whose D1 listing
// projection (and personal-token lookup) must exist like it does after the deployed
// migrations.
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';
import listing from '../../cloudflare/migrations/0003_platform_repos.sql?raw';
import tokens from '../../cloudflare/migrations/0004_platform_tokens.sql?raw';

beforeEach(async () => {
  const db = (env as unknown as { INDEX: D1Database }).INDEX;
  for (const migration of [listing, tokens])
    for (const statement of migration.split(';').filter((s) => s.replace(/--.*$/gm, '').trim()))
      await db.exec(statement.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim());
});
