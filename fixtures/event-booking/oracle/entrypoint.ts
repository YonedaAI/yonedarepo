import {App} from 'booking-subject';
import schema from '../source/schema.json';
// Owner-owned initialization, outside candidate source. Production uses the trusted app wrapper.
export class FixtureApp extends App {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    if (![...ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='events'")].length) {
      ctx.storage.transactionSync(() => {
        for (const migration of schema.migrations) for (const sql of migration.sql) ctx.storage.sql.exec(sql);
        for (const sql of schema.seed) ctx.storage.sql.exec(sql);
      });
    }
  }
}
export default {fetch: () => new Response('Protected fixture test wrapper')};
