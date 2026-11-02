// The D1 schema for a second cell's database in a test.
import listing from '../../cloudflare/migrations/0003_platform_repos.sql?raw';
import tokens from '../../cloudflare/migrations/0004_platform_tokens.sql?raw';
import members from '../../cloudflare/migrations/0005_platform_members.sql?raw';
import visibility from '../../cloudflare/migrations/0006_platform_repo_visibility.sql?raw';
import activity from '../../cloudflare/migrations/0007_platform_activity.sql?raw';
import handles from '../../cloudflare/migrations/0008_platform_handles.sql?raw';
import accounts from '../../cloudflare/migrations/0009_platform_accounts.sql?raw';
import activitySize from '../../cloudflare/migrations/0010_platform_activity_db_bytes.sql?raw';
import deletedRepos from '../../cloudflare/migrations/0011_platform_deleted_repos.sql?raw';
import accountRegion from '../../cloudflare/migrations/0012_platform_account_region.sql?raw';
import accountInternal from '../../cloudflare/migrations/0013_platform_account_internal.sql?raw';
import adminAuditDetail from '../../cloudflare/migrations/0015_admin_audit_detail.sql?raw';
import visitors from '../../cloudflare/migrations/0016_platform_visitors.sql?raw';

const ALL = [listing, tokens, members, visibility, activity, handles, accounts, activitySize, deletedRepos, accountRegion, accountInternal, adminAuditDetail, visitors];

export async function applySchema(db: D1Database) {
  for (const migration of ALL)
    for (const statement of migration.split(';').filter((s) => s.replace(/--.*$/gm, '').trim()))
      await db.exec(statement.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim()).catch((e) => {
        if (!/duplicate column|already exists/i.test(String(e?.message ?? e))) throw e;
      });
}
