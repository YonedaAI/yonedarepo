import { expect, it } from 'vitest';
import { executionFailureCode, transcriptFailureCode } from '../../frontend/src/features/exploration/providerFailure';

it('recognizes the recorded execution timeout without blaming provider credentials', () => {
  expect(executionFailureCode({ error: 'Execution deadline exceeded' })).toBe('EXECUTION_TIMEOUT');
  expect(executionFailureCode({ error: 'EXECUTION_TIMEOUT: Execution deadline exceeded' })).toBe('EXECUTION_TIMEOUT');
  expect(executionFailureCode({ error: 'User mentioned Execution deadline exceeded' })).toBeUndefined();
});

const requestMessage = 'This provider/model group exhausted its approved request budget';
const spendMessage = 'This provider/model group has insufficient approved spend remaining for the conservative request ceiling';
function transcript(result: unknown, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    exit: 1,
    stderr: '',
    stdout: JSON.stringify({
      type: 'result', is_error: true, terminal_reason: 'api_error', api_error_status: 409,
      result, ...overrides,
    }),
  });
}

it('explains the exact SDK-stripped terminal request and spend budget errors', () => {
  expect(transcriptFailureCode(transcript(`API Error: 409 ${requestMessage}`))).toBe('MODEL_REQUEST_LIMIT');
  expect(transcriptFailureCode(transcript(`API Error: 409 ${spendMessage}`))).toBe('MODEL_SPEND_LIMIT');
});

it('identifies legacy Token Plan configuration errors without exposing transcript text', () => {
  const message = 'API Error: 409 This is a Token Plan key. Select Token Plan and its region.';
  expect(transcriptFailureCode(transcript(message))).toBe('PROVIDER_CONFIGURATION');
  expect(transcriptFailureCode(transcript(`${message} private detail`))).toBeUndefined();
});

it('accepts allowlisted JSON budget codes while discarding arbitrary provider messages', () => {
  const result = `API Error: 409 ${JSON.stringify({ error: { code: 'MODEL_SPEND_LIMIT', message: '<script>private provider detail</script>' } })}`;
  expect(transcriptFailureCode(transcript(result))).toBe('MODEL_SPEND_LIMIT');
  expect(transcriptFailureCode(transcript('API Error: 409 {"error":{"code":"PROVIDER_BALANCE"}}'))).toBeUndefined();
});

it('does not infer a budget failure from arbitrary, nonterminal or successful content', () => {
  expect(transcriptFailureCode(transcript(`API Error: 409 ${requestMessage} arbitrary suffix`))).toBeUndefined();
  expect(transcriptFailureCode(transcript(`User said: API Error: 409 ${requestMessage}`))).toBeUndefined();
  expect(transcriptFailureCode(transcript(`API Error: 409 ${requestMessage}`, { type: 'assistant' }))).toBeUndefined();
  expect(transcriptFailureCode(transcript(`API Error: 409 ${requestMessage}`, { is_error: false }))).toBeUndefined();
  expect(transcriptFailureCode(transcript(`API Error: 409 ${requestMessage}`, { terminal_reason: 'completed' }))).toBeUndefined();
  expect(transcriptFailureCode(JSON.stringify({ stdout: `${JSON.stringify({ type: 'result', is_error: true, terminal_reason: 'api_error', api_error_status: 409, result: `API Error: 409 ${requestMessage}` })}\n${JSON.stringify({ type: 'result', is_error: false })}` }))).toBeUndefined();
});
