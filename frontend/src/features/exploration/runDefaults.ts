import type { Snapshot } from '../../lib/types';
import { type AdaptiveAgentDraft, automaticAgent } from './adaptiveDraft';
import { publishedRun } from './publishedRun';

export function hasPublishedWebsite(snapshot: Snapshot): boolean {
  return !!snapshot.repository.site;
}

export function hasPublishedWork(snapshot: Snapshot): boolean {
  return hasPublishedWebsite(snapshot) || !!publishedRun(snapshot);
}

export function defaultRunAgents(_snapshot: Snapshot): AdaptiveAgentDraft[] {
  return [automaticAgent()];
}
