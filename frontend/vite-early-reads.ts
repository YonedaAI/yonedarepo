import type { Plugin } from 'vite';
import { reservedHandlesSchema } from '../shared/contracts/reserved-handles';
import { beginEarlyReads } from './src/lib/earlyReads';

/** A dependency-free head script starts authorized GETs before the app bundle arrives. */
export function earlyReads(enabled: boolean): Plugin {
  return {
    name: 'yoneda-early-reads',
    transformIndexHtml: {
      order: 'pre',
      handler: () => enabled ? [{
        tag: 'script',
        attrs: { 'data-yoneda-early-reads': '' },
        children: `(${beginEarlyReads.toString()})(window,${JSON.stringify(reservedHandlesSchema.enum)});`,
        injectTo: 'head-prepend',
      }] : [],
    },
  };
}
