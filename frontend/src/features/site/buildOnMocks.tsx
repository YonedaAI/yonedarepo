// The hero visual and the tour's own mocks: the transaction log, the network, a lazy clone,
// check runs, the review agents' report, and session and context views with neutral sample
// names (the home page names no other product).
import {
  Bot,
  Check,
  CircleCheck,
  CircleDashed,
  FileDown,
  ScrollText,
  TriangleAlert,
} from 'lucide-react';
import { MANAGED_AGENTS } from '../../../../shared/managed-agents';
import { Terminal } from './features';

const agentName = (id: string) => MANAGED_AGENTS.find((a) => a.id === id)?.defaults.name ?? id;

const LOG: [version: number, writer: string, path: string][] = [
  [212, 'writer-07', 'src/retry.ts'],
  [213, 'writer-31', 'docs/limits.md'],
  [214, 'writer-12', 'src/backoff.ts'],
  [215, 'writer-48', 'test/retry.test.ts'],
];

export const logMock = (
  <figure className="site-mock site-panel" aria-label="Landings appended to the log in order">
    <p className="mock-title">
      main <span>log version 215</span>
    </p>
    <ol className="mock-log">
      {LOG.map(([version, writer, path]) => (
        <li key={version}>
          <code>v{version}</code>
          <strong>{writer}</strong>
          <span>{path}</span>
          <Check className="mock-ok" size={15} aria-label="landed" />
        </li>
      ))}
    </ol>
  </figure>
);

export const reviewMock = (
  <figure className="site-mock site-panel" aria-label="Review agents reporting on a change">
    <p className="mock-title">
      <Bot size={16} aria-hidden="true" /> #12 Retry on 503 <span>retry → main</span>
    </p>
    <ul className="mock-rows">
      <li>
        <strong>
          <TriangleAlert className="mock-warn" size={15} aria-hidden="true" />{' '}
          {agentName('security-review')} · medium
        </strong>
        <span>
          <code>src/retry.ts:22</code> logs the request’s auth header when a retry fails.
        </span>
      </li>
      <li>
        <strong>{agentName('slop-review')} · low</strong>
        <span>
          <code>src/retry.ts:40</code> leftover <code>console.debug</code>.
        </span>
      </li>
    </ul>
    <ul className="mock-gates mock-checks">
      <li>
        <CircleCheck size={15} aria-hidden="true" /> check <code>code-review</code> passed
      </li>
      <li>
        <TriangleAlert className="mock-warn" size={15} aria-hidden="true" /> check{' '}
        <code>security-review</code> medium
      </li>
    </ul>
  </figure>
);

const sessionsMock = (
  <figure className="site-mock site-panel" aria-label="Sessions recorded on a repository">
    <ul className="mock-rows">
      <li>
        <strong>Add retry helper</strong>
        <span>session 7f2c · 9d1e0a7 · 3 declared reads</span>
      </li>
      <li>
        <strong>Document backoff limits</strong>
        <span>session 41ab · 2c5f9e1 · 2 declared reads</span>
      </li>
      <li className="mock-transcript">
        <ScrollText size={15} aria-hidden="true" /> Transcript: 38 turns, 1 redacted
      </li>
    </ul>
  </figure>
);

const contextMock = (
  <Terminal
    label="The context a new coding session starts with"
    lines={[
      ['in', 'yoneda context'],
      ['out', '# YonedaRepo context for this clone'],
      ['out', 'main at 4be81c2 (log version 215).'],
      ['out', '## Landing rules'],
      ['out', '- approvals required: 1; required checks: test'],
      ['out', '## Recent sessions (newest first)'],
      ['out', '- 2h ago · 9d1e0a7 "Add retry helper": …'],
    ]}
  />
);

// Points on an abstract globe (our own shapes: no map, no regions), each linked to its
// neighbours.
const NODES: [x: number, y: number][] = [
  [70, 62],
  [112, 40],
  [150, 76],
  [196, 46],
  [236, 84],
  [96, 112],
  [176, 118],
  [252, 128],
];
const LINKS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 2],
  [2, 6],
  [6, 4],
  [4, 7],
  [6, 7],
];

export const globalMock = (
  <figure className="site-mock site-panel" aria-label="One network of connected points">
    <svg className="mock-globe" viewBox="0 0 320 170" aria-hidden="true">
      <ellipse cx="160" cy="85" rx="140" ry="76" />
      <ellipse cx="160" cy="85" rx="70" ry="76" />
      <line x1="20" y1="85" x2="300" y2="85" />
      <line x1="160" y1="9" x2="160" y2="161" />
      {LINKS.map(([a, b]) => (
        <line
          key={`${a}-${b}`}
          className="mock-globe-link"
          x1={NODES[a][0]}
          y1={NODES[a][1]}
          x2={NODES[b][0]}
          y2={NODES[b][1]}
        />
      ))}
      {NODES.map(([x, y]) => (
        <circle key={`${x}-${y}`} className="mock-globe-node" cx={x} cy={y} r="5" />
      ))}
    </svg>
    <p className="mock-caption">
      <code>api.yonedarepo.com</code> · one address, no region setting
    </p>
  </figure>
);

export const fetchMock = (
  <figure className="site-mock site-panel" aria-label="A clone that loads files on first use">
    <p className="mock-title">
      demo <span>main · commits and trees</span>
    </p>
    <ul className="mock-rows mock-files">
      <li>
        <code>src/retry.ts</code>
        <span>
          <Check className="mock-ok" size={15} aria-hidden="true" /> loaded
        </span>
      </li>
      <li>
        <code>docs/limits.md</code>
        <span>
          <FileDown size={15} aria-hidden="true" /> on first read
        </span>
      </li>
      <li>
        <code>assets/demo.mp4</code>
        <span>
          <FileDown size={15} aria-hidden="true" /> on first read
        </span>
      </li>
    </ul>
  </figure>
);

const RUNS: [commit: string, title: string, done: boolean][] = [
  ['9d1e0a7', 'Add retry helper', true],
  ['2c5f9e1', 'Document backoff limits', true],
  ['4be81c2', 'Tune retry limits', false],
];

export const ciMock = (
  <figure className="site-mock site-panel" aria-label="Checks running on each pushed commit">
    <p className="mock-title">
      check <code>test</code> <span>required on main</span>
    </p>
    <ul className="mock-rows mock-files">
      {RUNS.map(([commit, title, done]) => (
        <li key={commit}>
          <strong>
            <code>{commit}</code> {title}
          </strong>
          <span>
            {done ? (
              <CircleCheck className="mock-ok" size={15} aria-hidden="true" />
            ) : (
              <CircleDashed size={15} aria-hidden="true" />
            )}{' '}
            {done ? 'passed' : 'running'}
          </span>
        </li>
      ))}
    </ul>
  </figure>
);

export const memoryMock = (
  <div className="mock-stack">
    {sessionsMock}
    {contextMock}
  </div>
);

/** The hero's visual: three writers push to main at once and each one lands. */
export const heroMock = (
  <Terminal
    label="Three writers push to main at once, and each push lands"
    lines={[
      ['in', 'git push origin main   # writer-07'],
      ['out', 'remote: main: landed with server merge, run git pull'],
      ['in', 'git push origin main   # writer-31'],
      ['out', 'remote: main: landed with server merge, run git pull'],
      ['in', 'git push origin main   # writer-12'],
      ['out', 'remote: main: landed with server merge, run git pull'],
    ]}
  />
);
