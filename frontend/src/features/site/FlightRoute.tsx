// The route as a drawing: decorative, since the fixes are real text beside it. The flown line
// and the marker share one path and one clock: a stroke drawn through a mask for the line, and
// `offset-path` for the marker. With no motion both simply rest at the end of the route.
import {
  type RouteShape,
  TALL,
  TALL_COMMITS,
  TALL_FIXES,
  WIDE,
  WIDE_COMMITS,
  WIDE_FIXES,
} from './flightPath';

const RULER = Array.from({ length: 50 }, (_, n) => n * 20);

function Flown({ id, shape }: { id: string; shape: RouteShape }) {
  return (
    <>
      <mask id={id} maskUnits="userSpaceOnUse" x="-20" y="-20" width="1300" height="640">
        <path className="fp-reveal" d={shape.flown} pathLength={1} />
      </mask>
      <path className="fp-planned" d={shape.main} />
      <path className="fp-planned fp-planned-loop" d={shape.loop} />
      <g mask={`url(#${id})`}>
        <path className="fp-track" d={shape.taxi} />
        <path className="fp-track" d={shape.main} />
        <path className="fp-track-loop" d={shape.loop} />
      </g>
    </>
  );
}

/** The marker: a small aeroplane seen from above, nose along the route. */
function Marker({ shape, scale }: { shape: RouteShape; scale: number }) {
  return (
    <g className="fp-marker" style={{ offsetPath: `path("${shape.flown}")` }}>
      <path
        transform={`scale(${scale})`}
        d="M17 0 C17 -1.6 14 -2.4 11 -2.4 L4 -2.4 L-4 -14 L-8 -14 L-4.5 -2.4 L-11 -2.4 L-14 -6.5 L-17 -6.5 L-15 0 L-17 6.5 L-14 6.5 L-11 2.4 L-4.5 2.4 L-8 14 L-4 14 L4 2.4 L11 2.4 C14 2.4 17 1.6 17 0 Z"
      />
    </g>
  );
}

const FixMark = ({ x, y, size = 7 }: { x: number; y: number; size?: number }) => (
  <path
    className="fp-fix"
    d={`M${x} ${y - size} L${x + size} ${y + size * 0.72} L${x - size} ${y + size * 0.72} Z`}
  />
);

export function WideRoute() {
  return (
    <svg className="fp-wide" viewBox="0 28 1200 278" aria-hidden="true" focusable="false">
      <line className="fp-ground" x1="-120" y1="270" x2="1000" y2="270" />
      {RULER.map((x) => (
        <line key={x} className="fp-tick" x1={x} y1="270" x2={x} y2={x % 200 === 0 ? 270 : 275} />
      ))}
      {WIDE_FIXES.map(({ x, y }) => (
        <line key={x} className="fp-drop" x1={x} y1={y} x2={x} y2="270" />
      ))}
      <rect className="fp-runway" x="1000" y="270" width="240" height="36" />
      {[277, 283, 289, 295].map((y) => (
        <rect key={y} className="fp-runway-key" x="1008" y={y} width="30" height="3" />
      ))}
      <line className="fp-runway-line" x1="1128" y1="288" x2="1240" y2="288" />
      <Flown id="fp-flown-wide" shape={WIDE} />
      <path className="fp-loop-arrow" d="M746.3 54.2 L761.1 56.7 L758.9 45.9 Z" />
      {WIDE_COMMITS.map(({ x, y }) => (
        <circle key={x} className="fp-commit" cx={x} cy={y} r="3.5" />
      ))}
      {WIDE_FIXES.map(({ x, y }) => (
        <FixMark key={x} x={x} y={y} />
      ))}
      <Marker shape={WIDE} scale={0.9} />
    </svg>
  );
}

export function TallRoute() {
  return (
    <svg className="fp-tall" viewBox="0 0 88 590" aria-hidden="true" focusable="false">
      <line className="fp-ground" x1="10" y1="0" x2="10" y2="470" />
      <rect className="fp-runway" x="0" y="470" width="20" height="120" />
      {[476, 481, 486, 491].map((y) => (
        <rect key={y} className="fp-runway-key" x="3" y={y} width="14" height="2.5" />
      ))}
      <text className="fp-tall-name" x="30" y="536">
        main
      </text>
      {TALL_FIXES.map(({ x, y }) => (
        <line key={y} className="fp-drop" x1={x} y1={y} x2="96" y2={y} />
      ))}
      <Flown id="fp-flown-tall" shape={TALL} />
      <path className="fp-loop-arrow" d="M57.8 286.6 L70.8 285.4 L67.8 295 Z" />
      {TALL_COMMITS.map(({ x, y }) => (
        <circle key={y} className="fp-commit" cx={x} cy={y} r="3" />
      ))}
      {TALL_FIXES.map(({ x, y }) => (
        <FixMark key={y} x={x} y={y} size={6} />
      ))}
      <Marker shape={TALL} scale={0.8} />
    </svg>
  );
}
