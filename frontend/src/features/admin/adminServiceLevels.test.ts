// The service levels section: what each state shows, in the reader's words, with no target.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  MEASURING_DAYS,
  type ServiceLevels,
  type ServiceRow,
} from '../../../../shared/service-levels';
import { failureShare, measuredLine, ServiceLevelsView } from './AdminServiceLevels';

const row = (operation: ServiceRow['operation'], over: Partial<ServiceRow> = {}): ServiceRow => ({
  operation,
  requests: 0,
  failed: 0,
  failure_rate: null,
  latency: null,
  estimated: false,
  ...over,
});
const quiet = () =>
  (['api_read', 'landing', 'git_clone', 'git_push', 'repo_create'] as const).map((o) => row(o));
const report = (over: Partial<ServiceLevels> = {}): ServiceLevels => ({
  days_measured: 12,
  people: quiet(),
  ours: quiet(),
  outside: [],
  ...over,
});
const render = (r: ServiceLevels, who: 'people' | 'ours' = 'people') =>
  renderToStaticMarkup(createElement(ServiceLevelsView, { report: r, who, onWho: () => {} }));

describe('service levels', () => {
  it('counts the days and never names a target', () => {
    expect(measuredLine(12)).toBe('Day 12 of 30. Targets follow 30 days of data.');
    expect(measuredLine(MEASURING_DAYS)).toBe('30 days of data. No targets are set yet.');
    expect(render(report())).toContain('Day 12 of 30');
    expect(render(report())).not.toMatch(/budget|99\.9|objective|SLO/i);
  });

  it('shows one line while nothing has been measured', () => {
    const page = render(report({ days_measured: 0 }));
    expect(page).toContain('No requests in the last 30 days.');
    expect(page).not.toContain('<table');
    expect(page).not.toContain('Day 0');
  });

  it('shows every operation once any has run, with a dash for what it lacks', () => {
    const people = quiet();
    people[1] = row('landing', {
      requests: 1234,
      failed: 2,
      failure_rate: 0.0016,
      latency: { p50: 80, p95: 1500, p99: 70_000 },
    });
    people[0] = row('api_read', { requests: 900, estimated: true });
    const page = render(report({ people }));
    expect(page).toContain('Landings');
    expect(page).toContain('Git clone, until the pack starts');
    expect(page).toContain('1,234');
    expect(page).toContain('≈900');
    expect(page).toContain('0.16%');
    for (const time of ['80 ms', '1.5 s', '1.2 min']) expect(page).toContain(time);
    expect(page).toContain('—');
  });

  it('keeps our tools apart', () => {
    const ours = quiet();
    ours[3] = row('git_push', { requests: 77 });
    expect(render(report({ ours }), 'ours')).toContain('77');
    expect(render(report({ ours }), 'people')).toContain('No requests in the last 30 days.');
  });

  it('shows the checks from outside only once they have run', () => {
    expect(render(report())).not.toContain('From outside');
    const outside = [
      { check: 'clone', runs: 288, failed: 1, latency: { p50: 400, p95: 900 } },
      { check: 'new', runs: 1, failed: 0, latency: null },
    ];
    const page = render(report({ outside }));
    expect(page).toContain('Whole clone of a small repository');
    expect(page).toContain('Other check');
  });

  it('keeps the digits of a small failure rate', () => {
    expect(failureShare(null)).toBe('—');
    expect(failureShare(0)).toBe('0%');
    expect(failureShare(0.00012)).toBe('0.01%');
    expect(failureShare(0.25)).toBe('25%');
  });
});
