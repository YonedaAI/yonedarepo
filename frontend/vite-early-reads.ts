import type { Plugin } from 'vite';
import { reservedHandlesSchema } from '../shared/contracts/reserved-handles';
import { SIGNUPS_SEEN_KEY } from './src/features/admin/adminSeen';
import { earlyPageReads } from './src/lib/earlyPageReads';
import { beginEarlyReads } from './src/lib/earlyReads';
import { plainNamedOverview } from './src/lib/overviewEntryRoute';

/** The self-contained script shipped in HTML, also executed by its contract test. */
export function earlyReadScript() {
  return `(${beginEarlyReads.toString()})(window,${JSON.stringify(reservedHandlesSchema.enum)},(${plainNamedOverview.toString()}),(${earlyPageReads.toString()}),${JSON.stringify(SIGNUPS_SEEN_KEY)});`;
}

/** A dependency-free head script starts authorized GETs before the app bundle arrives. */
export function earlyReads(enabled: boolean): Plugin {
  return {
    name: 'yoneda-early-reads',
    transformIndexHtml: {
      order: 'pre',
      handler: () => enabled ? [{
        tag: 'script',
        attrs: { 'data-yoneda-early-reads': '' },
        children: earlyReadScript(),
        injectTo: 'head-prepend',
      }] : [],
    },
  };
}
