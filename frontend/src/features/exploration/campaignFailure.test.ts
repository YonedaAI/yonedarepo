import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExecutionFailure } from './ExecutionFailure';
import {
  executionFailureCode,
  providerFailureNotice,
  transcriptFailureCode,
} from './providerFailure';

const codes = ['CAMPAIGN_MODEL_REQUEST_LIMIT', 'CAMPAIGN_EXHAUSTED'] as const;
const transcript = (result: unknown) => JSON.stringify({ stdout: JSON.stringify(result) });
describe('campaign allowance failure explanations', () => {
  it('recognizes explicit campaign failures without treating them as provider billing problems', () => {
    for (const code of codes) {
      expect(executionFailureCode({ error_code: code })).toBe(code);
      expect(executionFailureCode({ error: `${code}: The next request was refused` })).toBe(code);
    }
  });
  it('explains approved-roster recovery without promising an automatic cap increase', () => {
    const code = executionFailureCode({ error_code: 'CAMPAIGN_MODEL_REQUEST_LIMIT' });
    const notice = providerFailureNotice({ provider: 'zai' }, code);
    expect(notice.title).toContain('shared campaign request allowance');
    expect(notice.action).toContain('already-approved model');
    expect(notice.action).toContain('allowance available');
    expect(notice.action).toContain('do not increase automatically');
    expect(notice.action).not.toMatch(/add credits|larger allowance|raise the approved/i);
  });
  it('requires an owner budget decision when campaign allowance cannot cover another request', () => {
    const code = executionFailureCode({ error_code: 'CAMPAIGN_EXHAUSTED' });
    const notice = providerFailureNotice({ provider: 'zai' }, code);
    expect(notice.title).toContain('campaign allowance');
    expect(notice.action).toContain('owner decision');
    expect(notice.action).toContain('does not reset or automatically increase');
    expect(notice.action).not.toMatch(/add credits|another provider|remaining work/i);
  });
  it('recognizes exact terminal campaign denials in both structured and plain broker outcomes', () => {
    for (const code of codes) {
      const result = {
        type: 'result',
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: 409,
      };
      for (const error of [
        { error: { code } },
        `API Error: 409 ${JSON.stringify({ error: { code } })}`,
      ])
        expect(transcriptFailureCode(transcript({ ...result, result: error }))).toBe(code);
    }
    for (const [message, code] of [
      [
        'This model exhausted its original shared campaign request allowance',
        'CAMPAIGN_MODEL_REQUEST_LIMIT',
      ],
      ['Campaign, bucket, chain or model allowance exhausted', 'CAMPAIGN_EXHAUSTED'],
    ])
      expect(
        transcriptFailureCode(
          transcript({
            type: 'result',
            is_error: true,
            terminal_reason: 'api_error',
            api_error_status: 409,
            result: `API Error: 409 ${message}`,
          }),
        ),
      ).toBe(code);
  });
  it('does not diagnose a limit from incidental conversation or a successful final outcome', () => {
    expect(
      transcriptFailureCode(transcript({ type: 'assistant', text: 'CAMPAIGN_EXHAUSTED' })),
    ).toBeUndefined();
    expect(
      transcriptFailureCode(
        transcript({ type: 'result', is_error: false, result: 'CAMPAIGN_EXHAUSTED' }),
      ),
    ).toBeUndefined();
    expect(
      executionFailureCode({ error: 'Agent said CAMPAIGN_EXHAUSTED may happen' }),
    ).toBeUndefined();
  });
  it('renders the campaign explanation in existing failure UI without provider-credential recovery controls', () => {
    for (const code of codes) {
      const html = renderToStaticMarkup(
        createElement(ExecutionFailure, {
          repo: 'repo',
          execution: { provider: 'zai', error_code: code },
          onProviders: () => {},
        }),
      );
      expect(html).toContain('campaign');
      expect(html).toContain(
        code === 'CAMPAIGN_EXHAUSTED' ? 'owner decision' : 'already-approved model',
      );
      expect(html).not.toContain('Review provider connections');
      expect(html).not.toContain('No harness transcript was recorded');
    }
  });
});
