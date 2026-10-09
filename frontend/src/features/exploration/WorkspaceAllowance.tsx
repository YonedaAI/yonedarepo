import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { formatBudgetUsd } from './modelBudgets';

export function WorkspaceAllowance() {
  const [allowance, setAllowance] = useState<{ limit: number; charged: number }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    void api<{ limit: number; charged: number }>('budget')
      .then((value) => {
        if (
          !Number.isSafeInteger(value.limit) ||
          !Number.isSafeInteger(value.charged) ||
          value.limit < 0 ||
          value.charged < 0
        ) {
          throw new Error('Invalid allowance');
        }
        if (current) setAllowance(value);
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
    };
  }, []);
  return (
    <aside className="workspace-allowance" aria-label="Claude workspace allowance">
      <strong>Claude workspace</strong>
      {allowance ? (
        <p>
          {formatBudgetUsd(Math.max(0, allowance.limit - allowance.charged))} left of{' '}
          {formatBudgetUsd(allowance.limit)}
        </p>
      ) : error ? (
        <p>Current remaining allowance is unavailable.</p>
      ) : (
        <p role="status">Loading workspace allowance…</p>
      )}
      <small>Separate $20 operator ceiling; run budgets cannot raise it.</small>
    </aside>
  );
}
