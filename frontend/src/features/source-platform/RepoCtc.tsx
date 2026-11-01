// CTC, Code Traffic Control: every open Landing with its state, what it waits for, its place in
// line, the other Landings on the same work and the last decision on it. The page reads what
// the server decided and asks again while it is on screen; a poll that fails keeps the last
// answer up and says so.
import { useEffect, useRef } from 'react';
import { EmptyState } from '../../components/EmptyState';
import type { CtcRadar, RadarLanding } from '../../../../shared/contracts/ctc-radar';
import {
  CTC_POLL_MS,
  ctcPath,
  lastLine,
  overlapLine,
  placeLine,
  stateLabel,
  visibleEvery,
} from './ctcModel';
import { Person } from './Person';
import { Failure, Loading } from './SourceStatus';
import { when } from './sourceApi';
import { useSource } from './useSource';

type Links = { hrefOf: (n: number) => string; onOpen: (n: number) => void };

function LandingLink({
  number,
  hrefOf,
  onOpen,
  children,
}: Links & { number: number; children: React.ReactNode }) {
  return (
    <a
      href={hrefOf(number)}
      onClick={(e) => {
        e.preventDefault();
        onOpen(number);
      }}
    >
      {children}
    </a>
  );
}

function Row({ landing: l, ...links }: Links & { landing: RadarLanding }) {
  return (
    <tr>
      <td data-label="In line">{placeLine(l.place)}</td>
      <th scope="row" data-label="Landing">
        <LandingLink number={l.number} {...links}>
          <strong>{l.title}</strong> <span className="source-meta">#{l.number}</span>
        </LandingLink>
        <span className="source-meta ctc-branch">
          <code>{l.branch}</code> → {l.base} · <Person principal={l.author} />
        </span>
      </th>
      <td data-label="State">
        <span className={`source-change-status ctc-state ctc-${l.decision ?? 'none'}`}>
          {stateLabel(l.decision)}
        </span>
      </td>
      <td data-label="Waiting for">
        {l.reasons.length === 0 ? (
          <span className="source-meta">Nothing</span>
        ) : (
          <ul className="ctc-list">
            {l.reasons.map((reason) => (
              <li key={`${reason.code}:${reason.reason}`}>{reason.reason}</li>
            ))}
          </ul>
        )}
      </td>
      <td data-label="Overlaps">
        {l.overlaps.length === 0 ? (
          <span className="source-meta">None</span>
        ) : (
          <ul className="ctc-list">
            {l.overlaps.map((overlap) => (
              <li key={overlap.landing}>
                <LandingLink number={overlap.landing} {...links}>
                  #{overlap.landing}
                </LandingLink>{' '}
                {overlapLine(overlap)}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td data-label="Last decision">
        {l.last ? (
          <>
            {lastLine(l.last)} <span className="source-meta">{when(l.last.at)}</span>
          </>
        ) : (
          <span className="source-meta">None yet</span>
        )}
      </td>
    </tr>
  );
}

export function RepoCtc({ repo, ...links }: Links & { repo: string }) {
  const radar = useSource<CtcRadar>(ctcPath(repo));
  const { reload } = radar;
  useEffect(() => {
    return visibleEvery(CTC_POLL_MS, reload);
  }, [reload]);
  const kept = useRef<CtcRadar | undefined>(undefined);
  if (radar.data) kept.current = radar.data;
  const data = radar.data ?? kept.current;
  const head = (
    <div className="source-changes-head">
      <h2 id="ctc-heading">CTC</h2>
      <button type="button" className="quiet" onClick={reload}>
        Refresh
      </button>
    </div>
  );
  return (
    <section aria-labelledby="ctc-heading" className="ctc" aria-busy={radar.loading}>
      {head}
      {data?.landings.length !== 0 && (
        <p className="source-meta">
          Code Traffic Control: what is cleared, what it waits for and where Landings meet.
        </p>
      )}
      {!data && radar.error && <Failure error={radar.error} onRetry={reload} />}
      {!data && !radar.error && <Loading what="CTC radar" />}
      {data && radar.error && (
        <p role="status" className="source-error">
          Could not refresh: this is the last answer.
        </p>
      )}
      {data && !data.land_when_cleared && data.landings.length > 0 && (
        <p className="source-meta">
          Land when cleared is off, so nothing lands on its own: this is what CTC would say.
        </p>
      )}
      {data?.landings.length === 0 && (
        <EmptyState title="No open Landings">
          Each one shows here with what it's waiting for and where it meets another.
        </EmptyState>
      )}
      {data && data.landings.length > 0 && (
        <div className="source-table-wrap">
          <table className="source-table ctc-table">
            <caption className="sr-only">Open Landings, first in line first</caption>
            <thead>
              <tr>
                <th scope="col">In line</th>
                <th scope="col">Landing</th>
                <th scope="col">State</th>
                <th scope="col">Waiting for</th>
                <th scope="col">Overlaps</th>
                <th scope="col">Last decision</th>
              </tr>
            </thead>
            <tbody>
              {data.landings.map((landing) => (
                <Row key={landing.number} landing={landing} {...links} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.truncated && (
        <p className="source-meta">Showing those in line and the newest open Landings.</p>
      )}
    </section>
  );
}
