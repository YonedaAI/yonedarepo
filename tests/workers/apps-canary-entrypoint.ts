import { DurableObject } from 'cloudflare:workers';

interface Env {
  LOADER: WorkerLoader;
  CANARY: DurableObjectNamespace<Canary>;
}
export class Canary extends DurableObject<Env> {
  async fetch() {
    const worker = this.env.LOADER.get('canary-v1', () => ({
      compatibilityDate: '2026-10-12',
      globalOutbound: null,
      limits: { cpuMs: 20, subRequests: 0 },
      mainModule: 'app.js',
      modules: {
        'app.js': `import { DurableObject } from 'cloudflare:workers';
        export class App extends DurableObject {
          async fetch() {
            this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter(n INTEGER)');
            this.ctx.storage.sql.exec('INSERT INTO counter VALUES (1)');
            let denied = false; try { await fetch('https://example.com/'); } catch { denied = true; }
            return Response.json({ n: this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM counter').one().n, denied });
          }
        }`,
      },
    }));
    return this.ctx.facets
      .get('appDB', () => ({ class: worker.getDurableObjectClass('App') }))
      .fetch('https://app.invalid/');
  }
}
export default {
  fetch(request: Request, env: Env) {
    return env.CANARY.getByName(new URL(request.url).pathname).fetch(request);
  },
};
