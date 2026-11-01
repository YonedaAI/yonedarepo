// The change's instruments, above its gates: a card for each thing the last pushes can be read
// on, with its current value and a five-push trend, from one read
// (`GET /changes/:n/instruments`, from check evidence, so anyone who can read the change sees
// them). The server decides every value. A card with nothing real behind it isn't shown, and
// while there is nothing to show (loading, a failed read, no heads) neither is the block.
import { useEffect } from 'react';
import type {
  ChangeInstruments,
  HeadReading,
  RiskInput,
  RiskReading,
} from '../../../../shared/contracts/change-instruments';
import type { RunTile, RunValue } from '../../../../shared/managed-agents';
import { HistoryStrip } from '../agents/agentParts';
import { valueLabel } from '../agents/agentsModel';
import type { ChangeDetail } from './changeModel';
import { useSource } from './useSource';

const AGENT_CARDS = [
  { name: 'Slop', check: 'slop-review' },
  { name: 'Intent drift', check: 'intent-drift' },
];
const TREND = 5;

const INPUTS: Record<RiskInput, string> = {
  classes: 'Review classes',
  size: 'Size',
  sensitive: 'Sensitive paths',
  findings: 'Open findings',
};

/** Reads again when the score's input moves: a push, or a comment opened or resolved. */
export function instrumentsKey(change: Pick<ChangeDetail, 'head' | 'comments'>) {
  const open = change.comments.filter((c) => c.path !== null && c.resolved_at === null);
  return `${change.head}:${open.length}`;
}

const readingOf =
  (check: string) =>
  (head: HeadReading): RunValue | null =>
    head.checks.find((c) => c.name === check)?.value ?? null;

/** One head as a trend tile. */
const tile =
  (repo: string, number: number, value: (head: HeadReading) => RunValue | null) =>
  (head: HeadReading): RunTile => ({
    id: head.commit,
    repo,
    change: number,
    value: value(head),
    status: 'passed',
    created_at: head.at,
  });

function Card({
  name,
  value,
  history,
  children,
}: {
  name: string;
  value: string;
  history: RunTile[];
  children?: React.ReactNode;
}) {
  return (
    <div className="instrument-card">
      <h4>{name}</h4>
      <p className="instrument-value">{value}</p>
      <HistoryStrip history={history} slots={TREND} />
      <p className="source-meta">Last {TREND} pushes, latest on the right</p>
      {children}
    </div>
  );
}

function RiskReasons({ risk }: { risk: RiskReading }) {
  return (
    <>
      <ul className="instrument-reasons" aria-label={`Why: ${risk.score} points`}>
        {risk.reasons.map((r) => (
          <li key={r.input}>
            <strong>{INPUTS[r.input]}</strong> {r.why}{' '}
            <span className="instrument-points">+{r.points}</span>
          </li>
        ))}
      </ul>
      <p className="source-meta">
        Beta: worked out from these four inputs, with no model. Not calibrated yet. Only Land when
        cleared reads it: High holds.
      </p>
    </>
  );
}

export function Instruments({
  repo,
  number,
  reading = 0,
}: {
  repo: string;
  number: number;
  /** Goes up when a check may have reported: read again, keeping the cards on screen. */
  reading?: number;
}) {
  const { data, reload } = useSource<ChangeInstruments>(
    `/repos/${repo}/changes/${number}/instruments`,
  );
  useEffect(() => {
    if (reading) reload();
  }, [reading, reload]);
  const heads = data?.heads ?? [];
  const [head] = heads;
  const agents = AGENT_CARDS.filter(({ check }) => heads.some((h) => readingOf(check)(h) !== null));
  if (!head || (agents.length === 0 && !head.risk)) return null;
  const risk = head.risk;
  return (
    <section className="source-instruments" aria-labelledby="instruments-heading">
      <h3 id="instruments-heading">Instruments</h3>
      <div className="instrument-cards">
        {agents.map(({ name, check }) => {
          const value = readingOf(check);
          return (
            <Card
              key={check}
              name={name}
              value={value(head) ? valueLabel(value(head)) : 'Not reviewed yet'}
              history={heads.map(tile(repo, number, value))}
            />
          );
        })}
        {risk && (
          <Card
            name="Risk (beta)"
            value={valueLabel(risk.level)}
            history={heads.map(tile(repo, number, (h) => h.risk?.level ?? null))}
          >
            <RiskReasons risk={risk} />
          </Card>
        )}
      </div>
    </section>
  );
}
