// Contributions, last 30 days: one column per local day, one row per hour of day, a bubble
// sized by the commits made or pushed in that hour. The SVG is described for assistive
// technology by a summary; each bubble names its day, hour and count on hover.
import { useEffect, useRef } from 'react';
import type { ContributionGrid } from './homeModel';
import { bubbleRadius } from './homeModel';

const COLUMN = 24;
const ROW = 7;
const LEFT = 44;
const TOP = 8;
const BOTTOM = 22;
const RIGHT = 18;
const HOURS = [0, 6, 12, 18, 23];

const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

export function ContributionChart({ grid }: { grid: ContributionGrid }) {
  const frame = useRef<HTMLDivElement>(null);
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
    <div className="contribution-chart" ref={frame}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
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
            <text key={day.key} className="chart-axis" x={x(i)} y={height - 6} textAnchor="middle">
              {day.label}
            </text>
          ) : null,
        )}
        {grid.cells.map((cell) => (
          <circle
            key={`${cell.day}:${cell.hour}`}
            className="chart-bubble"
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
  );
}
