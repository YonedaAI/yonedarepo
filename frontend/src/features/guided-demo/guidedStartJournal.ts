import { guidedProfileId, guidedSteps, type StartGuidedStep } from '../../../../shared/guided-runs';
import type { GuideStore } from './guidedNavigation';
export interface GuidedStartJournal {
  read(): StartGuidedStep | undefined;
  save(request: StartGuidedStep): void;
  clear(): void;
}
export function guidedStartJournal(
  repo: string,
  session: string,
  step: string,
  store: GuideStore,
): GuidedStartJournal {
  const key = `yoneda-guide-start-v1:${repo}:${session}:${step}`;
  return {
    read() {
      const raw = store.getItem(key);
      if (!raw) return;
      const value = JSON.parse(raw);
      if (!value) return;
      if (
        value.profile_id !== guidedProfileId ||
        value.session_id !== session ||
        value.step_id !== step ||
        !guidedSteps.some((item) => item.id === step) ||
        typeof value.request_id !== 'string' ||
        !value.request_id ||
        typeof value.expected_commit !== 'string' ||
        !Number.isSafeInteger(value.expected_version) ||
        value.expected_version < 0 ||
        Object.keys(value).length !== 6
      )
        throw new Error(
          'The saved guide start could not be verified. Refresh this guide before continuing.',
        );
      return value as StartGuidedStep;
    },
    save(request) {
      store.setItem(key, JSON.stringify(request));
    },
    clear() {
      store.setItem(key, '');
    },
  };
}
