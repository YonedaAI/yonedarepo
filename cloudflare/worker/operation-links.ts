import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  OperationOutcome,
  OperationSource,
  OperationTraffic,
} from '../../shared/operation-metrics';

export type OperationLink = {
  span: string;
  source: OperationSource;
  traffic: OperationTraffic;
  origin: string;
  selected: boolean;
  fullUntil?: string;
  outcome?: OperationOutcome;
};
export const operationLinks = new AsyncLocalStorage<OperationLink | undefined>();

/** Only our outgoing binding/DO calls add these. They are never authentication. */
export function operationHeaders(): Record<string, string> {
  const link = operationLinks.getStore();
  return link
    ? {
        'x-yoneda-parent-span': link.span,
        'x-yoneda-origin': link.origin,
        'x-yoneda-source': link.source,
        'x-yoneda-traffic': link.traffic,
        'x-yoneda-capture': link.selected ? '1' : '0',
        'x-yoneda-capture-until': link.fullUntil ?? '',
      }
    : {};
}
