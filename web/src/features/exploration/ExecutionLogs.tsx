import { ListTree } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';

const LogDialog = lazy(() => import('./ExecutionLogDialog'));

export function ExecutionLogs({
  repo,
  execution,
  onProviders,
}: {
  repo: string;
  execution: Record<string, any>;
  onProviders?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="quiet execution-log-trigger" onClick={() => setOpen(true)}>
        <ListTree size={15} /> View logs
      </button>
      {open && (
        <Suspense fallback={<p role="status">Loading logs…</p>}>
          <LogDialog
            repo={repo}
            execution={execution}
            onClose={() => setOpen(false)}
            onProviders={
              onProviders
                ? () => {
                    setOpen(false);
                    onProviders();
                  }
                : undefined
            }
          />
        </Suspense>
      )}
    </>
  );
}
