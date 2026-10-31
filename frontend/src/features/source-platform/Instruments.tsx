// The change's instruments, above its gates: a card for each thing the last pushes can be read
// on, with its current value and a five-push trend, from one read
// (`GET /changes/:n/instruments`, from check evidence, so anyone who can read the change sees
// them). The server decides every value. A card with nothing real behind it isn't shown, and
// while there is nothing to show (loading, a failed read, no heads) neither is the block.
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

const SLOP_CHECK = 'slop-review';
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

const slopOf = (head: HeadReading): RunValue | null =>
  head.checks.find((c) => c.name === SLOP_CHECK)?.value ?? null;

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
        Beta: worked out from these four inputs, with no model. Not calibrated yet. Does not affect
        landing.
      </p>
    </>
  );
}

export function Instruments({ repo, number }: { repo: string; number: number }) {
  const { data } = useSource<ChangeInstruments>(`/repos/${repo}/changes/${number}/instruments`);
  const heads = data?.heads ?? [];
  const [head] = heads;
  const slop = heads.some((h) => slopOf(h) !== null);
  if (!head || (!slop && !head.risk)) return null;
  const risk = head.risk;
  return (
    <section className="source-instruments" aria-labelledby="instruments-heading">
      <h3 id="instruments-heading">Instruments</h3>
      <div className="instrument-cards">
        {slop && (
          <Card
            name="Slop"
            value={slopOf(head) ? valueLabel(slopOf(head)) : 'Not reviewed yet'}
            history={heads.map(tile(repo, number, slopOf))}
          />
        )}
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
