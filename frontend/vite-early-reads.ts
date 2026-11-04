import type { Plugin } from 'vite';
import { reservedHandlesSchema } from '../shared/contracts/reserved-handles';
import { PERSONAL_WORKSPACE_HINT } from './src/features/site/signedInHint';
import { beginEarlyReads } from './src/lib/earlyReads';
import { plainNamedOverview } from './src/lib/overviewEntryRoute';

/** A dependency-free head script starts authorized GETs before the app bundle arrives. */
export function earlyReads(enabled: boolean): Plugin {
  return {
    name: 'yoneda-early-reads',
    transformIndexHtml: {
      order: 'pre',
      handler: () => enabled ? [{
        tag: 'script',
        attrs: { 'data-yoneda-early-reads': '' },
        children: `(${beginEarlyReads.toString()})(window,${JSON.stringify(reservedHandlesSchema.enum)},(${plainNamedOverview.toString()}),${JSON.stringify(PERSONAL_WORKSPACE_HINT)});`,
        injectTo: 'head-prepend',
      }] : [],
    },
  };
}
