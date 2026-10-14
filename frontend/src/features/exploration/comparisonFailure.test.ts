import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { comparisonFixture } from '../../../../tests/frontend/comparisonFixture';
import { ComparisonAssessment } from './ComparisonAssessment';
import { ComparisonResults } from './ComparisonResults';
import { ComparisonWorkflow } from './ComparisonWorkflow';
import { ExecutionFailure } from './ExecutionFailure';
import { ExecutionHierarchy } from './ExecutionHierarchy';
import { RecordedFailure } from './RecordedFailure';
import { platformFailureNotice } from './workflowFailure';

it('counts an actual historical running reviewer separately from both failed builders', () => {
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
      run: { ...fixture.run, comparison: fixture.comparison },
      onInspect: () => {},
    }),
  );
  expect(html).toContain('2 builders · 1 reviewer');
  expect(html).toContain('1 reviewer running');
  expect(html).toContain('0 builders running');
  expect(html).not.toContain('1 reviewers');
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

it('shows the native zero-checked skip in results and workflow without inventing a review or winner', () => {
  const fixture = comparisonFixture();
  fixture.snapshot.candidates = [];
  fixture.snapshot.executions = fixture.snapshot.executions.map((e) => ({
    ...e,
    status: 'failed',
  }));
  const run = {
    ...fixture.run,
    status: 'failed',
    comparison: {
      ...fixture.comparison,
      status: 'needs_attention',
      selected_candidate_id: null,
      latest_review: null,
      latest_review_id: null,
      reviewer_status: 'skipped',
      review_skip_reason: {
        code: 'NO_CHECKED_RESULTS',
        authority: 'platform',
        message: 'Untrusted detail is not product copy',
      },
    },
  };
  const html = renderToStaticMarkup(
    createElement(ComparisonResults, {
      snapshot: fixture.snapshot,
      run,
      busy: false,
      onPublish: () => {},
      onAction: async () => true,
      onContext: () => {},
      onGraph: () => {},
    }),
  );
  expect(html).toContain('Review skipped — no checked results');
  expect(html).not.toContain('Automatic review stopped');
  expect(html).not.toContain('Selected output');
  expect(html).not.toContain('Untrusted detail');
  const workflow = renderToStaticMarkup(
    createElement(ComparisonWorkflow, { snapshot: fixture.snapshot, run }),
  );
  expect(workflow).toContain('Review skipped — no checked results');
  expect(workflow).not.toContain('Awaiting recorded review');
});
it('does not infer review skip from missing candidates, pending checks or an agent-authored reason', () => {
  const fixture = comparisonFixture();
  const base = {
    ...fixture.comparison,
    latest_review: null,
    latest_review_id: null,
    selected_candidate_id: null,
  };
  for (const comparison of [
    base,
    {
      ...base,
      reviewer_status: 'skipped',
      review_skip_reason: { code: 'NO_CHECKED_RESULTS', authority: 'agent' },
    },
    {
      ...base,
      reviewer_status: 'running',
      review_skip_reason: { code: 'NO_CHECKED_RESULTS', authority: 'platform' },
    },
  ]) {
    const html = renderToStaticMarkup(createElement(ComparisonAssessment, { comparison }));
    expect(html).not.toContain('Review skipped');
    expect(html).toContain('No automatic review is recorded');
  }
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
it('preserves earlier reviewer and owner reasons as history when the platform later skips review', () => {
  const fixture = comparisonFixture();
  const comparison = {
    ...fixture.comparison,
    reviewer_status: 'skipped',
    review_skip_reason: { code: 'NO_CHECKED_RESULTS', authority: 'platform' },
    selected_by: 'owner' as const,
    selection_reason: 'Earlier owner rationale.',
  };
  const html = renderToStaticMarkup(createElement(ComparisonAssessment, { comparison }));
  expect(html).toContain('Earlier reviewer assessment');
  expect(html).toContain(fixture.comparison.latest_review?.rationale);
  expect(html).toContain('Earlier owner rationale.');
});
it('presents verification-only recovered checks as human choices, preserving earlier review history without a failed-run claim', () => {
  const fixture = comparisonFixture();
  const comparison = {
    ...fixture.comparison,
    status: 'needs_attention' as const,
    selected_candidate_id: null,
    reviewer_status: 'skipped',
    review_skip_reason: { code: 'CAPTURE_RECOVERY_CHECK_ONLY', authority: 'platform' },
    verification_recovery: {
      version: 1 as const,
      automatic_review: false as const,
      request_id: 'recovery',
      authority: 'owner_verification_recovery' as const,
    },
  };
  const run = { ...fixture.run, status: 'ready', comparison };
  const html = renderToStaticMarkup(
    createElement(ComparisonResults, {
      snapshot: fixture.snapshot,
      run,
      busy: false,
      onPublish: () => {},
      onAction: async () => true,
      onContext: () => {},
      onGraph: () => {},
    }),
  );
  expect(html).toContain('Review skipped — capture verification only');
  expect(html).toContain('Earlier reviewer assessment');
  expect(html).not.toContain('No checked result is eligible');
  expect(html).not.toContain('Automatic review stopped');
  expect(html).not.toContain('Selected output');
  expect(html.match(/Use this result<\/button>/g)).toHaveLength(2);
});
