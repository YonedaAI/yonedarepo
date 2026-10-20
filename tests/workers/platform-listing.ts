// Agent-layer flows create platform repositories through the public API, whose D1 listing
// projection must exist like it does after the deployed migrations.
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';
import listing from '../../cloudflare/migrations/0003_platform_repos.sql?raw';

beforeEach(async () => {
  const db = (env as unknown as { INDEX: D1Database }).INDEX;
  for (const statement of listing.split(';').filter((s) => s.replace(/--.*$/gm, '').trim()))
    await db.exec(statement.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim());
});
