// Contributions, last 30 days: one column per local day, one row per hour of day, a bubble
// sized by the commits made or pushed in that hour. The SVG is described for assistive
// technology by a summary; each bubble names its day, hour and count on hover.
import { useEffect, useRef, useState } from 'react';
import { ContributionDetails } from './ContributionDetails';
import type { ContributionCell, ContributionGrid } from './homeModel';
import { bubbleRadius } from './homeModel';
import type { Navigate } from './useRoute';

const COLUMN = 24;
const ROW = 7;
const LEFT = 44;
const TOP = 8;
const BOTTOM = 22;
const RIGHT = 18;
const HOURS = [0, 6, 12, 18, 23];

const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

export function ContributionChart({
  grid,
  snapshots = {},
  onRefresh,
  navigate,
}: {
  grid: ContributionGrid;
  snapshots?: Record<string, string>;
  onRefresh: () => void;
  navigate: Navigate;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const trigger = useRef<SVGCircleElement | null>(null);
  const [selected, setSelected] = useState<{
    cell: ContributionCell;
    title: string;
    snapshots: Record<string, string>;
  } | null>(null);
  const open = (cell: ContributionCell, element: SVGCircleElement) => {
    trigger.current = element;
    setSelected({
      cell: { ...cell, buckets: [...cell.buckets] },
      title: `${grid.days[cell.day]?.label}, ${hourLabel(cell.hour)}`,
      snapshots: { ...snapshots },
    });
  };
  useEffect(() => {
    if (!selected && trigger.current) {
      if (trigger.current.isConnected) trigger.current.focus();
      else frame.current?.querySelector<SVGCircleElement>('.chart-bubble')?.focus();
    }
  }, [selected]);
  // Where the chart scrolls (a phone), it opens on today, the right end.
  useEffect(() => {
    if (frame.current) frame.current.scrollLeft = frame.current.scrollWidth;
  }, []);
  const width = LEFT + grid.days.length * COLUMN + RIGHT;
  const height = TOP + 24 * ROW + BOTTOM;
  const x = (day: number) => LEFT + day * COLUMN + COLUMN / 2;
  const y = (hour: number) => TOP + hour * ROW + ROW / 2;
  // A wide, short chart: neighbouring hours may overlap; the fill is translucent.
  const largest = ROW * 1.4;
  const busiest = grid.cells.reduce<(typeof grid.cells)[number] | undefined>(
    (top, c) => (!top || c.count > top.count ? c : top),
    undefined,
  );
  const summary = busiest
    ? `${grid.total} commits over ${grid.days.length} days; the busiest hour was ${hourLabel(busiest.hour)} on ${grid.days[busiest.day]?.label} with ${busiest.count}.`
    : `No commits in the last ${grid.days.length} days.`;
  return (
    <>
      <div className="contribution-chart" ref={frame}>
        {/* biome-ignore lint/a11y/useSemanticElements: native HTML fieldsets cannot group interactive SVG children. */}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label={summary}
          preserveAspectRatio="xMinYMin meet"
        >
          {HOURS.map((hour) => (
            <g key={hour}>
              <line className="chart-grid" x1={LEFT} x2={width} y1={y(hour)} y2={y(hour)} />
              <text className="chart-axis" x={LEFT - 6} y={y(hour) + 3} textAnchor="end">
                {String(hour).padStart(2, '0')}
              </text>
            </g>
          ))}
          {grid.days.map((day, i) =>
            i % 7 === (grid.days.length - 1) % 7 ? (
              <text
                key={day.key}
                className="chart-axis"
                x={x(i)}
                y={height - 6}
                textAnchor="middle"
              >
                {day.label}
              </text>
            ) : null,
          )}
          {grid.cells.map((cell) => (
            // biome-ignore lint/a11y/useSemanticElements: SVG circles need explicit button semantics and keyboard activation.
            <circle
              key={`${cell.day}:${cell.hour}`}
              className="chart-bubble"
              role="button"
              tabIndex={0}
              aria-label={`${grid.days[cell.day]?.label}, ${hourLabel(cell.hour)}: ${cell.count} ${cell.count === 1 ? 'commit' : 'commits'}`}
              aria-haspopup="dialog"
              onClick={(event) => {
                open(cell, event.currentTarget);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  open(cell, event.currentTarget);
                }
              }}
              cx={x(cell.day)}
              cy={y(cell.hour)}
              r={bubbleRadius(cell.count, grid.max, largest)}
            >
              <title>
                {`${grid.days[cell.day]?.label}, ${hourLabel(cell.hour)}: ${cell.count} ${cell.count === 1 ? 'commit' : 'commits'}`}
              </title>
            </circle>
          ))}
        </svg>
      </div>
      {selected && (
        <ContributionDetails
          title={selected.title}
          count={selected.cell.count}
          buckets={selected.cell.buckets}
          snapshots={selected.snapshots}
          onClose={() => setSelected(null)}
          onRefresh={onRefresh}
          navigate={navigate}
        />
      )}
    </>
  );
}
