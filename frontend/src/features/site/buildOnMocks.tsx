// The tour's own mocks: the transaction log, the review agents' report, and session and
// context views with neutral sample names (the home page names no other product).
import { Bot, Check, CircleCheck, ScrollText, TriangleAlert } from 'lucide-react';
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

export const sessionsMock = (
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

export const contextMock = (
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
