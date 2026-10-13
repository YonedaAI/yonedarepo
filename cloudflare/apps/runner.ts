import { DurableObject } from 'cloudflare:workers';
import { readBundle } from './bundle';
import type { AppManifest, RunnerEnv, TrustedApp } from './contracts';
import { managedModule } from './facet-code';

interface Active {
  digest: string;
  generation: number;
  manifest: AppManifest;
}
/** Namespace is private to the apps host. Only the host calls serve with platform-authorized descriptors. */
export class AppRunner extends DurableObject<RunnerEnv> {
  #tail: Promise<void> = Promise.resolve();
  async fetch() {
    return new Response('Not found', { status: 404 });
  }
  async serve(app: TrustedApp, request: Request): Promise<Response> {
    // Serialize publication switches and in-flight dispatch; I/O stays outside SQL transactions.
    const previous = this.#tail;
    let release: () => void = () => {};
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.#dispatch(app, request);
    } catch {
      return new Response('Application unavailable', { status: 503 });
    } finally {
      release();
    }
  }
  async #dispatch(app: TrustedApp, request: Request) {
    const bundle = await readBundle(this.env, app);
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS app_authority (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const owner = sql
      .exec<{ value: string }>('SELECT value FROM app_authority WHERE key=?', 'owner')
      .toArray()[0];
    if (owner && owner.value !== app.app_id) throw new Error('Cross-app authority mismatch');
    if (!owner) sql.exec('INSERT INTO app_authority VALUES (?,?)', 'owner', app.app_id);
    const facetName = app.mode === 'published' ? 'appDB' : `preview:${app.bundle_digest}`;
    const activeRow = sql
      .exec<{ value: string }>('SELECT value FROM app_authority WHERE key=?', facetName)
      .toArray()[0];
    const active: Active | undefined = activeRow ? JSON.parse(activeRow.value) : undefined;
    if (active && app.mode === 'published') {
      if (
        app.generation < active.generation ||
        (app.generation === active.generation && active.digest !== app.bundle_digest)
      )
        throw new Error('Stale application publication');
      if (active.digest !== app.bundle_digest) {
        const old = active.manifest.migrations;
        if (
          old.length > bundle.manifest.migrations.length ||
          old.some(
            (step, i) =>
              step.version !== bundle.manifest.migrations[i]?.version ||
              JSON.stringify(step.sql) !== JSON.stringify(bundle.manifest.migrations[i]?.sql),
          )
        )
          throw new Error('Application migration history mismatch');
        if (JSON.stringify(active.manifest.seed) !== JSON.stringify(bundle.manifest.seed))
          throw new Error('Application seed history mismatch');
        this.ctx.facets.abort(facetName, new Error('Application code upgraded'));
      }
    }
    const worker = this.env.LOADER.get(`app:${app.app_id}:${app.bundle_digest}`, () => ({
      compatibilityDate: '2026-10-12',
      globalOutbound: null,
      limits: { cpuMs: 50, subRequests: 0 },
      env: {},
      mainModule: '_yoneda_managed.js',
      modules: {
        ...Object.fromEntries(
          Object.entries(bundle.modules).map(([name, source]) => [name, { js: source }]),
        ),
        '_yoneda_managed.js': { js: managedModule(bundle) },
      },
    }));
    const facet = this.ctx.facets.get(facetName, () => ({
      class: worker.getDurableObjectClass('ManagedApp'),
    })) as Fetcher & { ready(): Promise<void> };
    try {
      await facet.ready();
      // Startup SQL must succeed before a publication becomes active.
      sql.exec(
        'INSERT OR REPLACE INTO app_authority VALUES (?,?)',
        facetName,
        JSON.stringify({
          digest: app.bundle_digest,
          generation: app.generation,
          manifest: bundle.manifest,
        }),
      );
      return await facet.fetch(request);
    } catch (error) {
      this.ctx.facets.abort(facetName, new Error('Application startup or request failed'));
      throw error;
    }
  }
}
