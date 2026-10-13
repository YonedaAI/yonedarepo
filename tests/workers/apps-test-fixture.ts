import { env } from 'cloudflare:test';
import type { AppBundle, TrustedApp } from '../../cloudflare/apps/contracts';

const bindings = env as unknown as { OBJECTS: R2Bucket };
export const manifest: AppBundle['manifest'] = {
  version: 1,
  entrypoint: 'worker.js',
  export_name: 'App',
  migrations: [{ version: 1, sql: ['CREATE TABLE notes (value TEXT)'] }],
  seed: ["INSERT INTO notes VALUES ('seed')"],
};
const moduleCode = (tag: string) => `import { DurableObject } from 'cloudflare:workers';
export class App extends DurableObject {
 async fetch(r) {
  if (new URL(r.url).pathname === '/headers') return Response.json({headers:Object.fromEntries(r.headers),url:r.url},{headers:{'Set-Cookie':'untrusted=value'}});
  if (new URL(r.url).pathname === '/outbound') { let denied=false;try{await fetch('https://example.com/')}catch{denied=true}return Response.json({denied,env:Object.keys(this.env)}); }
  if(r.method==='POST') this.ctx.storage.sql.exec('INSERT INTO notes VALUES (?)', await r.text());
  return Response.json({tag:${JSON.stringify(tag)},values:this.ctx.storage.sql.exec('SELECT value FROM notes').toArray().map(x=>x.value)});
 }
}`;
export async function install(
  appId: string,
  mode: TrustedApp['mode'] = 'preview',
  generation = 1,
  tag = 'v1',
  profile = manifest,
): Promise<TrustedApp> {
  const bundle: AppBundle = {
    version: 1,
    revision: (tag === 'v1' ? 'a' : 'b').repeat(40),
    policy_digest: 'c'.repeat(64),
    manifest: profile,
    modules: { 'worker.js': moduleCode(tag) },
  };
  const text = JSON.stringify(bundle);
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  await bindings.OBJECTS.put(`sha256/${digest}`, text);
  return {
    app_id: appId,
    mode,
    generation,
    revision: bundle.revision,
    policy_digest: bundle.policy_digest,
    bundle_digest: digest,
  };
}
