// The Landing's cockpit instruments as three dials, each read the way its subject is: Risk on
// a banded gauge, Slop as a needle with its last pushes behind it, and Intent drift as a course
// deviation indicator. The dials are decorative: the reading beside each is the real text.
import type { ReactNode } from 'react';
import { DIALS, type Dial } from './flightPath';

const C = 60;
const round = (n: number) => Math.round(n * 100) / 100;

/** A point on a circle round the dial's centre; 0° is 3 o'clock, angles run clockwise. */
function at(radius: number, degrees: number) {
  const a = (degrees * Math.PI) / 180;
  return { x: round(C + radius * Math.cos(a)), y: round(C + radius * Math.sin(a)) };
}

function arc(radius: number, from: number, to: number) {
  const a = at(radius, from);
  const b = at(radius, to);
  return `M${a.x} ${a.y} A${radius} ${radius} 0 ${to - from > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
}

/** The sweep shared by the gauges: seven o'clock round to five o'clock. */
const START = 135;
const SWEEP = 270;
const reading = (share: number) => START + SWEEP * share;

type TickRing = { radius: number; count: number; from?: number; sweep?: number };

function Ticks({ radius, count, from = START, sweep = SWEEP }: TickRing) {
  const closed = sweep === 360;
  const steps = Array.from({ length: closed ? count : count + 1 }, (_, n) => n);
  return (
    <>
      {steps.map((n) => {
        const angle = from + (sweep / count) * n;
        const outer = at(radius, angle);
        const inner = at(radius - (n % 5 === 0 ? 7 : 4), angle);
        return (
          <line
            key={n}
            className="fp-dial-tick"
            x1={outer.x}
            y1={outer.y}
            x2={inner.x}
            y2={inner.y}
          />
        );
      })}
    </>
  );
}

function Needle({ angle, ghost }: { angle: number; ghost?: number }) {
  const tip = at(38, angle);
  const tail = at(ghost ? 6 : -10, angle);
  return (
    <line
      className="fp-dial-needle"
      x1={tail.x}
      y1={tail.y}
      x2={tip.x}
      y2={tip.y}
      opacity={ghost ?? 1}
    />
  );
}

const Hub = () => <circle className="fp-dial-hub" cx={C} cy={C} r="4.5" />;

const BANDS = [
  { letter: 'L', share: 0.24 },
  { letter: 'M', share: 0.5 },
  { letter: 'H', share: 0.76 },
];

const ENDS = [
  { letter: 'L', share: 0 },
  { letter: 'H', share: 1 },
];

function Letters({ marks, radius }: { marks: typeof BANDS; radius: number }) {
  return marks.map(({ letter, share }) => {
    const { x, y } = at(radius, reading(share));
    return (
      <text key={letter} className="fp-dial-letter" x={x} y={y + 3}>
        {letter}
      </text>
    );
  });
}

function RiskFace() {
  return (
    <>
      <path className="fp-band fp-band-good" d={arc(50, START, reading(1 / 3) - 2)} />
      <path className="fp-band fp-band-warn" d={arc(50, reading(1 / 3) + 2, reading(2 / 3) - 2)} />
      <path className="fp-band fp-band-bad" d={arc(50, reading(2 / 3) + 2, START + SWEEP)} />
      <Ticks radius={44} count={15} />
      <Letters marks={BANDS} radius={27} />
      <Needle angle={reading(0.09)} />
      <Hub />
    </>
  );
}

/** The last five pushes: the earlier needles fade behind the current one. */
function SlopFace() {
  return (
    <>
      <path className="fp-dial-scale" d={arc(50, START, START + SWEEP)} />
      <Ticks radius={50} count={15} />
      <Letters marks={ENDS} radius={32} />
      {[0.72, 0.58, 0.42, 0.24].map((share, n) => (
        <Needle key={share} angle={reading(share)} ghost={0.16 + n * 0.1} />
      ))}
      <Needle angle={reading(0.09)} />
      <Hub />
    </>
  );
}

/** A course deviation indicator: the bar sits on the centre mark when the work is on course. */
function DriftFace() {
  return (
    <>
      <Ticks radius={52} count={60} from={-90} sweep={360} />
      <path className="fp-dial-index" d="M60 13 L65 23 L55 23 Z" />
      {[-30, -15, 15, 30].map((x) => (
        <circle key={x} className="fp-dial-dot" cx={C + x} cy={C} r="3" />
      ))}
      <circle className="fp-dial-centre" cx={C} cy={C} r="6.5" />
      <line className="fp-dial-bar" x1={C + 3} y1="32" x2={C + 3} y2="88" />
    </>
  );
}

const FACES: Record<Dial['id'], ReactNode> = {
  risk: <RiskFace />,
  slop: <SlopFace />,
  drift: <DriftFace />,
};

export function FlightInstruments() {
  return (
    <ul className="fp-dials">
      {DIALS.map((dial) => (
        <li key={dial.id}>
          <svg className="fp-dial" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
            <circle className="fp-dial-face" cx={C} cy={C} r="59" />
            <circle className="fp-dial-rim" cx={C} cy={C} r="56.5" />
            {FACES[dial.id]}
          </svg>
          <div>
            <p className="fp-dial-name">{dial.name}</p>
            <p className="fp-dial-value">{dial.value}</p>
            <p className="fp-dial-detail">{dial.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
