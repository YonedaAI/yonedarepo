// Exact native CDN rules: missing chunks and HTML fallbacks must never become immutable.
import type { Plugin } from 'vite';
import { FINGERPRINTED_ASSET } from '../shared/static-assets';

export function staticAssetHeaders(enabled = false): Plugin {
  return {
    name: 'yoneda-static-asset-headers',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (!enabled) return;
      const files = Object.keys(bundle).filter((file) => FINGERPRINTED_ASSET.test(`/${file}`)).sort();
      if (files.length > 100) this.error('Static asset header rules exceed the native 100-rule limit');
      this.emitFile({ type: 'asset', fileName: '_headers', source: files.map((file) =>
        `/${file}\n  Cache-Control: public, max-age=31536000, immutable\n`).join('\n') });
    },
  };
}
