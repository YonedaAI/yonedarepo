// The Flight log's mark: a faint radar scope behind the home page's closing band and the `/updates`
// page, so the band and the page it leads to read as one place. Drawn, not an image: it takes its
// color from the site's theme and keeps one geometry at every width, cropped by its section. It
// says nothing a reader needs, so it is hidden from assistive tech.
// The second ring clears the widest text the scope sits behind, so no line runs through words.
const RINGS = [140, 280, 420, 560, 700, 840];
const BEARING_RING = 420;
const BEARINGS = Array.from({ length: 72 }, (_, i) => i * 5);
/** A few returns on the scope, as [bearing in degrees, range]. */
const RETURNS = [
  [70, 560],
  [112, 470],
  [250, 640],
  [292, 410],
];

const polar = (degrees: number, range: number) => {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return [range * Math.cos(radians), range * Math.sin(radians)].map((v) => v.toFixed(1));
};

export function SiteRadar() {
  return (
    <svg
      className="site-radar"
      viewBox="-900 -900 1800 1800"
      width="1800"
      height="1800"
      aria-hidden="true"
      focusable="false"
    >
      {RINGS.map((r) => (
        <circle key={r} r={r} />
      ))}
      <path d="M-840 0H-280M280 0H840M0-840V-280M0 280V840" />
      {BEARINGS.map((degrees) => {
        const [x1, y1] = polar(degrees, BEARING_RING);
        const [x2, y2] = polar(degrees, BEARING_RING + (degrees % 30 === 0 ? 14 : 7));
        return <line key={degrees} x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
      {RETURNS.map(([degrees, range]) => {
        const [cx, cy] = polar(degrees, range);
        return <circle key={degrees} className="site-radar-return" cx={cx} cy={cy} r="2.5" />;
      })}
    </svg>
  );
}
