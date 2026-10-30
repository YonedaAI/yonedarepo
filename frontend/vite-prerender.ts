// Production build step: renders each public site page (src/prerender.tsx, through Vite's
// own server-side module loader) into a copy of the built index.html, as
// `_site/<path>.html` (`_site/home.html` for `/`), and writes the route manifest
// `_site/routes.json`. The front Worker (website-metadata.ts) serves a page's copy at its
// clean address and fills its head from the manifest; index.html itself stays the app's
// empty shell, so app paths never show site markup.
import react from '@vitejs/plugin-react';
import { createServer, type Plugin } from 'vite';
import type { SeoManifest } from './src/features/site/seo';

type Prerender = {
  seoManifest(): SeoManifest;
  renderSitePage(path: string): Promise<string>;
};

const ROOT = '<div id="root"></div>';
// `/` is the app for a visitor signed in last time (siteRoute.ts SIGNED_IN_HINT): drop the
// home markup before the first paint instead of flashing it.
const SIGNED_IN_GUARD =
  "<script>try{if(localStorage.getItem('yoneda.signedIn')==='1')document.getElementById('root').textContent=''}catch(e){}</script>";

/** The asset a site page's copy is served from (front Worker: `/_site/<path>`). */
export const prerenderedFile = (path: string) => `_site${path === '/' ? '/home' : path}.html`;

export function prerenderSite(): Plugin {
  let root = '';
  return {
    name: 'yoneda-prerender-site',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      root = config.root;
    },
    async generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      const template = index?.type === 'asset' ? String(index.source) : '';
      if (!template.includes(ROOT)) this.error('index.html has no empty #root to prerender into');
      const server = await createServer({
        configFile: false,
        root,
        logLevel: 'error',
        appType: 'custom',
        plugins: [react()],
        server: { middlewareMode: true, hmr: false, ws: false },
      });
      try {
        const site = (await server.ssrLoadModule('/src/prerender.tsx')) as Prerender;
        const manifest = site.seoManifest();
        for (const route of manifest.routes.filter((r) => r.sitemap)) {
          const markup = await site.renderSitePage(route.path);
          const guard = route.path === '/' ? SIGNED_IN_GUARD : '';
          this.emitFile({
            type: 'asset',
            fileName: prerenderedFile(route.path),
            source: template.replace(ROOT, `<div id="root">${markup}</div>${guard}`),
          });
        }
        this.emitFile({
          type: 'asset',
          fileName: '_site/routes.json',
          source: JSON.stringify(manifest),
        });
      } finally {
        await server.close();
      }
    },
  };
}
