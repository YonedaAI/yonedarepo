export interface CampaignStatus {
  campaign: { id: string; version: number; enabled: boolean };
  approval: { entry: { repo_id: string } };
  active_trial?: string | null;
  active_trial_state?: 'reserved' | 'running' | null;
  budget?: { limit_microusd: number; charged_microusd: number };
  latest_checked?: unknown;
}
export interface CheckedCampaignResult {
  repo_id: string;
  run_id: string;
  candidate_id: string;
  revision: { repository: string; commit: string };
  evaluation_id?: string;
}
export function campaignConfigured(value: unknown): value is CampaignStatus {
  if (!value || typeof value !== 'object') return false;
  const data = value as CampaignStatus;
  return (
    typeof data.campaign?.enabled === 'boolean' &&
    Number.isSafeInteger(data.campaign.version) &&
    typeof data.campaign.id === 'string' &&
    typeof data.approval?.entry?.repo_id === 'string'
  );
}
export function campaignEnabled(value: unknown): value is CampaignStatus {
  return campaignConfigured(value) && value.campaign.enabled === true;
}
export function checkedCampaignResult(value: unknown, repo: string): CheckedCampaignResult | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as CheckedCampaignResult;
  return data.repo_id === repo &&
    typeof data.run_id === 'string' &&
    data.run_id &&
    typeof data.candidate_id === 'string' &&
    data.candidate_id &&
    typeof data.revision?.commit === 'string' &&
    data.revision.commit &&
    typeof data.revision.repository === 'string'
    ? data
    : null;
}
