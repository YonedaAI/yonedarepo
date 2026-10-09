import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { RunEvidenceBoundary } from './RunEvidenceBoundary';

const labels = {
  results: 'Results',
  activity: 'Agent activity',
  context: 'Context usage',
  details: 'Run details',
};
export type RunTab = keyof typeof labels;
const tabs = Object.keys(labels) as RunTab[];

export function RunTabs({
  active,
  onSelect,
  children,
}: {
  active: RunTab;
  onSelect: (tab: RunTab) => void;
  children: (tab: RunTab) => ReactNode;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [visited, setVisited] = useState<RunTab[]>([active]);
  useEffect(() => {
    setVisited((current) => (current.includes(active) ? current : [...current, active]));
  }, [active]);
  function navigate(event: KeyboardEvent, index: number) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    onSelect(tabs[next]);
    buttons.current[next]?.focus();
  }
  return (
    <>
      <div className="run-tabs" role="tablist" aria-label="Run evidence">
        {tabs.map((tab, index) => (
          <button
            key={tab}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`run-tab-${tab}`}
            aria-controls={`run-panel-${tab}`}
            aria-selected={active === tab}
            tabIndex={active === tab ? 0 : -1}
            onClick={() => onSelect(tab)}
            onKeyDown={(event) => navigate(event, index)}
          >
            {labels[tab]}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <section
          key={tab}
          className="run-tab-panel"
          role="tabpanel"
          id={`run-panel-${tab}`}
          aria-labelledby={`run-tab-${tab}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: A tab panel must remain focusable when its evidence is empty or loading.
          tabIndex={0}
          hidden={active !== tab}
        >
          {(visited.includes(tab) || active === tab) && (
            <RunEvidenceBoundary label={labels[tab].toLowerCase()}>
              {children(tab)}
            </RunEvidenceBoundary>
          )}
        </section>
      ))}
    </>
  );
}
