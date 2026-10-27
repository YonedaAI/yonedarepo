import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { comparisonFixture } from '../../../../tests/frontend/comparisonFixture';
import { ExecutionFailure } from './ExecutionFailure';
import { ExecutionHierarchy } from './ExecutionHierarchy';
import { RecordedFailure } from './RecordedFailure';
import { platformFailureNotice } from './workflowFailure';

it('lists the failed builders and leaves out a historical reviewer execution', () => {
  const fixture = comparisonFixture();
  fixture.snapshot.executions = fixture.snapshot.executions.map((e) => ({
    ...e,
    status: 'failed',
  }));
  fixture.snapshot.executions.push({
    id: 'reviewer',
    run_id: fixture.run.id,
    role: 'reviewer',
    comparison_role: 'reviewer',
    status: 'running',
  });
  const html = renderToStaticMarkup(
    createElement(ExecutionHierarchy, {
      snapshot: fixture.snapshot,
      run: fixture.run,
      onInspect: () => {},
    }),
  );
  expect(html).toContain('2 agents');
  expect(html).toContain('0 running · 0 queued');
  expect(html.match(/<span class="status failed">/g)).toHaveLength(2);
  expect(html).not.toContain('reviewer');
});
it('does not blame a provider for an unclassified platform failure or display raw runtime error data', () => {
  const html = renderToStaticMarkup(
    createElement(ExecutionFailure, {
      repo: 'repo',
      execution: {
        provider: 'zai',
        status: 'failed',
        error: 'RUNTIME: {"internal":"PRIVATE_DIAGNOSTIC"}',
      },
      onProviders: () => {},
    }),
  );
  expect(html).toContain('Run failed');
  expect(html).not.toContain('ZAI execution failed');
  expect(html).not.toContain('PRIVATE_DIAGNOSTIC');
  expect(html).not.toContain('Review provider connections');
});

it('attributes a trusted capture failure to the platform without suggesting provider billing or credentials', () => {
  const execution = {
    provider: 'zai',
    status: 'failed',
    failure_stage: 'capture',
    failure_job_id: 'capture:builder',
    failure_job_epoch: 3,
    error: 'RUNTIME: private implementation detail',
    error_code: 'PROVIDER_AUTH',
    transcript: 'recorded-log',
  };
  const html = renderToStaticMarkup(
    createElement(ExecutionFailure, { repo: 'repo', execution, onProviders: () => {} }),
  );
  expect(html).toContain('Capture failed');
  expect(html).toContain('platform');
  expect(html).not.toContain('ZAI');
  expect(html).not.toContain('Review provider connections');
  expect(html).not.toContain('Explain failure');
  expect(html).not.toContain('private implementation detail');
});
it('keeps a supported provider denial attributed to the provider during agent work', () => {
  const html = renderToStaticMarkup(
    createElement(ExecutionFailure, {
      repo: 'repo',
      execution: {
        provider: 'zai',
        status: 'failed',
        failure_stage: 'agent',
        failure_job_id: 'job:builder',
        failure_job_epoch: 1,
        error_code: 'PROVIDER_AUTH',
      },
      onProviders: () => {},
    }),
  );
  expect(html).toContain('ZAI authentication failed');
  expect(html).toContain('Review provider connections');
});

it('keeps raw technical runtime data in a closed fold and attributes only trusted failed-job metadata', () => {
  const html = renderToStaticMarkup(
    createElement(RecordedFailure, {
      error: { code: 'RUNTIME', message: 'PRIVATE_DIAGNOSTIC', failure_stage: 'capture' },
      stage: 'capture',
      jobId: 'capture:builder',
      epoch: 3,
      provider: 'zai',
    }),
  );
  const main = html.replace(/<details>[\s\S]*?<\/details>/g, '');
  expect(main).toContain('Capture failed');
  expect(main).not.toContain('PRIVATE_DIAGNOSTIC');
  expect(main).not.toContain('RUNTIME');
  expect(html).toContain('<details><summary>Technical error details</summary>');
  expect(html).not.toContain('<details open');
  expect(
    platformFailureNotice({ status: 'failed', error: '{"failure_stage":"capture"}' }),
  ).toBeUndefined();
  expect(
    platformFailureNotice({
      status: 'running',
      failure_stage: 'capture',
      failure_job_id: 'capture:builder',
      failure_job_epoch: 3,
    }),
  ).toBeUndefined();
  expect(platformFailureNotice({ status: 'failed', failure_stage: 'capture' })).toBeUndefined();
});
