import { useEffect, useState } from 'react';
import { api, short } from '../../lib/api';
import type { Snapshot } from '../../lib/types';
import { SiteLink } from '../exploration/SiteLink';
import {
  type CampaignStatus,
  type CheckedCampaignResult,
  campaignConfigured,
  campaignEnabled,
  checkedCampaignResult,
} from './campaignView';
import { LegacyReviewerTrial } from './LegacyReviewerTrial';
import { ReviewerCampaignActions } from './ReviewerCampaignActions';

export function ReviewerTrial({
  snapshot,
  onChange,
  onError,
}: {
  snapshot: Snapshot;
  onChange: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [retry, setRetry] = useState(0);
  const [result, setState] = useState<{
    key: number;
    enabled: boolean;
    configured: boolean;
    checked: CheckedCampaignResult | null;
    error: string;
    loading: boolean;
    status?: CampaignStatus;
  }>({ key: 0, enabled: false, configured: false, checked: null, error: '', loading: true });
  useEffect(() => {
    let current = true;
    let pending = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = async (foreground = true) => {
      if (!current || pending) return;
      pending = true;
      let enabled = false;
      let configured = false;
      if (foreground)
        setState((previous) => ({ ...previous, key: retry, loading: true, error: '' }));
      try {
        const status = await api<unknown>('reviewer/campaign');
        if (!current) return;
        configured = campaignConfigured(status);
        if (!campaignEnabled(status)) {
          setState({
            key: retry,
            enabled: false,
            configured,
            checked: null,
            error: '',
            loading: false,
          });
          return;
        }
        enabled = true;
        const value =
          'latest_checked' in status
            ? status.latest_checked
            : await api<unknown>('reviewer/campaign/checked');
        if (!current) return;
        const checked = checkedCampaignResult(value, status.approval.entry.repo_id);
        if (value !== null && !checked)
          throw new Error('The checked campaign result could not be verified.');
        setState({
          key: retry,
          enabled: true,
          configured,
          checked,
          error: '',
          loading: false,
          status,
        });
        if (status.active_trial && !timer) timer = setInterval(() => void load(false), 5000);
        if (!status.active_trial && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      } catch (failure) {
        if (current)
          setState({
            key: retry,
            enabled,
            configured,
            checked: null,
            error: (failure as Error).message,
            loading: false,
          });
      } finally {
        pending = false;
      }
    };
    void load();
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [retry]);
  const state =
    result.key === retry
      ? result
      : {
          enabled: false,
          configured: false,
          checked: null,
          error: '',
          loading: true,
          status: undefined,
        };
  return (
    <>
      <section className="workspace-notice" aria-label="Reviewer campaign">
        <div>
          <strong>
            {state.enabled
              ? 'Review the checked app'
              : state.configured
                ? 'Reviewer campaign preparing'
                : 'Reviewer campaign'}
          </strong>
          <p>
            {state.loading
              ? 'Checking campaign availability…'
              : state.enabled
                ? 'Inspect the fullstack event-booking outcome, behavior checks and recorded context. Viewing results starts no paid work.'
                : state.configured
                  ? 'The new app campaign is being prepared. Historical results remain readable; paid trial actions are disabled until the campaign is enabled.'
                  : 'The new reviewer campaign is not enabled. Historical results remain readable; live trial actions are disabled.'}
          </p>
          {state.checked && (
            <p>
              Checked revision <code>{short(state.checked.revision.commit)}</code> · publication is
              a separate recorded decision.
            </p>
          )}
          {state.checked && (
            <a
              href={`/?repo=${encodeURIComponent(state.checked.repo_id)}&run=${encodeURIComponent(state.checked.run_id)}`}
            >
              Review checked app result
            </a>
          )}
          {state.checked?.evaluation_id && (
            <SiteLink repo={state.checked.repo_id} evaluation={state.checked.evaluation_id} />
          )}
          {state.enabled && !state.checked && <p>No checked final app result is available yet.</p>}
          {state.error && <p role="alert">Could not load campaign evidence: {state.error}</p>}
          <code>node tools/reviewer.mjs --checked</code>
        </div>
        <button
          type="button"
          className="quiet"
          disabled={state.loading}
          onClick={() => setRetry((value) => value + 1)}
        >
          {state.error ? 'Retry campaign status' : 'Refresh campaign status'}
        </button>
      </section>
      {!state.loading && !state.configured && (
        <LegacyReviewerTrial
          snapshot={snapshot}
          onChange={onChange}
          onError={onError}
          live={false}
        />
      )}
      {!state.loading && !state.error && state.enabled && state.status && (
        <ReviewerCampaignActions
          status={state.status}
          snapshot={snapshot}
          onChange={onChange}
          onError={onError}
          onRefresh={() => setRetry((value) => value + 1)}
        />
      )}
    </>
  );
}
