import type { AppBundle, AppManifest, RunnerEnv, TrustedApp } from './contracts';

const digestPattern = /^[a-f0-9]{64}$/;
export function validateDescriptor(app: TrustedApp) {
  if (
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(app.app_id) ||
    !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(app.revision) ||
    !digestPattern.test(app.policy_digest) ||
    !digestPattern.test(app.bundle_digest) ||
    !['preview', 'published'].includes(app.mode) ||
    !Number.isSafeInteger(app.generation) ||
    app.generation < 0
  )
    throw new Error('Invalid trusted application descriptor');
}
const pathValid = (path: string) =>
  path.length <= 4096 &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  path
    .split('/')
    .every(
      (p) =>
        p !== '' && p !== '.' && p !== '..' && p !== 'node_modules' && !p.startsWith('_yoneda_'),
    );
const single = (sql: string) =>
  typeof sql === 'string' &&
  sql.length > 0 &&
  sql.length <= 16384 &&
  !/[;\0]|--|\/\*|_yoneda_/i.test(sql);
export function validateManifest(m: AppManifest) {
  if (
    m?.version !== 1 ||
    !pathValid(m.entrypoint) ||
    !/\.(m?js)$/.test(m.entrypoint) ||
    !/^[A-Za-z_][A-Za-z_0-9]{0,63}$/.test(m.export_name) ||
    !Array.isArray(m.migrations) ||
    !m.migrations.length ||
    m.migrations.length > 32 ||
    !Array.isArray(m.seed) ||
    m.seed.length > 128
  )
    throw new Error('Invalid application manifest');
  m.migrations.forEach((step, index) => {
    if (
      step.version !== index + 1 ||
      !Array.isArray(step.sql) ||
      !step.sql.length ||
      step.sql.length > 32 ||
      step.sql.some(
        (sql) =>
          !single(sql) ||
          !/^(CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\s|ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN\s)/i.test(
            sql.trim(),
          ),
      )
    )
      throw new Error('Application migration must be ordered and additive');
  });
  if (m.seed.some((sql) => !single(sql) || !/^INSERT INTO /i.test(sql.trim())))
    throw new Error('Invalid application seed');
}
export async function sha(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export async function readBundle(env: RunnerEnv, app: TrustedApp): Promise<AppBundle> {
  validateDescriptor(app);
  const object = await env.OBJECTS.get(`sha256/${app.bundle_digest}`);
  if (!object || object.size > 2 * 1024 * 1024)
    throw new Error('Missing or oversized application bundle');
  const text = await object.text();
  if ((await sha(text)) !== app.bundle_digest)
    throw new Error('Application bundle digest mismatch');
  const bundle: AppBundle = JSON.parse(text);
  if (
    bundle.version !== 1 ||
    bundle.revision !== app.revision ||
    bundle.policy_digest !== app.policy_digest
  )
    throw new Error('Application bundle authority binding mismatch');
  validateManifest(bundle.manifest);
  if (!bundle.modules || typeof bundle.modules !== 'object' || Array.isArray(bundle.modules))
    throw new Error('Invalid app modules');
  const modules = Object.entries(bundle.modules);
  if (
    !modules.length ||
    modules.length > 500 ||
    modules.some(
      ([path, code]) => !pathValid(path) || !/\.(m?js)$/.test(path) || typeof code !== 'string',
    ) ||
    !bundle.modules[bundle.manifest.entrypoint.split('/').at(-1) ?? '']
  )
    throw new Error('Invalid app modules');
  return bundle;
}
