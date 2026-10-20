import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
// Module cache per checkout: worktrees share one symlinked node_modules, its default home.
export default defineConfig({test:{fsModuleCachePath: fileURLToPath(new URL('../../.vitest/module-cache', import.meta.url)),include:['frontend/src/**/*.test.ts','tests/frontend/**/*.test.ts'],environment:'node'}});
