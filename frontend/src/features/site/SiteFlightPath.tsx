// The home page's picture of a Flight Path: one example Landing drawn as an instrument approach
// chart, with its route down to `main`, its instruments and its clearance strip. An example of
// the idea, labelled as one; every word a reader needs is real text beside the drawings.
import { Check } from 'lucide-react';
import { FlightInstruments } from './FlightInstruments';
import { TallRoute, WideRoute } from './FlightRoute';
import { AHEAD, APPROVAL, BLACK_BOX, CHECKS, FIXES, LANDING } from './flightPath';

function FixList() {
  return (
    <ol className="fp-fixes">
      {FIXES.map((fix) => (
        <li key={fix.id} className={fix.id === 'go-around' ? 'fp-go-around' : undefined}>
          <p className="fp-fix-name">{fix.name}</p>
          <p className="fp-fix-detail">{fix.detail}</p>
        </li>
      ))}
    </ol>
  );
}

function ClearanceStrip() {
  return (
    <div className="fp-clearance">
      <h3>Clearance</h3>
      <div className="fp-strip">
        <p className="fp-strip-id">
          <span className="sr-only">Landing 42</span>
          <span aria-hidden="true">L42</span>
        </p>
        <div className="fp-strip-checks">
          <p className="fp-strip-label">Checks</p>
          <ul>
            {CHECKS.map((check) => (
              <li key={check}>
                <Check size={14} aria-hidden="true" />
                {check}
              </li>
            ))}
          </ul>
        </div>
        <div className="fp-strip-approval">
          <p className="fp-strip-label">Approvals</p>
          <p>
            <Check size={14} aria-hidden="true" />
            {APPROVAL}
          </p>
        </div>
        <div className="fp-strip-line">
          <p className="fp-strip-label">In line</p>
          <p>{AHEAD}</p>
        </div>
        <p className="fp-strip-cleared">Cleared to land</p>
      </div>
    </div>
  );
}

export function SiteFlightPath() {
  return (
    <section className="site-band site-flight" aria-labelledby="flight-heading">
      <div className="site-flight-head">
        <h2 id="flight-heading">One change, one Flight Path</h2>
        <p>See what the agent set out to do, what it did and why it can land.</p>
      </div>
      <figure className="fp-chart">
        <figcaption className="fp-title">
          <span>{LANDING}</span>
          <span className="site-badge">Example</span>
        </figcaption>
        <div className="fp-stage">
          <div className="fp-profile">
            <WideRoute />
            <span className="fp-runway-name" aria-hidden="true">
              main
            </span>
          </div>
          <TallRoute />
          <FixList />
        </div>
        <div className="fp-instruments">
          <h3>Instruments</h3>
          <FlightInstruments />
        </div>
        <ClearanceStrip />
        <p className="fp-black-box">{BLACK_BOX}</p>
      </figure>
    </section>
  );
}
