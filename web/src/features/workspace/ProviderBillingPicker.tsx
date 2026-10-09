export type ProviderRouting =
  | { plan: 'api_credits' }
  | {
      plan: 'token_plan';
      region: 'cn' | 'sgp' | 'ams';
    };

const regions: Record<string, string> = {
  cn: 'China',
  sgp: 'Singapore',
  ams: 'Europe (Amsterdam)',
};
export function billingLabel(routing?: ProviderRouting | null) {
  return routing?.plan === 'token_plan' ? `Token Plan · ${regions[routing.region]}` : 'API credits';
}

export function ProviderBillingPicker({
  plan,
  region,
  disabled,
  onPlan,
  onRegion,
}: {
  plan: string;
  region: string;
  disabled: boolean;
  onPlan: (value: string) => void;
  onRegion: (value: string) => void;
}) {
  return (
    <div className="provider-billing-picker">
      <label>
        Billing source
        <select value={plan} disabled={disabled} onChange={(event) => onPlan(event.target.value)}>
          <option value="api_credits">API credits</option>
          <option value="token_plan">Token Plan subscription</option>
        </select>
      </label>
      {plan === 'token_plan' && (
        <label>
          Token Plan region
          <select
            value={region}
            required
            disabled={disabled}
            onChange={(event) => onRegion(event.target.value)}
          >
            <option value="" disabled>
              Choose the region from your MiMo Token Plan page
            </option>
            {Object.entries(regions).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <small className="provider-model-note">
        {plan === 'token_plan'
          ? 'Use the dedicated tp- or ttp- key and its assigned region. This uses subscription quota.'
          : 'Use a regular sk- key. This uses your API credits or account balance.'}{' '}
        <a
          href="https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access"
          target="_blank"
          rel="noreferrer"
        >
          MiMo key and endpoint guide
        </a>
      </small>
    </div>
  );
}
