import { SourceApiError } from './sourceApi';

export type VersionEntry = {
  version: number;
  kind: string;
  committed_at_ms: number;
  refname?: string;
  new?: string;
  actor?: string;
  chain?: string;
  paths?: { path: string; op: string }[];
};
export type VersionPage = {
  version: number;
  history_chain: string | null;
  entries: VersionEntry[];
  next_before: number | null;
  legacy?: boolean;
};
export const VERSION_PAGE = 50;
export const versionsChanged = () =>
  new SourceApiError('ACTIVITY_CHANGED', 'Versions changed. Refresh to continue.', 409);
