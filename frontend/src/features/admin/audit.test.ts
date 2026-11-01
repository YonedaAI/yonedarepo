// The operator log as the server would render it: as it was with the switch off, and with it on
// the outcome column, an empty answer that tells a filter from a new log, and the row's details.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AuditEntry } from './adminModel';

const state: { page: unknown; loading: boolean; error?: string; paths: string[] } = {
  page: undefined,
  loading: false,
  paths: [],
};
vi.mock('../source-platform/useSource', () => ({
  useSource: (path: string) => {
    state.paths.push(path);
    return { data: state.page, loading: state.loading, error: state.error, reload: () => {} };
  },
}));

const { AdminAudit } = await import('./AdminAudit');
const { auditPath, NO_FILTERS, shownSections } = await import('./adminModel');

const entry: AuditEntry = {
  id: 1,
  at: Date.UTC(2026, 10, 1),
  actor: '_admin',
  action: 'repo.purge_now',
  target: 'r1',
  detail: { queued: true },
};
const render = () => renderToStaticMarkup(createElement(AdminAudit));

beforeEach(() => {
  state.page = undefined;
  state.loading = false;
  state.error = undefined;
  state.paths.length = 0;
});

it('reads as it did with the switch off', () => {
  state.page = { items: [entry], next: null };
  const html = render();
  expect(html).toContain('owner token');
  expect(html).toContain('queued: true');
  expect(html).not.toContain('Outcome');
  expect(html).not.toContain('aria-expanded');
});

it('opens a row by keyboard with the switch on, and names the outcome', () => {
  state.page = { items: [{ ...entry, outcome: 'queued' }], next: null, detailed: true };
  const html = render();
  expect(html).toContain('Queued');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('queued: true');
});

it('shows loading, failure and an empty log', () => {
  state.loading = true;
  expect(render()).toContain('Loading the audit log');
  state.loading = false;
  state.error = 'Nope';
  expect(render()).toContain('role="alert"');
  state.error = undefined;
  state.page = { items: [], next: null };
  expect(render()).toContain('No operator actions yet.');
});

it('puts the filters and the view on the address', () => {
  expect(auditPath({ ...NO_FILTERS, actor: 'al', outcome: 'failed', view: 'system' }, 9)).toBe(
    '/admin/audit?view=system&actor=al&outcome=failed&before=9',
  );
});

it('offers a tab only where it exists', () => {
  expect(shownSections()).not.toContain('operations');
  const none = { operations: false, visitors: false, agents: false };
  expect(shownSections({ ...none, operations: true })).toContain('infrastructure');
  expect(shownSections({ ...none, visitors: true })).toContain('visitors');
  expect(shownSections(none)).not.toContain('agents');
  expect(shownSections({ ...none, agents: true })).toContain('agents');
});
