// The operator dashboard's independent counters run together, then form one short snapshot.

import { adminBillingOn } from './platform-admin-billing';
import { everyCell, mergeOverview } from './platform-admin-cells';
import { overview } from './platform-admin-queries';
import { adminRead } from './platform-admin-read-cache';
import { subscriberCount } from './platform-newsletter';
import type { Env } from './types';

export function readAdminOverview(env: Env, actor: string) {
  return adminRead(env, actor, '/overview', async () => {
    const [newsletter, totals] = await Promise.all([
      subscriberCount(env),
      everyCell(env, '/api/v1/admin/overview', () => overview(env), mergeOverview),
    ]);
    return { ...totals, billing: adminBillingOn(env), newsletter };
  });
}
