// The build's local JSX runtime: everything but the local runtime itself is sent to it, and it
// hands on React's own functions.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { LOCAL_RUNTIME, LOCAL_SOURCE, shortJsxCalls } from '../../frontend/vite-jsx-calls';

const runtime = createRequire(new URL('../../frontend/package.json', import.meta.url))('react/jsx-runtime');
const plugin = shortJsxCalls() as {
  apply: string;
  resolveId: (id: string, importer?: string) => string | null;
  load: (id: string) => string | null;
};

describe('the local JSX runtime', () => {
  it('runs in builds only, so the dev server keeps the plain import', () => {
    expect(plugin.apply).toBe('build');
  });

  it('takes every import of the runtime but its own, and no other module', () => {
    expect(plugin.resolveId('react/jsx-runtime', '/src/App.tsx')).toBe(LOCAL_RUNTIME);
    expect(plugin.resolveId('react/jsx-runtime', LOCAL_RUNTIME)).toBeNull();
    expect(plugin.resolveId('react', '/src/App.tsx')).toBeNull();
    expect(plugin.load(LOCAL_RUNTIME)).toBe(LOCAL_SOURCE);
    expect(plugin.load('/src/App.tsx')).toBeNull();
  });

  it('names every function React exports there', () => {
    for (const name of Object.keys(runtime)) expect(LOCAL_SOURCE).toContain(name);
  });
});
