import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

export interface WorkspaceAllowanceValue {
  version: number;
  limit_microusd: number;
  charged_microusd: number;
  reserved_microusd: number;
  remaining_microusd: number;
}
export function readAllowance(value: unknown): WorkspaceAllowanceValue | undefined {
  if (!value || typeof value !== 'object') return;
  const result = value as WorkspaceAllowanceValue;
  if (
    ![
      result.version,
      result.limit_microusd,
      result.charged_microusd,
      result.reserved_microusd,
      result.remaining_microusd,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    return;
  return result;
}
export function WorkspaceAllowance() {
  const [value, setValue] = useState<WorkspaceAllowanceValue>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void api<unknown>('workspace/allowance')
      .then((result) => {
        if (!current) return;
        const next = readAllowance(result);
        if (!next) setFailed(true);
        else setValue(next);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, []);
  const usd = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 1_000_000);
  return (
    <small className="workspace-allowance" role="status">
      {value
        ? `${usd(value.remaining_microusd)} of ${usd(value.limit_microusd)} workspace allowance available`
        : failed
          ? 'Workspace allowance unavailable. Limits are checked when you start.'
          : 'Loading workspace allowance…'}
    </small>
  );
}
