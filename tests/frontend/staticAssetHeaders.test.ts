import { expect, it } from 'vitest';
import { staticAssetHeaders } from '../../frontend/vite-static-cache';

function emitted(enabled: boolean) {
  const output: {fileName: string; source: string}[] = [];
  const plugin = staticAssetHeaders(enabled);
  const hook = plugin.generateBundle as (...args: unknown[]) => void;
  hook.call({ emitFile: (file: {fileName: string; source: string}) => output.push(file), error: (message: string) => {throw new Error(message);} }, {}, {
    'assets/index-Ab12_Cd3.js': {}, 'assets/index-Ab12_Cd3.css': {},
    'assets/logo-Ab12_Cd3.webp': {}, 'assets/logo.svg': {}, 'index.html': {},
    '_site/routes.json': {}, 'assets/missing.js': {},
  });
  return output;
}
it('native CDN headers name only existing fingerprinted build files', () => {
  const [headers] = emitted(true);
  expect(headers.fileName).toBe('_headers');
  expect(headers.source).toContain('/assets/index-Ab12_Cd3.js\n');
  expect(headers.source).toContain('/assets/index-Ab12_Cd3.css\n');
  expect(headers.source).toContain('/assets/logo-Ab12_Cd3.webp\n');
  for(const excluded of ['index.html','routes.json','/assets/*','/assets/logo.svg','/assets/missing.js']) expect(headers.source).not.toContain(excluded);
});
it('the switch off emits no immutable native headers', () => expect(emitted(false)).toEqual([]));
