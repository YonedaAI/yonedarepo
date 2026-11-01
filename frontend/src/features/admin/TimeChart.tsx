// The admin pages' one chart: a count over time as bars, hand-written SVG. Each bar's value shows
// on hover, touch or the arrow keys, and every value is also in a list for assistive technology.
// It draws in real pixels, so bars keep their gap and rounding at any width.
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';
import { barLayout, type ChartBar, figure } from './trafficModel';

const HEIGHT = 128;
const HEADROOM = 18;

function useWidth() {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { frame, width };
}

export function TimeChart({
  id,
  title,
  unit,
  bars,
}: {
  id: string;
  title: string;
  /** What is counted ("sign-ups", "views"). */
  unit: string;
  bars: ChartBar[];
}) {
  const { frame, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const last = bars.length - 1;
  const total = bars.reduce((sum, b) => sum + b.value, 0);
  const estimated = bars.some((b) => b.estimated);
  const shown = active === null ? undefined : bars[Math.min(active, last)];
  const reading = (b: ChartBar) => `${figure(b.value, b.estimated)} ${unit}`;
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = Math.floor(((event.clientX - box.left) / box.width) * bars.length);
    setActive(Math.min(Math.max(at, 0), last));
  };
  const key = (event: KeyboardEvent) => {
    const from = active ?? last;
    const to: Record<string, number> = {
      ArrowLeft: Math.max(from - 1, 0),
      ArrowRight: Math.min(from + 1, last),
      Home: 0,
      End: last,
    };
    if (event.key === 'Escape') setActive(null);
    if (!(event.key in to)) return;
    event.preventDefault();
    setActive(to[event.key]);
  };
  const base = HEIGHT - 1;
  const layout = barLayout(
    bars.map((b) => b.value),
    width,
    base - HEADROOM,
  );
  const busiest = Math.max(0, ...bars.map((b) => b.value));
  const side = active === null ? 0 : (active + 0.5) / bars.length;
  return (
    <section className="home-section" aria-labelledby={id}>
      <div className="home-section-head">
        <h2 id={id} className="home-label">
          {title}
        </h2>
        <span className="home-total">
          <span className="stat-number">{figure(total, estimated)}</span> {unit}
        </span>
      </div>
      <div
        ref={frame}
        className="time-chart"
        role="slider"
        tabIndex={0}
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={active ?? last}
        aria-valuetext={
          bars[active ?? last] && `${bars[active ?? last].label}: ${reading(bars[active ?? last])}`
        }
        onPointerMove={point}
        onPointerDown={point}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((was) => was ?? last)}
        onBlur={() => setActive(null)}
        onKeyDown={key}
      >
        <svg width={width} height={HEIGHT} aria-hidden="true">
          <line className="chart-grid" x1={0} x2={width} y1={HEADROOM} y2={HEADROOM} />
          <line className="time-chart-base" x1={0} x2={width} y1={base} y2={base} />
          <text className="chart-axis" x={0} y={HEADROOM - 5}>
            {figure(busiest)}
          </text>
          {layout.map((bar, i) => (
            <path
              key={bars[i].key}
              className={`time-chart-bar${active === i ? ' is-active' : ''}`}
              d={bar.path(base)}
            />
          ))}
        </svg>
        {shown && (
          <div
            className={`time-chart-tip${side < 0.25 ? ' at-start' : side > 0.75 ? ' at-end' : ''}`}
            style={{ left: `${side * 100}%` }}
            aria-hidden="true"
          >
            <strong>{reading(shown)}</strong>
            <span>{shown.label}</span>
          </div>
        )}
      </div>
      <p className="admin-axis" aria-hidden="true">
        <span>{bars[0]?.axis}</span>
        <span>{bars.at(-1)?.axis}</span>
      </p>
      <ol className="sr-only">
        {bars.map((b) => (
          <li key={b.key}>
            {b.label}: {reading(b)}
          </li>
        ))}
      </ol>
    </section>
  );
}
