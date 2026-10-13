import { short } from '../../lib/api';
import type { WorkingBranch } from './workingBranchView';

export function WorkingBranchNotice({
  branch,
  canonical,
}: {
  branch: WorkingBranch;
  canonical: string;
}) {
  return (
    <aside className="working-branch-panel">
      <h4>Continue on working branch {branch.id}</h4>
      <p>
        Starting source: <code>{short(branch.working_commit)}</code> · working revision, version{' '}
        {branch.version}.
      </p>
      <p>
        Canonical source remains <code>{short(canonical)}</code>. This approval starts work;
        publication requires a separate recorded decision.
      </p>
      <p className="subtle">
        The server checks this exact working head before starting. Refresh and reopen the brief if
        the branch advances.
      </p>
    </aside>
  );
}
