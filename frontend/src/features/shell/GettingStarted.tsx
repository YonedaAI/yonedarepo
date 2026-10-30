// The top bar's Getting started meter: the account's real first steps (a repository, a
// push, the CLI signed in, a recorded session, a landed change), each with where to do it.
// Hidden once every step is done.
import { Check, Circle } from 'lucide-react';
import { useRef } from 'react';
import type { SourceRoute } from '../source-platform/sourceRoute';
import { gettingStarted, type StepId } from './homeModel';
import { useMenuDismiss } from './menuDismiss';
import { linkTo, type Navigate } from './useRoute';

export function GettingStarted({
  steps,
  repo,
  navigate,
  onNew,
  onConnect,
}: {
  steps: Record<StepId, boolean>;
  /** A repository to send the push, session and change steps to. */
  repo?: string;
  navigate: Navigate;
  onNew: () => void;
  onConnect?: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useMenuDismiss(menu);
  const progress = gettingStarted(steps);
  if (progress.complete) return null;
  const close = () => {
    if (menu.current) menu.current.open = false;
  };
  const go: Navigate = (route, options) => {
    close();
    navigate(route, options);
  };
  const where: Partial<Record<StepId, SourceRoute>> = repo
    ? {
        pushed: { view: 'files', repo, path: '', ref: 'main' },
        session: { view: 'agents', repo, section: 'sessions' },
        landed: { view: 'changes', repo },
      }
    : {};
  const action = (id: StepId) => {
    if (id === 'repository')
      return (
        <button
          type="button"
          className="quiet"
          onClick={() => {
            close();
            onNew();
          }}
        >
          New repository
        </button>
      );
    if (id === 'cli' && onConnect)
      return (
        <button
          type="button"
          className="quiet"
          onClick={() => {
            close();
            onConnect();
          }}
        >
          Connect the CLI
        </button>
      );
    const route = where[id];
    return route ? <a {...linkTo(route, go)}>Open</a> : null;
  };
  const percent = Math.round((progress.done / progress.total) * 100);
  return (
    <details
      ref={menu}
      className="getting-started"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
    >
      <summary aria-label={`Getting started: ${progress.done} of ${progress.total} done`}>
        <span className="getting-started-label">Getting started</span>
        <span className="meter" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </span>
        <span className="stat-number" aria-hidden="true">
          {progress.done}/{progress.total}
        </span>
      </summary>
      <div className="getting-started-panel">
        <p>
          <strong>Getting started</strong>
          <small>
            {progress.done} of {progress.total} done
          </small>
        </p>
        <ol>
          {progress.items.map((step) => (
            <li key={step.id} className={step.done ? 'done' : ''}>
              {step.done ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <Circle size={15} aria-hidden="true" />
              )}
              <span>
                {step.label}
                <span className="sr-only">{step.done ? ' (done)' : ''}</span>
              </span>
              {!step.done && action(step.id)}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
